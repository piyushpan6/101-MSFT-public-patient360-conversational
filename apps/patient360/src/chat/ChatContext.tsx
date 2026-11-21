/**
 * Ask's conversations: one for the Ask tab and one for the record's side panel, shared through this context so the
 * panel's conversation can continue in the tab. Every answered question is saved with the events that drew it
 * (locally by the chat server); a saved chat opens again as it was answered and carries on in the same Copilot session
 * when the server still has it, or in a new one that is given the conversation so far.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { runTool, type ToolCtx } from '@/chat/tools';
import { ask, chatApi, ChatError, CHAT_AVAILABLE, historyApi, type Backend, type Me, type Model } from '@/chat/transport';
import { answerText, driveTurn, newTurn, type Turn } from '@/chat/turn';
import { useCohort } from '@/hooks/useCohort';
import { str, type PatientBundle } from '@/lib/api';

export type Surface = 'ask' | 'panel';
export type PatientRef = { id: string; name: string };
export type PanelContext = {
  patientId: string;
  patientName: string;
  tab: string;
  eyebrow: string;
  title: string;
  detail: string;
  text: string;
};
export type Conversation = {
  surface: Surface;
  /** Who answers: GitHub Copilot or the Foundry deployment (the side panel is always Copilot). */
  backend: Backend;
  chatId: string | null;
  sessionId: string | null;
  model: string | null;
  busy: boolean;
  adopt: boolean;
  turns: Turn[];
  patients: PatientRef[];
  abort: AbortController | null;
  /** Its saved chat, once the first answer is saved. */
  saved: {
    id: string;
    turns: number;
    origin: Surface;
    folderId: string | null;
  } | null;
  /** A reopened chat, until its first new question: the saved session and the conversation so far. */
  resume: { session_id: string | null; transcript: string } | null;
};

const SETTINGS_KEY = 'p360.chat';
const HISTORY_OFF = 'p360.chat.history'; // '0': don't keep (chat/dev/eval.py)
type Settings = { model: string | null; effort: string | null };
const settingsKey = (b: Backend) => (b === 'foundry' ? `${SETTINGS_KEY}.foundry` : SETTINGS_KEY);
const readSettings = (b: Backend = 'ghcp'): Settings => {
  try {
    return {
      model: null,
      effort: null,
      ...(JSON.parse(localStorage.getItem(settingsKey(b)) ?? '{}') as Partial<Settings>),
    };
  } catch {
    return { model: null, effort: null };
  }
};
/** Saved chats keep their backend in the model column ("foundry/gpt-5.5"), so history needs no new column. */
export const FOUNDRY_PREFIX = 'foundry/';
export const savedBackend = (model: string | null | undefined): Backend => (model?.startsWith(FOUNDRY_PREFIX) ? 'foundry' : 'ghcp');
const newId = () =>
  crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32);

/** What a new Copilot session is told when a saved chat carries on without its old session. */
function transcript(turns: Turn[]): string {
  return turns
    .map((t, i) => {
      const cards = Object.values(t.slots)
        .map((s) => s.card?.title)
        .filter(Boolean);
      return `Q${i + 1}: ${t.question}\nA${i + 1}: ${answerText(t).slice(0, 2500)}${cards.length ? `\n(Cards shown: ${cards.join('; ')})` : ''}`;
    })
    .join('\n\n')
    .slice(-18000);
}

