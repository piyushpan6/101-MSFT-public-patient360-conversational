"""Contract test for Ask (Foundry): runs one question through server.py's Foundry path against a real Foundry
deployment, with a fake page that answers each page_request, and checks the NDJSON events are the ones the page
handles (chat, tool, tool_done, page_request, delta/message, done) in a sane order.

    FOUNDRY_ENDPOINT=https://<resource>.openai.azure.com FOUNDRY_MODELS=gpt-5.5 \
        python apps/patient360/chat/dev/foundry_contract.py

Needs an Entra sign-in that can call the deployment (az login). No app, data or Copilot sign-in is needed.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("FOUNDRY_EFFORT", "low")

import httpx  # noqa: E402

import server  # noqa: E402

KNOWN = {"chat", "ping", "thinking", "delta", "message", "reasoning", "reasoning_done", "tool_draft", "tool",
         "tool_done", "page_request", "error", "done"}
FAKE = {
    "find_patients": "1 patient matches (of 3,554): Z1001228 Annis Stracke, female, 71; online: ct, nodules.",
    "patient_overview": "Annis Stracke (Z1001228), female, 71. Chest CT 2019 with 15 outlined nodules; largest 21.4 mm "
                        "in the right upper lobe.",
    "imaging_studies": "CT chest 2019-03-02 (accession CT1001, online, viewer files). 15 nodules: RUL 6, LUL 5, RLL 4. "
                       "Largest Nodule 3, 21.4 mm, RUL, solid, malignancy 4.",
    "show_scan": "Showing CT1001 in 3D with all 15 nodule outlines coloured.",
}


async def main() -> int:
    if not server.foundry.enabled():
        print("Set FOUNDRY_ENDPOINT and FOUNDRY_MODELS.")
        return 2
    # A real server on a spare port: httpx's in-process ASGI transport buffers streamed responses, so the page_request
    # events would never reach this fake page.
    import uvicorn  # noqa: PLC0415
    port = int(os.environ.get("CONTRACT_PORT", "8779"))
    srv = uvicorn.Server(uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    serving = asyncio.get_running_loop().create_task(srv.serve())
    while not srv.started:
        await asyncio.sleep(0.05)
    try:
        return await run(f"http://127.0.0.1:{port}")
    finally:
        srv.should_exit = True
        await serving


async def run(base: str) -> int:
    events, calls = [], []
    async with httpx.AsyncClient(base_url=base, timeout=300) as http:
        h = {"x-backend": "foundry"}
        me = (await http.get("/api/me?backend=foundry")).json()
        models = (await http.get("/api/models", headers=h)).json()
        print("me:", me.get("backend"), "| models:", [m["id"] for m in models["models"]], "default", models["default"])
        body = {"message": "How many nodules does Annis Stracke's chest CT have, and how big is the largest? "
                           "Show the CT.", "surface": "ask", "model": models["default"], "effort": "low"}
        chat_id = None
        async with http.stream("POST", "/api/chat", headers=h, json=body) as r:
            assert r.status_code == 200, (r.status_code, await r.aread())
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                ev = json.loads(line)
                events.append(ev)
                if ev["type"] == "chat":
                    chat_id = ev["chat_id"]
                if ev["type"] == "page_request":
                    calls.append(ev["name"])
                    ok = ev["name"] in FAKE
                    reply = {"chat_id": chat_id, "id": ev["id"], "ok": ok,
                             **({"text": FAKE[ev["name"]]} if ok else {"error": "not available in this test"})}
                    asyncio.get_running_loop().create_task(http.post("/api/tool-result", headers=h, json=reply))
                if ev["type"] in ("done", "error"):
                    break
    types = [e["type"] for e in events]
    text = "".join(e.get("text", "") for e in events if e["type"] == "message")
    print("tools called:", calls)
    print("event types:", sorted(set(types)))
    print("answer:", text[:700].replace("\n", " | "))
    problems = []
    if types[0] != "chat":
        problems.append("first event is not chat")
    if types[-1] != "done":
        problems.append(f"last event is {types[-1]}: {events[-1]}")
    if set(types) - KNOWN:
        problems.append(f"unknown events {set(types) - KNOWN}")
    if not calls:
        problems.append("no tool was called")
    tool_ids = {e["id"] for e in events if e["type"] == "tool"}
    done_ids = {e["id"] for e in events if e["type"] == "tool_done"}
    if tool_ids != done_ids:
        problems.append("a tool started without finishing")
    if not text.strip():
        problems.append("no answer text")
    if "show_scan" in calls and "[[fig 1]]" not in text:
        problems.append("no [[fig 1]] narrative marker for the card")
    print("PASS" if not problems else "FAIL: " + "; ".join(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
