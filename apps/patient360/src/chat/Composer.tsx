/** The question box, the Copilot sign-in, and the patients in the conversation; shared by the Ask tab and the panel. */
import { ArrowRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useChat, type Surface } from '@/chat/ChatContext';
import { searchPatients, str, type PatientListRow } from '@/lib/api';
import { LOCAL_DATA } from '@/lib/localMode';

const EFFORT: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export function Composer({
  surface,
  placeholder,
  autoFocus,
  onSent,
  context,
  pickers = true,
}: {
  surface: Surface;
  placeholder?: string;
  autoFocus?: boolean;
  onSent?: () => void;
  /** The side panel's [Pointing at] text and the line shown under the question. */
  context?: { context: string; about: string };
  /** Draw the model and thinking level above the box; the Ask tab puts them on its patients row instead. */
  pickers?: boolean;
}) {
  const chat = useChat();
  const c = chat.conversation(surface);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const ready = !!chat.me?.github && chat.models.length > 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  // A suggested question fills the box when the reader picks it with Alt held; otherwise it is asked straight away.
  useEffect(() => {
    const onFill = (e: Event) => {
      const d = (e as CustomEvent<{ surface: Surface; text: string }>).detail;
      if (d.surface !== surface) return;
      setText(d.text);
      ref.current?.focus();
    };
    window.addEventListener('p360:fill', onFill);
    return () => window.removeEventListener('p360:fill', onFill);
  }, [surface]);

  const submit = () => {
    if (!text.trim() || c.busy || !ready) return;
    const q = text;
    setText('');
    onSent?.();
    void chat.send(surface, q, context);
  };

  return (
    <div className="chat-compose">
      {pickers && <ModelPicker />}
      <form
        className="chat-box"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onClick={() => ref.current?.focus()}
      >
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={ready ? (placeholder ?? 'Ask about a patient, several patients, or all of them') : 'Sign in to GitHub Copilot to ask'}
          disabled={!ready}
          aria-label="Your question"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-box-foot" onClick={(e) => e.stopPropagation()}>
          {c.busy ? (
            <button type="button" className="btn is-stop" onClick={() => chat.stop(surface)}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-ink" disabled={!text.trim() || !ready}>
              Ask
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** The model and the thinking level for the next question. */
export function ModelPicker() {
  const chat = useChat();
  const model = chat.models.find((m) => m.id === chat.settings.model);
  if (!chat.models.length) return null;
  return (
    <div className="chat-models">
      <label className="chat-pick">
        <span>Model</span>
        <select
          value={chat.settings.model ?? ''}
          onChange={(e) => {
            const m = chat.models.find((x) => x.id === e.target.value);
            chat.setSettings({
              model: e.target.value,
              effort:
                m && m.efforts.length
                  ? m.efforts.includes(chat.settings.effort ?? '')
                    ? chat.settings.effort
                    : (m.default_effort ?? m.efforts[0])
                  : null,
            });
          }}
        >
          {chat.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {model && model.efforts.length > 0 && (
        <label className="chat-pick">
          <span>Thinking</span>
          <select value={chat.settings.effort ?? ''} onChange={(e) => chat.setSettings({ effort: e.target.value })}>
            {model.efforts.map((x) => (
              <option key={x} value={x}>
                {EFFORT[x] ?? x}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Who Copilot runs as, and the sign-in when nobody is signed in yet. */
export function AccountLine({ compact = false }: { compact?: boolean }) {
  const chat = useChat();
  const [choosing, setChoosing] = useState(false);
  if (!chat.available)
    return (
      <p className="chat-note">
        Ask needs its chat service. Locally, start it with <span className="t-mono">.venv/bin/python apps/patient360/chat/server.py</span>;
        in Fabric the app reaches it through the chat relay.
      </p>
    );
  const me = chat.me;
  if (chat.backend === 'foundry')
    return me ? (
      <div className="chat-who">
        <span className="chat-who-k">Answers from</span>
        <span className="chat-who-v">Microsoft Foundry</span>
      </div>
    ) : (
      <p className="chat-note">{chat.meError ? `Foundry is not answering (${chat.meError}).` : 'Connecting to Foundry'}</p>
    );
  if (!me)
    return chat.meError ? (
      <p className="chat-note">
        The chat service is not answering ({chat.meError}).
        {LOCAL_DATA ? ' Start apps/patient360/chat/server.py and reload.' : ''}
      </p>
    ) : (
      <p className="chat-note">Connecting to Copilot</p>
    );
  if (me.github && !choosing)
    return (
      <div className="chat-who">
        <span className="chat-who-k">Copilot runs as</span>
        <span className="chat-who-v">{me.github.login}</span>
        {me.mode === 'local' && (me.accounts?.length ?? 0) > 1 && !compact && (
          <button type="button" className="chat-link" onClick={() => setChoosing(true)}>
            Change
          </button>
        )}
      </div>
    );
  if (me.mode === 'local')
    return (
      <div className="chat-signin">
        <p>Copilot answers on a GitHub Copilot plan signed in on this computer. Choose the account:</p>
        <div className="chat-accounts">
          {(me.accounts ?? []).map((a) => (
            <button key={a.id} type="button" className="btn" onClick={() => void chat.signIn(a.id).then(() => setChoosing(false))}>
              {a.login}
              <span className="chat-acc-src">{a.source}</span>
            </button>
          ))}
          {!me.accounts?.length && (
            <span className="chat-note">No Copilot sign-in found. Run gh auth login or sign in to the Copilot CLI, then reload.</span>
          )}
        </div>
      </div>
    );
  return (
    <div className="chat-signin">
      <p>Copilot answers on your own GitHub Copilot plan. Sign in with the GitHub account that has your Copilot seat.</p>
      <button type="button" className="btn btn-ink" onClick={() => void chat.signIn()}>
        Sign in with GitHub
      </button>
      {chat.meError && <p className="chat-note">{chat.meError}</p>}
    </div>
  );
}

/** The patients this conversation is about: sent with every question, and added by search or from an answer. */
export function PatientStrip({ surface }: { surface: Surface }) {
  const chat = useChat();
  const c = chat.conversation(surface);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<PatientListRow[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) {
      setFound([]);
      return;
    }
    let off = false;
    const h = window.setTimeout(() => {
      searchPatients({ q: t, limit: 6 })
        .then((r) => !off && setFound(r.patients))
        .catch(() => !off && setFound([]));
    }, 250);
    return () => {
      off = true;
      window.clearTimeout(h);
    };
  }, [q]);
  return (
    <div className="pt-strip">
      <span className="pt-strip-k">{c.patients.length ? 'Patients in this conversation' : 'No patients added'}</span>
      {c.patients.map((p) => (
        <span key={p.id} className="pt-chip">
          <span>{p.name}</span>
          <span className="t-faint mono">{p.id}</span>
          <button type="button" aria-label={`Remove ${p.name}`} onClick={() => chat.removePatient(surface, p.id)}>
            <X size={12} />
          </button>
        </span>
      ))}
      <span className="pt-add">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder="Add a patient by name or ID"
          aria-label="Add a patient"
        />
        {open && found.length > 0 && (
          <span className="pt-add-list" role="listbox">
            {found.map((p) => (
              <button
                key={str(p.patient_id)!}
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  chat.addPatients(surface, [{ id: str(p.patient_id)!, name: str(p.display_name) ?? '' }]);
                  setQ('');
                  setOpen(false);
                }}
              >
                <span className="font-medium">{str(p.display_name)}</span>
                <span className="t-faint mono text-[11.5px]">{str(p.patient_id)}</span>
                <span className="t-faint truncate text-[12px]">{str(p.demo_title) ?? str(p.cancers)?.split(';')[0] ?? ''}</span>
              </button>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

export function StarterButton({ q, why, onAsk }: { q: string; why?: string; onAsk: (q: string, fill: boolean) => void }) {
  return (
    <button type="button" className="starter" onClick={(e) => onAsk(q, e.altKey)} title="Ask this (hold Alt to edit it first)">
      <span>{q}</span>
      {why && <small>{why}</small>}
      <ArrowRight size={13} className="starter-go" aria-hidden />
    </button>
  );
}
