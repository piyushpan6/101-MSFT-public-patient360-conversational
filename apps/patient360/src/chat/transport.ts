/**
 * Ask's transport: the chat server (chat/server.py) streams NDJSON events for each question; when Copilot calls a
 * tool, the server sends a page_request and this page answers it with POST tool-result.
 *
 * Local mode: the Vite dev server proxies /chat-api to the server on this computer (port 8771); the Copilot sign-in
 * is one of this Mac's, chosen once and kept in a cookie. Fabric: the relay in Azure Container Apps, whose address
 * comes with the chat ticket from the app's chatTicket function (the ticket goes with every call).
 */
import { fabricHistory } from '@/chat/historyFabric';
import { LOCAL_DATA } from '@/lib/localMode';
import { getRayfinClient } from '@/services/rayfin/RayfinClientService';

export type ChatEvent = { type: string; [k: string]: unknown };

export const CHAT_AVAILABLE = true;

let ticket: { value: string; expires: number; relay: string } | null = null;

/** A chat ticket from the app's chatTicket function (the Fabric user, signed, valid 30 minutes) and the relay's address. */
async function chatTicket(force = false): Promise<{ value: string; relay: string }> {
  if (!force && ticket && ticket.expires - Date.now() > 120_000) return ticket;
  const functions = getRayfinClient().functions as unknown as Record<string, { invoke: (i?: unknown) => Promise<unknown> }>;
  const raw = await functions.chatTicket.invoke(undefined);
  const t = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { ticket: string; expiresAt: number; chatUrl: string };
  ticket = { value: t.ticket, expires: t.expiresAt * 1000, relay: t.chatUrl.replace(/\/$/, '') };
  return ticket;
}

const base = async () => (LOCAL_DATA ? '/chat-api' : `${(await chatTicket()).relay}/api`);

/** Which model runtime answers: GitHub Copilot (Ask (GHCP)) or a Microsoft Foundry deployment (Ask (Foundry)). */
export type Backend = 'ghcp' | 'foundry';

