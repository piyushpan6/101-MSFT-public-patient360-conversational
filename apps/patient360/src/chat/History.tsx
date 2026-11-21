/**
 * Your chats, beside the Ask conversation: every saved chat in folders, newest first, with search, an archive, and a
 * menu on each row to rename, move, archive or delete. Side panel chats land in the Side panel folder. Ported from the
 * CMS dashboard's history list (without drag and drop).
 */
import { ChevronRight, FolderPlus, MoreHorizontal, PanelLeftClose, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { savedBackend, useChat } from '@/chat/ChatContext';
import { historyApi, type Backend, type SavedChat, type SavedFolder } from '@/chat/transport';

const OPEN_KEY = 'p360.chat.folders';

function shortWhen(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1 && new Date().getDate() === d.getDate())
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

type MenuItem = {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  depth?: number;
  sep?: boolean;
  note?: string;
};

function Menu({ at, items, onClose }: { at: DOMRect; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.right - 220, top: at.bottom + 4 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.right - r.width, window.innerWidth - r.width - 8)),
      top: at.bottom + r.height + 8 > window.innerHeight ? at.top - r.height - 4 : at.bottom + 4,
    });
  }, [at]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);
  // Drawn in <body>: an animated ancestor (a transform) would otherwise make position: fixed measure from it.
  return createPortal(
    <div ref={ref} className="hs-menu" style={pos} role="menu">
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="hs-menu-sep" />
        ) : it.note ? (
          <p key={i} className="hs-menu-note">
            {it.note}
          </p>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`hs-mi${it.danger ? ' is-danger' : ''}`}
            style={{ ['--d' as string]: it.depth ?? 0 }}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>,
    document.body
  );
}

function Rename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <input
      className="hs-edit"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v.trim() || null);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={() => onDone(v.trim() && v.trim() !== value ? v.trim() : null)}
    />
  );
}

