"""Asks Ask the questions in cases.py through the real page, as a person would, and grades the answers. Ported from the
CMS Quality Dashboard's copilot/dev/eval.py.

    uv pip install --python .venv/bin/python playwright      # once; drives the installed Google Chrome
    .venv/bin/python apps/patient360/chat/dev/eval.py [--only st-,q-xray] [--jobs 4] [--out /tmp/p360-eval]

Needs the app in local mode (npm run dev:local in apps/patient360, http://localhost:5178) and the chat server
(apps/patient360/chat/server.py on 127.0.0.1:8771, with a Copilot sign-in on this computer). Each case opens its own
page: questions go in through the Ask box, or a right-click in a record and the side panel. The page's chat stream and
what it posts back for each tool are recorded, and each card is saved as a PNG once its viewer has loaded. Writes
<out>/report.md and <out>/results.json.

Flags, per answer: slow, failed steps, errors, an error or retry mentioned in the text, tool names or raw markers in
the text, wording the writing rules ban, no card where one was expected, no opening above the cards, and the case's
own expectations (cards used, words said or not said).
"""
import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cases import CASES  # noqa: E402

BASE = "http://localhost:5178"
# --backend foundry asks on the Ask (Foundry) tab (side panel cases stay on Copilot, as the app does).
ASK_PATH = "/ask"
TURN_TIMEOUT = 420
WHOLE = False

# Tees the page's chat stream into window.__turns and records what it posts back for each tool
CAPTURE = r"""(() => {
  window.__turns = []; window.__posts = [];
  const orig = window.fetch.bind(window);
  const skip = new Set(['ping', 'thinking', 'tool_draft', 'reasoning', 'delta']);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/tool-result') && init && init.body) { try { window.__posts.push(JSON.parse(init.body)); } catch (e) {} }
    const res = await orig(input, init);
    if (/\/chat-api\/chat$/.test(url) && res.body) {
      const [a, b] = res.body.tee();
      const turn = { t0: Date.now(), events: [], end: null };
      window.__turns.push(turn);
      (async () => {
        const reader = b.getReader(), dec = new TextDecoder(); let buf = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1);
              if (!line.trim()) continue;
              try { const ev = JSON.parse(line); ev.__t = (Date.now() - turn.t0) / 1000; if (!skip.has(ev.type)) turn.events.push(ev); } catch (e) {}
            }
          }
        } catch (e) { turn.events.push({ type: 'stream_error', text: String(e) }); }
        turn.end = Date.now();
      })();
      return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
})();"""

# What the person sees: the answer's text blocks and cards, in order
READ_ANSWER = r"""(root) => ({
  text: [...root.querySelectorAll('.ans-flow .ans-text, .ans-flow .ans-note, .ans-error, .ans-stopped')]
    .map((e) => e.innerText.trim()).filter(Boolean).join('\n\n'),
  figs: [...root.querySelectorAll('.ans-fig:not(.ans-link)')].map((f) => ({ title: (f.querySelector('h3') || {}).innerText || '',
    w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height })),
  errors: [...root.querySelectorAll('.ans-error')].map((e) => e.innerText.trim()),
  steps: (root.querySelector('.ans-steps-toggle') || {}).innerText || '',
  lead: ((root.querySelector('.ans-flow > .ans-lead') || {}).innerText || '').trim(),
  first: ((root.querySelector('.ans-flow > :not(.ans-interim)') || {}).className || ''),
})"""

BANNED = re.compile(r"\b(delve\w*|landscape|tapestry|crucial|robust|leverag\w+|notably|underscores?|"
                    r"highlights? the importance|it'?s worth noting|in conclusion|game[- ]changer|seamless\w*|"
                    r"paints? a picture|a testament|stark(ly)?|sobering|journey)\b", re.I)
NEGATION = re.compile(r"\b(not just|not only|isn.t just|aren.t just|it.s not about|rather than just)\b", re.I)
LEAK = re.compile(r"\b(retr(y|ied|ying)|re-?draw(n|ing)? (it|the \w+) (after|because)|fix(ed|ing)? (the|that|it)|the (tool|query) "
                  r"(failed|errored|returned an error)|an error)\b", re.I)
