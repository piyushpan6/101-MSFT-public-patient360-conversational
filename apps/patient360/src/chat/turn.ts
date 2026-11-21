/**
 * One answer, built from the chat server's events: steps (reasoning, tool calls), text blocks, and slots for cards.
 * The same driver draws a live answer and a saved one again (replay: cards are drawn again from the saved tool calls,
 * nothing goes back to the server).
 */
import { DISPLAY_TOOLS, type Card, type ToolResult } from '@/chat/tools';
import type { ChatEvent } from '@/chat/transport';

export type Section = { k: string; v: string; pre?: boolean };
export type Step = {
  id: string;
  kind: 'think' | 'tool' | 'said' | 'note';
  label: string;
  title: string;
  sections: Section[];
  reason?: string;
  blockId?: string;
  status: 'running' | 'ok' | 'fail';
  fixed?: boolean;
  t0: number;
  t1?: number;
  name?: string;
};
export type Block = { id: string; text: string; interim: boolean };
export type Slot = {
  id: string;
  name: string;
  fig: number | null;
  card?: Card;
};
export type FlowItem = { type: 'text' | 'slot'; id: string };
export type Turn = {
  id: string;
  question: string;
  /** What the side panel was pointing at, shown under the question. */
  about?: string;
  context?: string;
  steps: Step[];
  blocks: Record<string, Block>;
  slots: Record<string, Slot>;
  flow: FlowItem[];
  figs: Record<number, string>;
  status: 'running' | 'done' | 'stopped' | 'error';
  error?: string;
  lastError?: string;
  phase: string;
  since: number;
  t0: number;
  t1?: number;
  /** A saved answer: when it was answered. */
  when?: string;
  /** Who answered: 'foundry' for Ask (Foundry), with its model; unset for GitHub Copilot. */
  by?: { backend: 'foundry'; model: string | null };
  /** What is kept of the stream, to save it and draw it again. */
  events: ChatEvent[];
};

export const TOOL_LABEL: Record<string, string> = {
  find_patients: 'Searched the patients',
  patient_overview: 'Read the record',
  patient_events: 'Listed events',
  lab_series: 'Read results',
  read_document: 'Read a document',
  imaging_studies: 'Listed the imaging',
  query_records: 'Counted across patients',
  show_patients: 'Listed patients',
  show_timeline: 'Drew a timeline',
  show_measurements: 'Drew results over time',
  show_scan: 'Opened a scan',
  show_slide: 'Opened a slide',
  show_xray: 'Opened an X-ray',
  show_document: 'Opened a document',
  show_genome: 'Opened the tumour genome',
  show_chart: 'Drew a chart',
  open_record: 'Linked the record',
  draft_note: 'Drafted a note',
};
const PHASE: Record<string, string> = {
  find_patients: 'Searching the patients',
  patient_overview: 'Reading the record',
  patient_events: 'Reading the record',
  lab_series: 'Reading results',
  read_document: 'Reading a document',
  imaging_studies: 'Reading the imaging',
  query_records: 'Counting across patients',
};
const KEEP = new Set(['message', 'reasoning_done', 'tool', 'tool_done', 'page_request', 'error', 'done']);

export function newTurn(question: string, opts?: { about?: string; context?: string }): Turn {
  return {
    id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    question,
    about: opts?.about,
    context: opts?.context,
    steps: [],
    blocks: {},
    slots: {},
    flow: [],
    figs: {},
    status: 'running',
    phase: 'Thinking',
    since: Date.now(),
    t0: performance.now(),
    events: [],
  };
}

const MARK = /^[ \t]*\[\[\s*(fig(?:ure)?\s*(\d+)|summary)\s*\]\][ \t]*$/gim;
const MARKS = /^[ \t]*\[\[[^\]\n]*\]\][ \t]*$/gm;

/** How a turn's text is laid out: the opening above the cards, each card's narrative under it, the rest in place. */
export function layout(turn: Turn): {
  lead: string;
  main: Record<string, { text: string; summary: boolean }>;
  notes: Record<number, string>;
} {
  let lead = '';
  const main: Record<string, { text: string; summary: boolean }> = {};
  const notes: Record<number, string> = {};
  for (const item of turn.flow) {
    if (item.type !== 'text') continue;
    const b = turn.blocks[item.id];
    if (!b) continue;
    const text = b.text.replace(/\n?[ \t]*\[\[[^\]\n]*$/, '');
    let cur: number | null = null;
    let inSummary = false;
    let marked = false;
    let last = 0;
    let body = '';
    let summary = false;
    const put = (seg: string) => {
      if (cur !== null && turn.figs[cur]) {
        notes[cur] = [notes[cur], seg.trim()].filter(Boolean).join('\n\n');
        return;
      }
      if (!marked && !b.interim) {
        lead = [lead, seg.trim()].filter(Boolean).join('\n\n');
        return;
      }
      body += (body && seg.trim() ? '\n\n' : '') + seg;
      if (inSummary && seg.trim()) summary = true;
    };
    MARK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARK.exec(text))) {
      put(text.slice(last, m.index));
      marked = true;
      cur = m[2] ? Number(m[2]) : null;
      inSummary = !m[2];
      last = MARK.lastIndex;
    }
    put(text.slice(last));
    main[b.id] = { text: body.trim(), summary };
  }
  return { lead, main, notes };
}