interface ChatState {
  available: boolean;
  /** The backend of the Ask tab's conversation: Ask (GHCP) or Ask (Foundry). */
  backend: Backend;
  setBackend: (b: Backend) => void;
  /** The backends this chat server offers. */
  backends: Backend[];
  me: Me | null;
  meError: string | null;
  models: Model[];
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
  signIn: (accountId?: string) => Promise<void>;
  conversation: (s: Surface) => Conversation;
  send: (s: Surface, text: string, opts?: { context?: string; about?: string }) => Promise<void>;
  stop: (s: Surface) => void;
  reset: (s: Surface) => void;
  addPatients: (s: Surface, rows: PatientRef[]) => void;
  removePatient: (s: Surface, id: string) => void;
  /** The side panel's conversation, moved into the Ask tab. */
  continueInAsk: () => void;
  /** Opens a saved chat in the Ask tab; resolves to the backend it was asked on. */
  openSaved: (id: string) => Promise<Backend>;
  /** Bumped whenever a chat is saved, so the list of chats reloads. */
  historyVersion: number;
  historyChanged: () => void;
  /** The record's right-click context for the side panel. */
  panel: { open: boolean; context: PanelContext | null };
  openPanel: (ctx: PanelContext | null) => void;
  closePanel: () => void;
  version: number;
}

const Ctx = createContext<ChatState | undefined>(undefined);