TOOLNAMES = re.compile(r"\b(find_patients|patient_overview|patient_events|lab_series|read_document|imaging_studies|"
                       r"query_records|show_patients|show_timeline|show_measurements|show_scan|show_slide|show_xray|"
                       r"show_document|show_genome|show_chart|open_record|draft_note|SELECT \w)\b")
EMOJI = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF]")


def lint(text: str) -> list[str]:
    out = []
    for name, rx in (("banned word", BANNED), ("negation frame", NEGATION), ("mentions a retry or error", LEAK),
                     ("tool name or SQL in text", TOOLNAMES), ("emoji", EMOJI)):
        hits = sorted({m.group(0) for m in rx.finditer(text)})
        if hits:
            out.append(f"{name}: {', '.join(hits[:4])}")
    if "!" in re.sub(r"!\[|!=", "", text):
        out.append("exclamation mark")
    if re.search(r"\[\[(fig|summary)", text):
        out.append("raw [[fig]] marker visible")
    if re.search(r"(^|\n)\s*So[,\s]", text):
        out.append('a line starting with "So"')
    return out


def summarize_turn(events: list, posts: list) -> dict:
    tools, by_id, model = [], {}, None
    for ev in events:
        t = ev.get("type")
        if t == "chat":
            model = f"{ev.get('model')} / {ev.get('effort')}"
        elif t == "tool":
            item = {"name": ev.get("name"), "title": ev.get("title"), "t0": ev["__t"], "args": ev.get("args")}
            by_id[ev.get("id")] = item
            tools.append(item)
        elif t == "tool_done" and ev.get("id") in by_id:
            item = by_id[ev["id"]]
            item.update(ok=ev.get("ok"), secs=round(ev["__t"] - item["t0"], 1), result=(ev.get("result") or "")[:4000],
                        error=ev.get("error"))
    done = next((e for e in events if e.get("type") in ("done", "error")), None)
    errors = [e.get("text") for e in events if e.get("type") in ("error", "stream_error")]
    messages = [e.get("text") or "" for e in events if e.get("type") == "message"]
    return {"model": model, "secs": done["__t"] if done else None, "tools": tools, "errors": errors,
            "raw": "\n\n".join(m for m in messages if m.strip())}


def grade(case: dict, turns: list) -> list[str]:
    exp, flags = case.get("expect") or {}, []
    for i, t in enumerate(turns):
        tag = f"turn {i + 1}: " if len(turns) > 1 else ""
        if t.get("crash"):
            flags.append(f"{tag}HARNESS: {t['crash']}")
            continue
        if t["secs"] is None:
            flags.append(f"{tag}no answer (timed out)")
        elif t["secs"] > exp.get("max_s", 180):
            flags.append(f"{tag}slow: {t['secs']:.0f} s")
        failed = [x for x in t["tools"] if x.get("ok") is False]
        if failed:
            flags.append(f"{tag}{len(failed)} failed step(s): " + "; ".join(
                f"{x['name']}: {(x.get('result') or x.get('error') or '')[:160]}" for x in failed[:3]))
        if t["errors"]:
            flags.append(f"{tag}error event: {t['errors'][0][:200]}")
        if t["dom"]["errors"]:
            flags.append(f"{tag}error shown in the answer: {t['dom']['errors'][0][:200]}")
        flags += [f"{tag}{x}" for x in lint(t["dom"]["text"])]
        if not t["dom"]["text"].strip():
            flags.append(f"{tag}no text")
        if t["dom"]["figs"] and "ans-lead" not in t["dom"].get("first", ""):
            flags.append(f"{tag}no opening answer above the cards")
        if re.match(r"(I.ll|I will|Let me|Here (is|are)|Checking|Pulling|Looking|Showing|Drawing|Reading)\b", t["dom"].get("lead", "")):
            flags.append(f"{tag}opens with a progress note: {t['dom']['lead'][:80]!r}")
        for f in t["dom"]["figs"]:
            if f["h"] and f["h"] < 100:
                flags.append(f"{tag}card '{f['title'][:50]}' only {f['h']:.0f} px tall")
    last = turns[-1] if turns else {}
    if last.get("dom"):
        figs = sum(len(t["dom"]["figs"]) for t in turns if t.get("dom"))
        if not figs and not exp.get("nofig") and last.get("secs") is not None:
            flags.append("no card")
        used = {x.get("name") for t in turns for x in t.get("tools", []) if x.get("ok")}
        if exp.get("side") and "show_side_by_side" not in used:
            flags.append("a comparison not shown side by side")
        if exp.get("figs") and not used & set(exp["figs"]):
            flags.append(f"expected one of {exp['figs']}, used {sorted(u for u in used if u and u.startswith(('show', 'open', 'draft')))}")
        text = "\n".join(t["dom"]["text"] for t in turns if t.get("dom"))
        for rx in exp.get("says", []):
            if not re.search(rx, text, re.I):
                flags.append(f"text lacks /{rx[:60]}/")
        for rx in exp.get("nots", []):
            if re.search(rx, text, re.I):
                flags.append(f"text has /{rx[:60]}/")
    return flags