export function History({ onHide, onOpened }: { onHide: () => void; onOpened?: (b: Backend) => void }) {
  const chat = useChat();
  const current = chat.conversation('ask').saved?.id ?? null;
  const [data, setData] = useState<{
    folders: SavedFolder[];
    chats: SavedChat[];
  }>({ folders: [], chats: [] });
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const [menu, setMenu] = useState<{ at: DOMRect; items: MenuItem[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    historyApi
      .list()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load, chat.historyVersion]);
  useEffect(() => localStorage.setItem(OPEN_KEY, JSON.stringify(open)), [open]);

  const act = (p: Promise<unknown>) => p.then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const tree = useMemo(() => {
    const kids = new Map<string | null, SavedFolder[]>();
    for (const f of data.folders) kids.set(f.parent_id, [...(kids.get(f.parent_id) ?? []), f]);
    return kids;
  }, [data.folders]);
  const flatFolders = useMemo(() => {
    const out: { f: SavedFolder; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) =>
      (tree.get(parent) ?? []).forEach((f) => (out.push({ f, depth }), walk(f.id, depth + 1)));
    walk(null, 0);
    return out;
  }, [tree]);

  const query = q.trim().toLowerCase();
  const matches = (c: SavedChat) =>
    !query ||
    c.title.toLowerCase().includes(query) ||
    (c.patients ?? []).some((p) => p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query));
  const live = data.chats.filter((c) => !c.archived && matches(c));
  const archived = data.chats.filter((c) => c.archived && matches(c));

  const chatMenu = (c: SavedChat, at: DOMRect) =>
    setMenu({
      at,
      items: [
        { label: 'Rename', onClick: () => setEditing(c.id) },
        { sep: true, label: '' },
        { note: 'Move to', label: '' },
        {
          label: 'Top level',
          depth: 0,
          onClick: () => act(historyApi.updateChat(c.id, { folder_id: null })),
        },
        ...flatFolders
          .filter(({ f }) => f.id !== c.folder_id)
          .map(({ f, depth }) => ({
            label: f.name,
            depth: depth + 1,
            onClick: () => act(historyApi.updateChat(c.id, { folder_id: f.id })),
          })),
        { sep: true, label: '' },
        c.archived
          ? {
              label: 'Restore',
              onClick: () => act(historyApi.updateChat(c.id, { archived: false })),
            }
          : {
              label: 'Archive',
              onClick: () => act(historyApi.updateChat(c.id, { archived: true })),
            },
        {
          label: 'Delete',
          danger: true,
          onClick: () =>
            window.confirm(`Delete "${c.title}"? This can't be undone.`) &&
            act(historyApi.deleteChat(c.id).then(() => c.id === current && chat.reset('ask'))),
        },
      ],
    });
  const folderMenu = (f: SavedFolder, at: DOMRect) =>
    setMenu({
      at,
      items: [
        { label: 'Rename', onClick: () => setEditing(f.id) },
        {
          label: 'New folder inside',
          onClick: () =>
            act(historyApi.createFolder('New folder', f.id).then((n) => (setOpen((o) => ({ ...o, [f.id]: true })), setEditing(n.id)))),
        },
        {
          label: 'Archive its chats',
          onClick: () => act(historyApi.updateFolder(f.id, { archived: true })),
        },
        { sep: true, label: '' },
        {
          label: 'Delete folder',
          danger: true,
          onClick: () => window.confirm(`Delete the folder "${f.name}"? Its chats move up a level.`) && act(historyApi.deleteFolder(f.id)),
        },
      ],
    });

  const chatRow = (c: SavedChat, depth: number): ReactNode => (
    <div
      key={c.id}
      className="hs-row hs-chat"
      style={{ ['--d' as string]: depth }}
      aria-current={c.id === current}
      tabIndex={0}
      role="button"
      title={c.title}
      onClick={() =>
        editing !== c.id &&
        void chat
          .openSaved(c.id)
          .then((b) => onOpened?.(b))
          .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      }
      onKeyDown={(e) => e.key === 'Enter' && void chat.openSaved(c.id).then((b) => onOpened?.(b))}
    >
      {editing === c.id ? (
        <Rename value={c.title} onDone={(v) => (setEditing(null), v && act(historyApi.updateChat(c.id, { title: v })))} />
      ) : (
        <span className="hs-title">{c.title}</span>
      )}
      <span className={`hs-badge is-${savedBackend(c.model)}`} title={`Asked on ${savedBackend(c.model) === 'foundry' ? 'Foundry' : 'GitHub Copilot'}`}>
        {savedBackend(c.model) === 'foundry' ? 'Foundry' : 'GHCP'}
      </span>
      <span className="hs-when">{shortWhen(c.updated_at)}</span>
      <button
        type="button"
        className="hs-more"
        aria-label="Chat menu"
        onClick={(e) => {
          e.stopPropagation();
          chatMenu(c, (e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );

  const folderRows = (parent: string | null, depth: number, chats: SavedChat[]): ReactNode[] =>
    (tree.get(parent) ?? []).flatMap((f) => {
      const inside = chats.filter((c) => c.folder_id === f.id);
      const sub = folderRows(f.id, depth + 1, chats);
      if (query && !inside.length && !sub.length) return [];
      const isOpen = !!open[f.id] || !!query;
      return [
        <div key={f.id} className={`hs-folder${isOpen ? ' is-open' : ''}`}>
          <div
            className="hs-row hs-frow"
            style={{ ['--d' as string]: depth }}
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            onClick={() => editing !== f.id && setOpen((o) => ({ ...o, [f.id]: !o[f.id] }))}
          >
            <span className="hs-twist">
              <ChevronRight size={13} className="hs-chev" />
            </span>
            {editing === f.id ? (
              <Rename value={f.name} onDone={(v) => (setEditing(null), v && act(historyApi.updateFolder(f.id, { name: v })))} />
            ) : (
              <span className="hs-name">{f.name}</span>
            )}
            <span className="hs-n">{inside.length || ''}</span>
            <button
              type="button"
              className="hs-more"
              aria-label="Folder menu"
              onClick={(e) => {
                e.stopPropagation();
                folderMenu(f, (e.currentTarget as HTMLElement).getBoundingClientRect());
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          </div>
          <div className="hs-kids" hidden={!isOpen}>
            {sub}
            {inside.map((c) => chatRow(c, depth + 1))}
          </div>
        </div>,
      ];
    });

  return (
    <aside className="ask-side" aria-label="Your chats">
      <div className="hs-head">
        <span className="hs-label">Your chats</span>
        <span className="hs-tools">
          <button
            type="button"
            className="sc-icon"
            title="New folder"
            onClick={() => act(historyApi.createFolder('New folder', null).then((f) => setEditing(f.id)))}
          >
            <FolderPlus size={15} />
          </button>
          <button type="button" className="sc-icon" title="Hide your chats" onClick={onHide}>
            <PanelLeftClose size={15} />
          </button>
        </span>
      </div>
      <button type="button" className="hs-new" onClick={() => chat.reset('ask')}>
        <Plus size={15} /> New chat
      </button>
      <label className="hs-search">
        <Search size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats and patients" aria-label="Search your chats" />
      </label>
      {error && <p className="hs-flash">{error}</p>}
      <div className="hs-tree">
        {folderRows(null, 0, live)}
        {live.filter((c) => !c.folder_id || !data.folders.some((f) => f.id === c.folder_id)).map((c) => chatRow(c, 0))}
        {!data.chats.length && (
          <p className="hs-empty">
            Answered questions are kept here. Right-click in a record to ask in the side panel; those chats go to their own folder.
          </p>
        )}
        {data.chats.length > 0 && !live.length && !archived.length && <p className="hs-empty">No chat matches.</p>}
      </div>
      {archived.length > 0 && (
        <div className="hs-arch">
          <button type="button" className="hs-arch-toggle" aria-expanded={archiveOpen} onClick={() => setArchiveOpen((v) => !v)}>
            <span>Archive</span>
            <span className="hs-count">{archived.length}</span>
            <ChevronRight
              size={13}
              style={{
                transform: archiveOpen ? 'rotate(90deg)' : undefined,
                transition: 'transform .3s var(--sc-ease)',
              }}
            />
          </button>
          {archiveOpen && <div className="hs-tree hs-archive">{archived.map((c) => chatRow(c, 0))}</div>}
        </div>
      )}
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