async function headers(json = true, backend: Backend = 'ghcp'): Promise<Record<string, string>> {
  const h: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
  if (!LOCAL_DATA) h['x-chat-ticket'] = (await chatTicket()).value;
  if (backend === 'foundry') h['x-backend'] = 'foundry';
  return h;
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit & { method?: string }, backend: Backend = 'ghcp'): Promise<T> {
  const res = await fetch(`${await base()}${path}`, {
    ...init,
    headers: await headers(!!init?.body, backend),
    credentials: LOCAL_DATA ? 'same-origin' : 'omit',
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!res.ok) throw new ChatError(data.error ?? `The chat server answered ${res.status}`, data.code);
  return data as T;
}

export type Account = {
  id: string;
  login: string;
  source: string;
  plan?: string | null;
};
export type Me = {
  mode: 'local' | 'relay';
  accounts?: Account[];
  github: { login: string; id?: string } | null;
  user?: string;
  backend?: Backend;
};
export type Model = {
  id: string;
  name: string;
  efforts: string[];
  default_effort?: string | null;
};

export const chatApi = {
  me: (backend: Backend = 'ghcp') => call<Me>(backend === 'foundry' ? '/me?backend=foundry' : '/me', undefined, backend),
  /** The backends this chat server offers (Foundry only when it is set up). */
  backends: () => call<{ backends?: Backend[] }>('/health').then((r): Backend[] => r.backends ?? ['ghcp']),
  signin: (id: string) =>
    call<{ ok: boolean; login: string }>('/signin', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  models: (backend: Backend = 'ghcp') =>
    call<{
      models: Model[];
      default: string | null;
      default_effort: string | null;
      login: string;
    }>('/models', undefined, backend),
  stop: (chatId: string, backend: Backend = 'ghcp') =>
    call(
      '/stop',
      {
        method: 'POST',
        body: JSON.stringify({ chat_id: chatId }),
      },
      backend
    ),
  toolResult: (chatId: string, id: string, result: { ok: boolean; text?: string; error?: string }, backend: Backend = 'ghcp') =>
    call(
      '/tool-result',
      {
        method: 'POST',
        body: JSON.stringify({ chat_id: chatId, id, ...result }),
      },
      backend
    ),
  /** Fabric: opens the relay's GitHub sign-in in a popup and resolves when it reports back. */
  async githubSignIn(): Promise<string | null> {
    // The window opens inside the click (popup blockers), then goes to the relay with a fresh ticket.
    const popup = window.open('about:blank', 'p360-github', 'width=560,height=720');
    const t = await chatTicket(true);
    if (popup) popup.location.href = `${t.relay}/auth/github/start?ticket=${encodeURIComponent(t.value)}&origin=${encodeURIComponent(location.origin)}`;
    return new Promise((resolve) => {
      const onMessage = (e: MessageEvent) => {
        const d = e.data as { type?: string; ok?: boolean; login?: string };
        if (d?.type !== 'p360-github') return;
        window.removeEventListener('message', onMessage);
        resolve(d.ok ? (d.login ?? '') : null);
      };
      window.addEventListener('message', onMessage);
      const timer = window.setInterval(() => {
        if (popup && popup.closed) {
          window.clearInterval(timer);
          window.setTimeout(() => resolve(null), 800);
        }
      }, 500);
    });
  },
};

export type SavedFolder = {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'user' | 'quick';
  created_at: string;
  updated_at: string;
};
export type SavedChat = {
  id: string;
  folder_id: string | null;
  title: string;
  origin: 'ask' | 'panel';
  archived: boolean;
  session_id: string | null;
  model: string | null;
  turns: number;
  patients: { id: string; name: string }[];
  created_at: string;
  updated_at: string;
};
export type SavedTurn = {
  idx: number;
  question: string;
  context: string | null;
  about: string | null;
  preview: string | null;
  status: string;
  secs: number;
  created_at: string;
  events: ChatEvent[];
};

const send = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Saved chats. Locally the chat server keeps them (chat/history.py); in Fabric, the app's Rayfin database. */
/** Saved chats: on this computer through the chat server (chat/history.py); in Fabric in the app's Rayfin database. */
const localHistory = {
  list: () => call<{ folders: SavedFolder[]; chats: SavedChat[] }>('/history'),
  createFolder: (name: string, parentId: string | null) =>
    call<SavedFolder>('/history/folders', send('POST', { name, parent_id: parentId })),
  updateFolder: (id: string, patch: { name?: string; parent_id?: string | null; archived?: boolean }) =>
    call<SavedFolder>(`/history/folders/${id}`, send('PATCH', patch)),
  deleteFolder: (id: string) => call<{ ok: boolean }>(`/history/folders/${id}`, send('DELETE')),
  getChat: (id: string) => call<{ chat: SavedChat; turns: SavedTurn[] }>(`/history/chats/${id}`),
  updateChat: (id: string, patch: { title?: string; folder_id?: string | null; archived?: boolean }) =>
    call<SavedChat>(`/history/chats/${id}`, send('PATCH', patch)),
  deleteChat: (id: string) => call<{ ok: boolean }>(`/history/chats/${id}`, send('DELETE')),
  saveTurn: (id: string, chat: Record<string, unknown>, turn: Record<string, unknown>) =>
    call<SavedChat>(`/history/chats/${id}/turns`, send('POST', { chat, turn })),
};

export const historyApi = { available: true, ...(LOCAL_DATA ? localHistory : fabricHistory) };

export type AskBody = {
  message: string;
  surface: 'ask' | 'panel';
  chat_id?: string | null;
  model?: string | null;
  effort?: string | null;
  context?: string;
  patients?: string;
  adopt?: boolean;
  /** A reopened chat: its saved Copilot session, and what was asked and answered, if the session is gone. */
  resume?: { session_id: string | null; transcript: string };
};

/** One question: yields the server's events until the answer is done. */
export async function* ask(body: AskBody, signal: AbortSignal, backend: Backend = 'ghcp'): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${await base()}/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: await headers(true, backend),
    signal,
    credentials: LOCAL_DATA ? 'same-origin' : 'omit',
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new ChatError(data.error ?? `The chat server answered ${res.status}`, data.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as ChatEvent;
    }
  }
}