async def wait_turn(page, n: int, timeout: float = TURN_TIMEOUT) -> None:
    await page.wait_for_function(f"!!(window.__turns.length >= {n} && window.__turns[{n - 1}].end)", timeout=timeout * 1000,
                                 polling=1000)
    await page.wait_for_timeout(2500)  # viewers load their volumes and tiles


async def read_turn(page, n: int, scope: str, out: Path, prefix: str) -> dict:
    turns = await page.evaluate("window.__turns")
    posts = await page.evaluate("window.__posts")
    t = summarize_turn(turns[n - 1]["events"], posts) if len(turns) >= n else {"secs": None, "tools": [], "errors": ["no stream"], "raw": ""}
    roots = await page.query_selector_all(f"{scope} .ans")
    if not roots:
        t["dom"] = {"text": "", "figs": [], "errors": ["no answer on the page"], "steps": "", "lead": "", "first": ""}
        t["shots"] = []
        return t
    root = roots[-1]
    t["dom"] = await root.evaluate(READ_ANSWER)
    await page.add_style_tag(content=".ask-dock, .sc-dock { visibility: hidden !important; }")
    shots = []
    for i, fig in enumerate(await root.query_selector_all(".ans-fig")):
        path = out / f"{prefix}-card{i + 1}.png"
        try:
            # The answer scrolls inside the page, so a card taller than the window needs a taller window to be photographed
            h = (await fig.bounding_box() or {}).get("height", 0)
            if h > 860:
                await page.set_viewport_size({"width": 1440, "height": min(5000, int(h) + 200)})
            await fig.scroll_into_view_if_needed()
            await page.wait_for_timeout(1500)
            await fig.screenshot(path=str(path))
            shots.append(path.name)
        except Exception as e:  # noqa: BLE001
            shots.append(f"screenshot failed: {e}")
        finally:
            await page.set_viewport_size({"width": 1440, "height": 1000})
    if WHOLE:
        try:
            await root.screenshot(path=str(out / f"{prefix}-answer.png"))
            t["answer_shot"] = f"{prefix}-answer.png"
        except Exception as e:  # noqa: BLE001
            t["answer_shot"] = f"screenshot failed: {e}"
    await page.evaluate("document.querySelectorAll('style').forEach((s) => { if (s.textContent.includes('.ask-dock, .sc-dock')) s.remove(); })")
    t["shots"] = shots
    return t


async def sign_in(ctx) -> None:
    me = await (await ctx.request.get(f"{BASE}/chat-api/me")).json()
    await ctx.request.post(f"{BASE}/chat-api/signin", data=json.dumps({"id": me["accounts"][0]["id"]}),
                           headers={"Content-Type": "application/json"})


async def ask(page, q: str, n: int, scope: str = ".ask-dock") -> None:
    box = page.locator(f"{scope} textarea")
    await page.wait_for_selector(f"{scope} textarea:not([disabled])", timeout=30000)
    for _ in range(3):
        await box.fill(q)
        await page.wait_for_timeout(300)
        await page.locator(f"{scope} button[type=submit]").click()
        try:  # the question is in once its turn shows
            await page.wait_for_function(f"window.__turns.length >= {n}", timeout=20000, polling=500)
            break
        except Exception:  # noqa: BLE001
            continue
    await wait_turn(page, n)