/** The answer's own text, without the card markers: what a saved chat shows as its preview and sends as transcript. */
export function answerText(turn: Turn): string {
  const msgs = turn.events.filter((e) => e.type === 'message' && e.text);
  const last = msgs.length ? String(msgs[msgs.length - 1].text) : '';
  return last
    .replace(MARKS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type DriverDeps = {
  replay?: boolean;
  /** Runs a page tool (live: data and display tools; replay: display tools only, to draw the cards again). */
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** Answers the server's page request (live only). */
  post: (id: string, reply: { ok: boolean; text?: string; error?: string }) => void;
  /** The title for a step without one, from its arguments. */
  label: (args: Record<string, unknown>) => string;
  render: () => void;
  onChat?: (ev: ChatEvent) => void;
};

export function driveTurn(turn: Turn, deps: DriverDeps) {
  const clock = () => (deps.replay ? at : performance.now());
  let at = 0;
  const step = (id: string, kind: Step['kind']): Step => {
    let s = turn.steps.find((x) => x.id === id);
    if (!s) {
      s = {
        id,
        kind,
        label: '',
        title: '',
        sections: [],
        status: 'running',
        t0: clock(),
      };
      turn.steps.push(s);
    }
    return s;
  };
  const finishStep = (s: Step, ok: boolean) => {
    if (s.status !== 'running') return;
    s.status = ok ? 'ok' : 'fail';
    s.t1 = clock();
  };
  const endThinking = () =>
    turn.steps.filter((s) => s.kind === 'think' && s.status === 'running').forEach((s) => ((s.label = 'Thought'), finishStep(s, true)));
  const block = (id: string): Block => {
    if (!turn.blocks[id]) {
      turn.blocks[id] = { id, text: '', interim: false };
      turn.flow.push({ type: 'text', id });
    }
    return turn.blocks[id];
  };
  // A further step began: what Copilot wrote so far was a progress note.
  const interim = () =>
    Object.values(turn.blocks).forEach((b) => {
      if (b.interim || !b.text.trim()) return;
      b.interim = true;
      const s = step(`s:${b.id}`, 'said');
      s.label = 'Wrote';
      s.blockId = b.id;
      finishStep(s, true);
    });
  const slotFor = (id: string, name: string): Slot => {
    if (!turn.slots[id]) {
      turn.slots[id] = { id, name, fig: null };
      turn.flow.push({ type: 'slot', id });
    }
    return turn.slots[id];
  };
  const dropSlot = (id: string) => {
    delete turn.slots[id];
    turn.flow = turn.flow.filter((f) => !(f.type === 'slot' && f.id === id));
  };
  // A corrected card keeps its number (and the narrative written for it) and replaces the earlier one.
  const place = (fig: number, id: string, card: Card) => {
    const old = turn.figs[fig];
    if (old && old !== id) dropSlot(old);
    turn.figs[fig] = id;
    const s = turn.slots[id] ?? slotFor(id, '');
    s.fig = fig;
    s.card = card;
  };

  const pageRequest = async (ev: ChatEvent) => {
    const name = String(ev.name);
    const callId = String(ev.call_id);
    const fig = typeof ev.fig === 'number' ? ev.fig : null;
    if (deps.replay && !DISPLAY_TOOLS.has(name)) return;
    let reply: { ok: boolean; text?: string; error?: string };
    try {
      const r = await deps.runTool(name, (ev.args ?? {}) as Record<string, unknown>);
      if (r.card && fig !== null) place(fig, callId, r.card);
      reply = { ok: true, text: r.text };
    } catch (e) {
      if (turn.slots[callId] && !turn.slots[callId].card) dropSlot(callId);
      reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    deps.render();
    if (!deps.replay) deps.post(String(ev.id), reply);
  };

  const handle = (ev: ChatEvent) => {
    if (deps.replay) at = turn.t0 + Number(ev.at ?? 0) * 1000;
    else if (KEEP.has(ev.type))
      turn.events.push({
        ...ev,
        at: +((performance.now() - turn.t0) / 1000).toFixed(2),
      });
    switch (ev.type) {
      case 'chat':
        if (ev.backend === 'foundry') turn.by = { backend: 'foundry', model: (ev.model as string) ?? null };
        deps.onChat?.(ev);
        break;
      case 'delta': {
        endThinking();
        if (turn.phase !== 'Writing') ((turn.phase = 'Writing'), (turn.since = Date.now()));
        block(String(ev.id)).text += String(ev.text ?? '');
        break;
      }
      case 'message':
        if (!ev.text && !turn.blocks[String(ev.id)]) break;
        block(String(ev.id)).text = String(ev.text ?? '');
        break;
      case 'thinking':
        if (turn.phase !== 'Thinking') ((turn.phase = 'Thinking'), (turn.since = Date.now()));
        break;
      case 'reasoning': {
        const s = step(`r:${ev.id}`, 'think');
        s.label = 'Thinking';
        s.reason = (s.reason ?? '') + String(ev.text ?? '');
        break;
      }
      case 'reasoning_done': {
        const s = step(`r:${ev.id}`, 'think');
        if (ev.text) s.reason = String(ev.text);
        s.label = 'Thought';
        finishStep(s, true);
        if (!s.reason) turn.steps = turn.steps.filter((x) => x !== s);
        break;
      }
      case 'tool_draft': {
        endThinking();
        interim();
        const name = String(ev.name);
        turn.phase = DISPLAY_TOOLS.has(name) ? `Drawing${ev.title ? `: ${ev.title}` : ''}` : (PHASE[name] ?? 'Working');
        if (DISPLAY_TOOLS.has(name)) slotFor(String(ev.id), name);
        break;
      }
      case 'tool': {
        endThinking();
        interim();
        const name = String(ev.name);
        const args = (ev.args ?? {}) as Record<string, string>;
        const s = step(String(ev.id), 'tool');
        s.name = name;
        s.label = TOOL_LABEL[name] ?? name;
        s.title = (ev.title as string) || deps.label(args);
        s.sections = Object.entries(args).map(([k, v]) => ({
          k,
          v: String(v),
          pre: true,
        }));
        turn.phase = DISPLAY_TOOLS.has(name) ? 'Drawing' : (PHASE[name] ?? 'Working');
        turn.since = Date.now();
        if (DISPLAY_TOOLS.has(name)) slotFor(String(ev.id), name);
        break;
      }
      case 'tool_done': {
        const s = turn.steps.find((x) => x.id === ev.id);
        if (s) {
          finishStep(s, !!ev.ok);
          if (ev.ok) turn.steps.forEach((o) => o !== s && o.name === s.name && o.status === 'fail' && (o.fixed = true));
          const back = ev.ok ? ev.result : ev.error || ev.result;
          if (back)
            s.sections.push({
              k: ev.ok ? 'Returned to Copilot' : 'Failed; Copilot was told',
              v: String(back),
              pre: true,
            });
        }
        const slot = turn.slots[String(ev.id)];
        if (slot && !slot.card && !ev.ok) dropSlot(slot.id);
        if (turn.phase !== 'Thinking') ((turn.phase = 'Thinking'), (turn.since = Date.now()));
        break;
      }
      case 'page_request':
        if (ev.kind === 'tool') void pageRequest(ev);
        break;
      case 'error': {
        turn.lastError = String(ev.text ?? 'Copilot reported an error.');
        const s = step(`e:${turn.steps.length}`, 'note');
        s.label = 'Copilot reported an error';
        s.sections = [{ k: 'Message', v: turn.lastError, pre: true }];
        finishStep(s, false);
        break;
      }
      case 'done':
        if (ev.aborted) turn.status = 'stopped';
        break;
    }
    deps.render();
  };

  const finish = (status?: Turn['status'], error?: string) => {
    endThinking();
    turn.steps.forEach((s) => finishStep(s, true));
    if (status) turn.status = status;
    if (error) turn.error = error;
    if (turn.status === 'running') turn.status = 'done';
    if (turn.lastError && !Object.values(turn.blocks).some((b) => b.text.trim()) && !Object.keys(turn.figs).length) {
      turn.status = 'error';
      turn.error = turn.lastError;
    }
    // Cards still being drawn when a saved answer is replayed keep their slots.
    if (!deps.replay) for (const s of Object.values(turn.slots)) if (!s.card) dropSlot(s.id);
    turn.t1 = deps.replay ? at : performance.now();
    deps.render();
  };

  return { handle, finish };
}
