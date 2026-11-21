/** One answer as it streams: Copilot's byline with the steps folded under it, the opening, the cards each with its
 * narrative, the summary, and a status line while it works. */
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { CardView } from '@/chat/cards';
import { layout, type Step, type Turn } from '@/chat/turn';
import { md } from '@/chat/markdown';

const TRACE_KEY = 'p360.chat.trace';

/** When a saved answer was given, as a reader would say it. */
function whenText(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (days < 1 && new Date().getDate() === d.getDate()) return `Today, ${time}`;
  if (days < 2) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}
const secs = (ms: number) => (ms < 1000 ? 'under 1 s' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const sentence = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = t.match(/^.{20,140}?[.!?](\s|$)/);
  return m ? m[0].trim() : t.slice(0, 140);
};

function Md({ text, className }: { text: string; className?: string }) {
  const navigate = useNavigate();
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a[data-internal]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute('href')!);
  };
  return <div className={`md ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: md(text) }} />;
}

function StepRow({ s, turn }: { s: Step; turn: Turn }) {
  const [open, setOpen] = useState(false);
  const said = s.kind === 'said' && s.blockId ? (turn.blocks[s.blockId]?.text ?? '') : '';
  const title = s.kind === 'think' ? sentence(s.reason ?? '') : s.kind === 'said' ? sentence(said) : s.title;
  return (
    <li className={`tr-item tr-${s.kind} ${s.status === 'running' ? 'is-running' : s.status}${s.fixed ? ' fixed' : ''}`}>
      <button type="button" className="tr-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tr-dot" aria-hidden />
        <span className="tr-l">{s.label}</span>
        <span className="tr-t">{title}</span>
        <span className="tr-time">{s.t1 ? secs(s.t1 - s.t0) : ''}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="tr-body">
          {s.kind === 'think' && <Md className="tr-reason" text={s.reason ?? ''} />}
          {s.kind === 'said' && <Md className="tr-reason" text={said} />}
          {s.sections.map((x, i) => (
            <div key={i} className="tr-sec">
              <div className="tr-k">{x.k}</div>
              {x.pre ? <pre className="tr-pre">{x.v}</pre> : <p className="tr-v">{x.v}</p>}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** Text that folds away (a progress note once the answer has its own text). */
function Fold({ gone, children }: { gone: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!gone || !el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRemoved(true);
      return;
    }
    el.style.height = `${el.offsetHeight}px`;
    el.classList.add('is-folding');
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.height = '0px')));
    const t = window.setTimeout(() => setRemoved(true), 600);
    return () => window.clearTimeout(t);
  }, [gone]);
  if (removed) return null;
  return (
    <div ref={ref} className="ans-interim">
      {children}
    </div>
  );
}

export function Answer({ turn, onAddPatients }: { turn: Turn; onAddPatients?: (rows: { id: string; name: string }[]) => void }) {
  const [traceOpen, setTraceOpen] = useState(() => localStorage.getItem(TRACE_KEY) === '1');
  const [, tick] = useState(0);
  useEffect(() => {
    if (turn.status !== 'running') return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [turn.status]);
  const running = turn.status === 'running';
  const { lead, main, notes } = layout(turn);
  const answered = Object.keys(notes).length > 0 || Object.values(main).some((m) => m.text) || !!lead;
  const nTools = turn.steps.filter((s) => s.kind === 'tool').length;
  const nFixed = turn.steps.filter((s) => s.fixed).length;
  const visibleSteps = turn.steps.filter((s) => s.kind !== 'said' || !!turn.blocks[s.blockId ?? '']?.text.trim());
  const summary = [
    nTools ? `${nTools} ${nTools === 1 ? 'step' : 'steps'}` : 'Reasoning',
    nFixed ? `${nFixed} corrected` : '',
    !running && turn.t1 ? secs(turn.t1 - turn.t0) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const hasSlots = turn.flow.some((f) => f.type === 'slot');
  const elapsed = Math.round((Date.now() - turn.since) / 1000);

  const out: React.ReactNode[] = [];
  let leadShown = false;
  const showLead = (key: string) => {
    if (leadShown || !lead) return;
    leadShown = true;
    out.push(<Md key={`lead-${key}`} className="ans-text ans-lead" text={lead} />);
  };
  for (const item of turn.flow) {
    if (item.type === 'slot') {
      const s = turn.slots[item.id];
      if (!s) continue;
      if (s.card) showLead(item.id);
      out.push(
        <div key={item.id} className="ans-slot">
          {s.card ? <CardView card={s.card} onAddPatients={onAddPatients} /> : <div className="ans-slot-wait" />}
        </div>
      );
      if (s.fig !== null && notes[s.fig]) out.push(<Md key={`n-${item.id}`} className="ans-note" text={notes[s.fig]} />);
      continue;
    }
    const b = turn.blocks[item.id];
    if (!b) continue;
    if (b.interim) {
      if (!b.text.trim()) continue;
      out.push(
        <Fold key={item.id} gone={!running && answered}>
          <Md text={b.text.replace(/^[ \t]*\[\[[^\]\n]*\]\][ \t]*$/gm, '')} />
        </Fold>
      );
      continue;
    }
    if (!hasSlots || !Object.values(turn.slots).some((s) => s.card)) showLead(item.id);
    const m = main[b.id];
    if (m?.text) out.push(<Md key={item.id} className={`ans-text${m.summary && hasSlots ? ' ans-summary' : ''}`} text={m.text} />);
  }
  showLead('end');
  // Who answered: Foundry turns are marked from their chat event (saved ones from the chat's model, foundry/<model>).
  const byFoundry = turn.by?.backend === 'foundry';
  const by = byFoundry ? `Microsoft Foundry${turn.by?.model ? ` · ${turn.by.model}` : ''}` : 'GitHub Copilot';

  return (
    <div className="ans">
      <div className="ans-head">
        <span className="ans-by">{by}</span>
        {turn.when && <span className="ans-when">{whenText(turn.when)}</span>}
        {visibleSteps.length > 0 && (
          <button
            type="button"
            className="ans-steps-toggle"
            aria-expanded={traceOpen}
            title={`How ${byFoundry ? 'the model' : 'Copilot'} answered: its reasoning, each step and what it returned`}
            onClick={() => {
              setTraceOpen((v) => {
                localStorage.setItem(TRACE_KEY, v ? '0' : '1');
                return !v;
              });
            }}
          >
            <span>{summary}</span>
            <ChevronDown size={13} />
          </button>
        )}
      </div>
      {traceOpen && visibleSteps.length > 0 && (
        <ol className="ans-trace">
          {visibleSteps.map((s) => (
            <StepRow key={s.id} s={s} turn={turn} />
          ))}
        </ol>
      )}
      <div className="ans-flow">{out}</div>
      {turn.error && <p className="ans-error">{turn.error}</p>}
      {turn.status === 'stopped' && <p className="ans-stopped">Stopped.</p>}
      {running && (
        <div className="ans-status" role="status">
          <span className="ans-dot" aria-hidden />
          <span>{elapsed >= 2 ? `${turn.phase} · ${elapsed}s` : turn.phase}</span>
        </div>
      )}
    </div>
  );
}