async def right_click(page, target: dict) -> None:
    el = await page.locator(target["css"]).nth(target.get("nth", 0)).element_handle()
    await el.evaluate("(e) => e.scrollIntoView({ block: 'start', behavior: 'instant' })")
    await page.wait_for_timeout(500)
    box = await el.bounding_box()
    # The part of the element in the window (a tall pane runs past it)
    vh = (await page.evaluate("innerHeight"))
    top, bottom = max(box["y"], 70), min(box["y"] + box["height"], vh - 10)
    box = {"x": box["x"], "y": top, "width": box["width"], "height": max(10, bottom - top)}
    fx, fy = target.get("at", [0.3, 0.3])
    x, y = box["x"] + min(box["width"] * fx, 200), box["y"] + min(box["height"] * fy, 40)
    await page.mouse.move(x, y, steps=4)
    await page.mouse.click(x, y, button="right")
    try:
        await page.wait_for_selector(".ask-menu", timeout=3000)
    except Exception:  # noqa: BLE001  (landed on a viewer, which keeps its own menu): try the element's corner
        await page.mouse.click(box["x"] + 12, box["y"] + 8, button="right")
        await page.wait_for_selector(".ask-menu", timeout=5000)
    await page.wait_for_timeout(300)


async def run_case(browser, case: dict, out: Path, sem: asyncio.Semaphore) -> dict:
    async with sem:
        theme = case.get("theme", "light")
        ctx = await browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        await ctx.add_init_script(f"try{{localStorage.setItem('p360.theme','{theme}');localStorage.setItem('p360.chat.history','0')}}catch(e){{}}")
        await ctx.add_init_script(CAPTURE)
        await sign_in(ctx)
        page = await ctx.new_page()
        console = []
        page.on("pageerror", lambda e: console.append(f"pageerror: {str(e)[:300]}"))
        page.on("console", lambda m: m.type == "error" and console.append(f"console: {m.text[:300]}"))
        res = {"id": case["id"], "area": case["area"], "kind": case["kind"], "q": case.get("q"), "theme": theme, "turns": []}
        started = time.time()
        print(f"… {case['id']}", flush=True)
        try:
            if case.get("surface") == "panel":
                await page.goto(f"{BASE}{case['view']}")
                await page.wait_for_selector(".rec-pane", timeout=60000)
                await page.wait_for_timeout(2500)
                await right_click(page, case["target"])
                await page.locator(".ask-menu-item", has_text="Ask Copilot about this").click()
                await page.wait_for_selector(".side-chat.is-open .sc-about .starter", timeout=15000)
                await page.wait_for_timeout(600)
                res["context"] = await page.inner_text(".sc-ctx")
                res["suggested"] = await page.evaluate("[...document.querySelectorAll('.sc-about .starter')].map((b) => b.innerText.trim())")
                if case.get("type"):
                    res["asked"] = case["type"]
                    await ask(page, case["type"], 1, ".sc-dock")
                else:
                    chips = res["suggested"]
                    pick = next((i for i, s in enumerate(chips) if re.search(case["pick"], s)), 0)
                    res["asked"] = chips[pick] if chips else None
                    await page.locator(".sc-about .starter").nth(pick).click()
                    await wait_turn(page, 1)
                res["turns"].append(await read_turn(page, 1, ".sc-log", out, f"{case['id']}-t1"))
                if case.get("then"):
                    await page.locator(".sc-actions button[title^='Continue']").click()
                    await page.wait_for_selector(".ask-dock textarea", timeout=15000)
                    await page.wait_for_timeout(1200)
                    await ask(page, case["then"], 2)
                    res["turns"].append(await read_turn(page, 2, ".ask-log", out, f"{case['id']}-t2"))
            else:
                await page.goto(f"{BASE}{ASK_PATH}")
                await page.wait_for_selector(".ask-dock textarea:not([disabled])", timeout=30000)
                qs = case["q"] if isinstance(case["q"], list) else [case["q"]]
                for i, q in enumerate(qs):
                    await ask(page, q, i + 1)
                    res["turns"].append(await read_turn(page, i + 1, ".ask-log", out, f"{case['id']}-t{i + 1}"))
        except Exception as e:  # noqa: BLE001
            res["turns"].append({"crash": f"{type(e).__name__}: {str(e)[:300]}", "secs": None, "tools": [], "errors": [],
                                 "dom": {"text": "", "figs": [], "errors": [], "steps": ""}, "shots": []})
            try:
                await page.screenshot(path=str(out / f"{case['id']}-crash.png"))
            except Exception:  # noqa: BLE001
                pass
        res["console"] = console[:10]
        res["wall"] = round(time.time() - started, 1)
        res["flags"] = grade(case, res["turns"])
        await ctx.close()
        print(f"{'ok  ' if not res['flags'] else 'FLAG'} {case['id']:18} {res['wall']:6.0f}s  {len(res['flags'])} flag(s)", flush=True)
        return res