function newConversation(surface: Surface, backend: Backend = 'ghcp'): Conversation {
  return {
    surface,
    backend,
    chatId: null,
    sessionId: null,
    model: null,
    busy: false,
    adopt: false,
    turns: [],
    patients: [],
    abort: null,
    saved: null,
    resume: null,
  };
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { getPatient } = useCohort();
  const convs = useRef<Record<Surface, Conversation>>({
    ask: newConversation('ask'),
    panel: newConversation('panel'),
  });
  const [version, setVersion] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  // One re-render per frame while an answer streams; the timer keeps it going in a background tab, where frames stop.
  const pending = useRef(false);
  const render = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    const flush = () => {
      if (!pending.current) return;
      pending.current = false;
      setVersion((v) => v + 1);
    };
    requestAnimationFrame(flush);
    window.setTimeout(flush, 150);
  }, []);
  // Ask (GHCP) and Ask (Foundry) each keep a sign-in, models and choice; the Ask tab shows the one it is on.
  const [backend, setBackendState] = useState<Backend>('ghcp');
  const [backends, setBackends] = useState<Backend[]>(['ghcp']);
  const [meBy, setMeBy] = useState<Record<Backend, Me | null>>({ ghcp: null, foundry: null });
  const [meErrorBy, setMeErrorBy] = useState<Record<Backend, string | null>>({ ghcp: null, foundry: null });
  const [modelsBy, setModelsBy] = useState<Record<Backend, Model[]>>({ ghcp: [], foundry: [] });
  const [settingsBy, setSettingsBy] = useState<Record<Backend, Settings>>(() => ({
    ghcp: readSettings('ghcp'),
    foundry: readSettings('foundry'),
  }));
  const me = meBy[backend];
  const meError = meErrorBy[backend];
  const models = modelsBy[backend];
  const settings = settingsBy[backend];
  const setMe = (b: Backend, m: Me | null) => setMeBy((cur) => ({ ...cur, [b]: m }));
  const setMeError = (b: Backend, e: string | null) => setMeErrorBy((cur) => ({ ...cur, [b]: e }));
  // The other backend's Ask conversation, kept while the tab shows this one.
  const parked = useRef<Partial<Record<Backend, Conversation>>>({});
  const [panel, setPanel] = useState<{
    open: boolean;
    context: PanelContext | null;
  }>({ open: false, context: null });
  const names = useRef(new Map<string, string>());

  const setSettings = useCallback(
    (s: Partial<Settings>) => {
      setSettingsBy((all) => {
        const next = { ...all[backend], ...s };
        localStorage.setItem(settingsKey(backend), JSON.stringify(next));
        return { ...all, [backend]: next };
      });
    },
    [backend]
  );

  const loadModels = useCallback(async (b: Backend) => {
    try {
      const r = await chatApi.models(b);
      setSettingsBy((all) => {
        const cur = all[b];
        const model = cur.model && r.models.some((m) => m.id === cur.model) ? cur.model : r.default;
        const m = r.models.find((x) => x.id === model);
        const effort =
          m && m.efforts.length
            ? cur.effort && m.efforts.includes(cur.effort)
              ? cur.effort
              : r.default_effort && m.efforts.includes(r.default_effort)
                ? r.default_effort
                : (m.default_effort ?? null)
            : null;
        return { ...all, [b]: { model, effort } };
      });
      setModelsBy((cur) => ({ ...cur, [b]: r.models }));
    } catch (e) {
      setMeError(b, e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadMe = useCallback(
    async (b: Backend = 'ghcp') => {
      if (!CHAT_AVAILABLE) return;
      try {
        const m = await chatApi.me(b);
        setMe(b, m);
        setMeError(b, null);
        if (m.github) await loadModels(b);
      } catch (e) {
        setMeError(b, e instanceof Error ? e.message : String(e));
      }
    },
    [loadModels]
  );

  useEffect(() => {
    void loadMe('ghcp');
    chatApi
      .backends()
      .then((b) => {
        setBackends(b);
        if (b.includes('foundry')) void loadMe('foundry');
      })
      .catch(() => undefined);
  }, [loadMe]);

  const setBackend = useCallback((b: Backend) => {
    setBackendState((cur) => {
      if (cur === b) return cur;
      const a = convs.current.ask;
      if (a.backend !== b) {
        parked.current[a.backend] = a;
        convs.current.ask = parked.current[b] ?? newConversation('ask', b);
        delete parked.current[b];
      }
      return b;
    });
  }, []);

  const signIn = useCallback(
    async (accountId?: string) => {
      try {
        if (accountId) await chatApi.signin(accountId);
        else await chatApi.githubSignIn();
        await loadMe('ghcp');
      } catch (e) {
        setMeError('ghcp', e instanceof Error ? e.message : String(e));
      }
    },
    [loadMe]
  );

  const ctxFor = useCallback(
    (c: Conversation): ToolCtx => ({
      getPatient: async (id: string): Promise<PatientBundle> => {
        const b = await getPatient(id);
        names.current.set(id, str(b.patient.display_name) ?? id);
        return b;
      },
      addPatients: (rows) => {
        for (const r of rows) if (!c.patients.some((p) => p.id === r.id)) c.patients.push(r);
        render();
      },
    }),
    [getPatient, render]
  );

  // A step's title from its arguments, when Copilot gave it none.
  const label = useCallback((args: Record<string, unknown>) => {
    const unq = (v: unknown) => String(v ?? '').replace(/^"|"$/g, '');
    if (args.query) return unq(args.query);
    if (args.subject)
      return [
        unq(args.subject),
        args.group_by
          ? `by ${unq(args.group_by)
              .replace(/[[\]"]/g, '')
              .replace(/,/g, ', ')}`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
    if (args.document_id) return unq(args.document_id);
    const ids = [
      args.patient_id,
      ...(() => {
        try {
          return typeof args.patient_ids === 'string' ? (JSON.parse(args.patient_ids) as string[]) : [];
        } catch {
          return [];
        }
      })(),
    ].filter((x): x is string => typeof x === 'string' && !!x);
    return (
      ids
        .map((id) => names.current.get(id) ?? id)
        .slice(0, 4)
        .join(', ') + (ids.length > 4 ? ` and ${ids.length - 4} more` : '')
    );
  }, []);

  const historyChanged = useCallback(() => setHistoryVersion((v) => v + 1), []);

  const save = useCallback(
    (c: Conversation, turn: Turn) => {
      if (!historyApi.available || localStorage.getItem(HISTORY_OFF) === '0') return;
      if (!turn.events.some((e) => e.type === 'message' || e.type === 'page_request')) return;
      if (!c.saved) c.saved = { id: newId(), turns: 0, origin: c.surface, folderId: null };
      const saved = c.saved;
      const idx = saved.turns++;
      const secs = ((turn.t1 ?? performance.now()) - turn.t0) / 1000;
      const status = turn.status === 'stopped' ? 'stopped' : turn.events.some((e) => e.type === 'message') ? 'done' : 'error';
      const q = turn.question.trim().replace(/[?.!]+$/, '');
      const about = turn.about?.split(' · ')[0];
      const title = idx === 0 && about && !q.toLowerCase().includes(about.toLowerCase()) ? `${q} · ${about}`.slice(0, 120) : undefined;
      historyApi
        .saveTurn(
          saved.id,
          {
            origin: saved.origin,
            session_id: c.sessionId,
            model: c.backend === 'foundry' && c.model ? `${FOUNDRY_PREFIX}${c.model}` : c.model,
            folder_id: saved.folderId,
            title,
            patients: c.patients,
          },
          {
            idx,
            question: turn.question,
            context: turn.context ?? '',
            about: turn.about ?? '',
            events: turn.events,
            secs: +secs.toFixed(1),
            status,
            preview: answerText(turn).slice(0, 300),
          }
        )
        .then((chat) => {
          saved.folderId = chat.folder_id;
          historyChanged();
        })
        .catch((e) => console.error('Could not save the chat', e));
    },
    [historyChanged]
  );

  const send = useCallback(
    async (surface: Surface, text: string, opts?: { context?: string; about?: string }) => {
      const c = convs.current[surface];
      const question = text.trim();
      if (c.busy || !question) return;
      const b = c.backend;
      const chosen = settingsBy[b];
      const turn = newTurn(question, opts);
      c.turns.push(turn);
      c.busy = true;
      const abort = new AbortController();
      c.abort = abort;
      render();
      const driver = driveTurn(turn, {
        runTool: (name, args) => runTool(name, args, ctxFor(c)),
        post: (id, reply) => {
          if (c.chatId) chatApi.toolResult(c.chatId, id, reply, b).catch(() => undefined);
        },
        label,
        render,
        onChat: (ev) => {
          c.chatId = String(ev.chat_id);
          c.sessionId = (ev.session_id as string) ?? c.sessionId;
          c.model = (ev.model as string) ?? null;
          c.resume = null;
        },
      });
      let status: Turn['status'] | undefined;
      let error: string | undefined;
      try {
        const patients = c.patients.map((p) => `${p.id} ${p.name}`).join('\n');
        for await (const ev of ask(
          {
            message: question,
            surface,
            chat_id: c.chatId,
            model: chosen.model,
            effort: chosen.effort,
            context: opts?.context,
            patients: patients || undefined,
            adopt: c.adopt || undefined,
            resume: !c.chatId && c.resume ? c.resume : undefined,
          },
          abort.signal,
          b
        )) {
          driver.handle(ev);
          if (ev.type === 'done') break;
        }
        c.adopt = false;
      } catch (e) {
        if (!abort.signal.aborted) {
          status = 'error';
          error =
            e instanceof ChatError
              ? e.message
              : `The connection to ${b === 'foundry' ? 'Foundry' : 'Copilot'} dropped (${e instanceof Error ? e.message : String(e)}).`;
          if (e instanceof ChatError && e.code) void loadMe(b);
        } else status = 'stopped';
      } finally {
        driver.finish(status, error);
        c.busy = false;
        c.abort = null;
        render();
        save(c, turn);
      }
    },
    [ctxFor, label, render, save, settingsBy, loadMe]
  );

  const stop = useCallback(
    (surface: Surface) => {
      const c = convs.current[surface];
      if (c.chatId) chatApi.stop(c.chatId, c.backend).catch(() => undefined);
      window.setTimeout(() => c.abort?.abort(), 1500);
      render();
    },
    [render]
  );

  const reset = useCallback(
    (surface: Surface) => {
      const c = convs.current[surface];
      if (c.busy) stop(surface);
      convs.current[surface] = {
        ...newConversation(surface, c.backend),
        patients: surface === 'ask' && !c.saved ? c.patients : [],
      };
      render();
    },
    [render, stop]
  );

  const addPatients = useCallback(
    (surface: Surface, rows: PatientRef[]) => {
      const c = convs.current[surface];
      for (const r of rows) if (!c.patients.some((p) => p.id === r.id)) c.patients.push(r);
      render();
    },
    [render]
  );
  const removePatient = useCallback(
    (surface: Surface, id: string) => {
      const c = convs.current[surface];
      c.patients = c.patients.filter((p) => p.id !== id);
      render();
    },
    [render]
  );

  const continueInAsk = useCallback(() => {
    const p = convs.current.panel;
    const a = convs.current.ask;
    if (a.busy) stop('ask');
    const context = panel.context;
    const patients = [...p.patients];
    if (context && !patients.some((x) => x.id === context.patientId))
      patients.unshift({ id: context.patientId, name: context.patientName });
    // The side panel answers on Copilot, so its conversation continues in Ask (GHCP).
    if (a.backend !== 'ghcp') {
      parked.current[a.backend] = a;
      setBackendState('ghcp');
    }
    convs.current.ask = { ...p, surface: 'ask', backend: 'ghcp', adopt: true, patients };
    convs.current.panel = newConversation('panel');
    setPanel({ open: false, context: null });
    render();
  }, [panel.context, render, stop]);

  const openSaved = useCallback(
    async (id: string) => {
      const a = convs.current.ask;
      if (a.busy) stop('ask');
      const { chat, turns } = await historyApi.getChat(id);
      const b = savedBackend(chat.model);
      if (a.backend !== b) parked.current[a.backend] = a;
      delete parked.current[b];
      const c: Conversation = {
        ...newConversation('ask', b),
        patients: chat.patients ?? [],
        saved: {
          id: chat.id,
          turns: turns.length,
          origin: chat.origin === 'panel' ? 'panel' : 'ask',
          folderId: chat.folder_id,
        },
      };
      for (const t of turns) {
        const turn = newTurn(t.question, {
          about: t.about ?? undefined,
          context: t.context ?? undefined,
        });
        turn.when = t.created_at;
        turn.events = t.events;
        const driver = driveTurn(turn, {
          replay: true,
          runTool: (name, args) => runTool(name, args, ctxFor(c)),
          post: () => undefined,
          label,
          render,
        });
        for (const ev of t.events) if (ev.type !== 'done' && ev.type !== 'error') driver.handle(ev);
        const end = t.events.find((e) => e.type === 'done');
        const failed =
          t.status === 'error' ? String(t.events.find((e) => e.type === 'error')?.text ?? 'This answer did not finish.') : undefined;
        driver.finish(end?.aborted || t.status === 'stopped' ? 'stopped' : failed ? 'error' : 'done', failed);
        c.turns.push(turn);
      }
      c.resume = {
        session_id: chat.session_id,
        transcript: transcript(c.turns),
      };
      convs.current.ask = c;
      setBackendState(b);
      render();
      return b;
    },
    [ctxFor, label, render, stop]
  );

  const openPanel = useCallback((context: PanelContext | null) => {
    setPanel((cur) => {
      // Another patient starts another conversation.
      if (context && cur.context && cur.context.patientId !== context.patientId && !convs.current.panel.busy)
        convs.current.panel = newConversation('panel');
      return { open: true, context };
    });
  }, []);
  const closePanel = useCallback(() => setPanel((p) => ({ ...p, open: false })), []);

  const value = useMemo<ChatState>(
    () => ({
      available: CHAT_AVAILABLE,
      backend,
      setBackend,
      backends,
      me,
      meError,
      models,
      settings,
      setSettings,
      signIn,
      conversation: (s) => convs.current[s],
      send,
      stop,
      reset,
      addPatients,
      removePatient,
      continueInAsk,
      openSaved,
      historyVersion,
      historyChanged,
      panel,
      openPanel,
      closePanel,
      version,
    }),
    [
      backend,
      setBackend,
      backends,
      me,
      meError,
      models,
      settings,
      setSettings,
      signIn,
      send,
      stop,
      reset,
      addPatients,
      removePatient,
      continueInAsk,
      openSaved,
      historyVersion,
      historyChanged,
      panel,
      openPanel,
      closePanel,
      version,
    ]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChat(): ChatState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useChat must be used within ChatProvider');
  return c;
}
