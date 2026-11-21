"""Ask (Foundry): the same conversation as Ask (GHCP), answered by a model deployed in Microsoft Foundry.

The Copilot path (server.py with the Copilot SDK) runs the tool loop inside the Copilot runtime. Here this module runs
it: it streams a response from the Foundry Responses API, and when the model calls a tool it sends the same
page_request the Copilot path sends, waits for the page's answer, and continues the response with the tool output.
The page sees the same NDJSON events either way (delta, message, reasoning, tool_draft, tool, tool_done, page_request,
error, done), so the cards, the trace and the saved chats work unchanged.

Settings (environment):
  FOUNDRY_ENDPOINT  the Azure OpenAI / AI Services endpoint, e.g. https://<resource>.openai.azure.com
  FOUNDRY_MODELS    comma-separated deployment names offered in the picker; the first is the default
  FOUNDRY_EFFORT    default reasoning effort (low, medium, high; default high)
  FOUNDRY_REASONING_SUMMARY  auto (default) to stream the model's reasoning summary into the trace, or off
Auth is Entra ID (DefaultAzureCredential: the Azure CLI sign-in locally, the Container App's managed identity in the
relay); the identity needs the Cognitive Services OpenAI User role on the resource. No keys.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

import httpx

import rules
import tools

ENDPOINT = os.environ.get("FOUNDRY_ENDPOINT", "").rstrip("/")
MODELS = [m.strip() for m in os.environ.get("FOUNDRY_MODELS", "gpt-5.5").split(",") if m.strip()]
DEFAULT_EFFORT = os.environ.get("FOUNDRY_EFFORT", "high")
EFFORTS = ["low", "medium", "high"]
SUMMARY = os.environ.get("FOUNDRY_REASONING_SUMMARY", "auto")
MAX_ROUNDS = 40            # model responses per question (each may call several tools)
SCOPE = "https://cognitiveservices.azure.com/.default"

TOOL_SPECS = [{"type": "function", "name": t["name"], "description": t["description"], "parameters": t["parameters"]}
              for t in tools.TOOLS]


def enabled() -> bool:
    return bool(ENDPOINT and MODELS)


def models() -> dict:
    return {"models": [{"id": m, "name": f"{m} (Foundry)", "efforts": EFFORTS, "default_effort": DEFAULT_EFFORT}
                       for m in MODELS],
            "default": MODELS[0] if MODELS else None, "default_effort": DEFAULT_EFFORT}


# --- Entra token, cached --------------------------------------------------------------------------------------------
_cred = None
_token: tuple[str, float] = ("", 0.0)
_token_lock = asyncio.Lock()


async def token() -> str:
    global _cred, _token
    async with _token_lock:
        if _token[1] - 300 > time.time():
            return _token[0]
        if _cred is None:
            # The Azure CLI sign-in locally (az is slow to start on Windows: allow 60 s), the managed identity in the
            # relay. Interactive and cache-based credentials are left out so a server never waits on a prompt.
            from azure.identity import AzureCliCredential, ChainedTokenCredential, ManagedIdentityCredential  # noqa: PLC0415
            _cred = ChainedTokenCredential(AzureCliCredential(process_timeout=60), ManagedIdentityCredential())
        t = await asyncio.to_thread(_cred.get_token, SCOPE)
        _token = (t.token, float(t.expires_on))
        return t.token


# --- one question ---------------------------------------------------------------------------------------------------
async def _stream(body: dict):
    """Yields the Responses API's server-sent events as dicts."""
    headers = {"Authorization": f"Bearer {await token()}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=30)) as http:
        async with http.stream("POST", f"{ENDPOINT}/openai/v1/responses", headers=headers, json=body) as r:
            if r.status_code != 200:
                text = (await r.aread()).decode(errors="replace")
                raise FoundryError(f"Foundry answered {r.status_code}: {text[:500]}", r.status_code, text)
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data and data != "[DONE]":
                        yield json.loads(data)


class FoundryError(Exception):
    def __init__(self, message: str, status: int = 0, body: str = ""):
        super().__init__(message)
        self.status, self.body = status, body


async def run_turn(chat, prompt: str, run_tool) -> None:
    """Answers one question in `chat` (server.Chat with backend 'foundry'), emitting the page's events.
    run_tool(chat, call_id, name, args) -> (ok, text_for_model) runs one tool in the page."""
    summary = SUMMARY != "off"
    pending_input: list = [{"role": "user", "content": prompt}]
    for _round in range(MAX_ROUNDS):
        body = {"model": chat.model, "instructions": rules.instructions(chat.surface), "input": pending_input,
                "tools": TOOL_SPECS, "stream": True, "store": True, "parallel_tool_calls": True}
        if chat.effort:
            body["reasoning"] = {"effort": chat.effort, **({"summary": "auto"} if summary else {})}
        if chat.prev:
            body["previous_response_id"] = chat.prev
        calls: list[dict] = []
        drafts: dict[str, dict] = {}
        texts: dict[str, str] = {}
        reasons: dict[str, str] = {}
        try:
            async for ev in _stream(body):
                kind = ev.get("type", "")
                now = time.monotonic()
                if now - chat.last_ping >= 1.0:
                    chat.last_ping = now
                    chat.emit({"type": "thinking"})
                if kind == "response.created":
                    chat.prev = ev["response"]["id"]
                elif kind == "response.output_text.delta":
                    texts[ev["item_id"]] = texts.get(ev["item_id"], "") + ev.get("delta", "")
                    chat.emit({"type": "delta", "id": ev["item_id"], "text": ev.get("delta", "")})
                elif kind == "response.reasoning_summary_text.delta":
                    reasons[ev["item_id"]] = reasons.get(ev["item_id"], "") + ev.get("delta", "")
                    chat.emit({"type": "reasoning", "id": ev["item_id"], "text": ev.get("delta", "")})
                elif kind == "response.output_item.added" and ev["item"].get("type") == "function_call":
                    item = ev["item"]
                    drafts[item["id"]] = {"call_id": item["call_id"], "name": item["name"], "n": 0, "t": 0.0}
                elif kind == "response.function_call_arguments.delta":
                    d = drafts.get(ev.get("item_id", ""))
                    if d:
                        d["n"] += len(ev.get("delta", ""))
                        if now - d["t"] >= 0.4:
                            d["t"] = now
                            chat.emit({"type": "tool_draft", "id": d["call_id"], "name": d["name"], "bytes": d["n"],
                                       "title": None})
                elif kind == "response.output_item.done":
                    item = ev["item"]
                    if item.get("type") == "message":
                        text = "".join(c.get("text", "") for c in item.get("content", []) if c.get("type") == "output_text")
                        chat.emit({"type": "message", "id": item["id"], "text": text or texts.get(item["id"], "")})
                    elif item.get("type") == "reasoning":
                        text = "".join(s.get("text", "") for s in item.get("summary", []) or [])
                        chat.emit({"type": "reasoning_done", "id": item["id"], "text": text or reasons.get(item["id"], "")})
                    elif item.get("type") == "function_call":
                        calls.append(item)
                elif kind in ("response.failed", "error"):
                    err = (ev.get("response") or {}).get("error") or ev.get("error") or ev
                    raise FoundryError(f"Foundry: {err.get('message') if isinstance(err, dict) else err}")
                elif kind == "response.completed":
                    chat.prev = ev["response"]["id"]
        except FoundryError as e:
            if summary and e.status == 400 and "summary" in e.body:
                summary = False  # this deployment doesn't stream reasoning summaries: ask again without
                continue
            raise
        if not calls:
            return
        pending_input = list(await asyncio.gather(*(_call(chat, c, run_tool) for c in calls)))
    chat.emit({"type": "error", "text": f"Stopped after {MAX_ROUNDS} steps without a final answer."})


async def _call(chat, item: dict, run_tool) -> dict:
    try:
        args = json.loads(item.get("arguments") or "{}")
    except ValueError:
        args = {}
    ok, text = await run_tool(chat, item["call_id"], item["name"], args)
    return {"type": "function_call_output", "call_id": item["call_id"], "output": text}