def report(results: list, out: Path) -> None:
    lines = ["# Ask: evaluation", "",
             f"{len(results)} cases, {sum(len(r['turns']) for r in results)} answers, "
             f"{sum(1 for r in results if not r['flags'])} with no flags.", "",
             "| Case | Area | Kind | Seconds | Steps | Cards | Flags |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in results:
        secs = " + ".join(f"{t['secs']:.0f}" if t.get("secs") else "–" for t in r["turns"])
        steps = sum(len(t["tools"]) for t in r["turns"])
        figs = " + ".join(str(len(t["dom"]["figs"])) for t in r["turns"] if t.get("dom"))
        lines.append(f"| {r['id']} | {r['area']} | {r['kind']} | {secs} | {steps} | {figs} | {len(r['flags'])} |")
    for r in results:
        lines += ["", f"## {r['id']} · {r['area']} · {r['kind']}", ""]
        if r.get("context") is not None:
            lines += [f"Pointing at: {r['context']!r}", f"Suggested: {r.get('suggested')}", f"Asked: {r.get('asked')}", ""]
        qs = r["q"] if isinstance(r["q"], list) else [r["q"]] if r["q"] else []
        for i, t in enumerate(r["turns"]):
            q = qs[i] if i < len(qs) else (r.get("asked") if i == 0 else "(then) in Ask")
            lines += [f"**Q{i + 1}:** {q}", ""]
            if t.get("crash"):
                lines += [f"CRASH: {t['crash']}", ""]
                continue
            lines.append(f"{t.get('model')} · {t['secs']}s · steps: {t['dom']['steps']}")
            for x in t["tools"]:
                lines.append(f"- {x['name']}{' · ' + x['title'] if x.get('title') else ''} · {'ok' if x.get('ok') else 'FAILED'} {x.get('secs', '')}s")
            for f, shot in zip(t["dom"]["figs"], t.get("shots", [])):
                lines.append(f"  - card: {f['title']} ({f['w']:.0f}×{f['h']:.0f}) → {shot}")
            lines += ["", "> " + t["dom"]["text"].replace("\n", "\n> "), ""]
        if r["flags"]:
            lines += ["Flags:"] + [f"- {f}" for f in r["flags"]]
        if r.get("console"):
            lines += ["Console:"] + [f"- {c}" for c in r["console"]]
    (out / "report.md").write_text("\n".join(lines) + "\n")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated ids or id prefixes")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--out", default="/tmp/p360-eval")
    ap.add_argument("--answers", action="store_true", help="also save each whole answer as a PNG")
    ap.add_argument("--gpu", action="store_true",
                    help="draw WebGL on the Mac's GPU (Metal); the tractography and fluorescence slides need it")
    ap.add_argument("--backend", choices=["ghcp", "foundry"], default="ghcp",
                    help="the Ask tab to ask on: Ask (GHCP) or Ask (Foundry)")
    a = ap.parse_args()
    global WHOLE, ASK_PATH
    WHOLE = a.answers
    ASK_PATH = "/ask/foundry" if a.backend == "foundry" else "/ask"
    pick = [s for s in a.only.split(",") if s]
    cases = [c for c in CASES if not pick or any(c["id"] == p or c["id"].startswith(p) for p in pick)]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(a.jobs)
    async with async_playwright() as p:
        gl = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] if a.gpu else ["--enable-unsafe-swiftshader"]
        browser = await p.chromium.launch(channel="chrome", headless=True, args=gl)
        results = await asyncio.gather(*(run_case(browser, c, out, sem) for c in cases))
        await browser.close()
    (out / "results.json").write_text(json.dumps(results, indent=1, default=str))
    report(list(results), out)
    flagged = sum(1 for r in results if r["flags"])
    print(f"\n{len(results) - flagged} of {len(results)} cases without flags · report: {out / 'report.md'}")


if __name__ == "__main__":
    asyncio.run(main())
