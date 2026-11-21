import { PanelLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { Answer } from '@/chat/Answer';
import { useChat } from '@/chat/ChatContext';
import { AccountLine, Composer, ModelPicker, PatientStrip, StarterButton } from '@/chat/Composer';
import { History } from '@/chat/History';
import { FOR_PATIENTS, ROLES } from '@/chat/starters';
import { historyApi, type Backend } from '@/chat/transport';
import { searchPatients, str } from '@/lib/api';

const ROLE_KEY = 'p360.role';
const SIDE_KEY = 'p360.chat.side';

/**
 * Ask: a conversation about one patient, several, or all of them, answered by GitHub Copilot (Ask (GHCP)) or by a
 * model in Microsoft Foundry (Ask (Foundry)). Both read the records through the same functions the record uses, and
 * answer with the record's own views as cards.
 */
export function Ask({ backend = 'ghcp' }: { backend?: Backend }) {
  const chat = useChat();
  const navigate = useNavigate();
  useEffect(() => chat.setBackend(backend), [backend]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = chat.conversation('ask');
  const who = backend === 'foundry' ? 'Foundry' : 'GitHub Copilot';
  const [params, setParams] = useSearchParams();
  const [role, setRole] = useState(() => localStorage.getItem(ROLE_KEY) ?? ROLES[0].id);
  const [showStarters, setShowStarters] = useState(false);
  const [side, setSide] = useState(() => localStorage.getItem(SIDE_KEY) !== 'hidden');
  const toggleSide = (v: boolean) => {
    setSide(v);
    localStorage.setItem(SIDE_KEY, v ? 'shown' : 'hidden');
  };
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const started = c.turns.length > 0;
  const busy = c.busy;

  // /ask?p=Z1002519,TCGA-J2-8192 starts with those patients in the conversation.
  useEffect(() => {
    const ids = (params.get('p') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (!ids.length) return;
    setParams(
      (p) => {
        p.delete('p');
        return p;
      },
      { replace: true }
    );
    searchPatients({ ids, limit: ids.length })
      .then((r) =>
        chat.addPatients(
          'ask',
          r.patients.map((p) => ({
            id: str(p.patient_id)!,
            name: str(p.display_name) ?? '',
          }))
        )
      )
      .catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the answer as it grows, unless the reader has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160);
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      if (stick.current && busy) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
    if (log.current) ro.observe(log.current);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [busy]);

  const askNow = (q: string, fill = false) => {
    if (fill) {
      window.dispatchEvent(new CustomEvent('p360:fill', { detail: { surface: 'ask', text: q } }));
      return;
    }
    stick.current = true;
    setShowStarters(false);
    void chat.send('ask', q);
  };

  const current = ROLES.find((r) => r.id === role) ?? ROLES[0];
  const starters = (
    <div className="ask-starters">
      {c.patients.length > 0 && (
        <>
          <div className="t-label mb-2">About the patients in this conversation</div>
          <div className="starters mb-6">
            {FOR_PATIENTS.map((s) => (
              <StarterButton key={s.q} q={s.q} why={s.why} onAsk={askNow} />
            ))}
          </div>
        </>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="t-label">Questions a clinician or researcher might ask</span>
        <div className="seg" role="group" aria-label="Who is asking">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === current.id}
              onClick={() => {
                setRole(r.id);
                localStorage.setItem(ROLE_KEY, r.id);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="starters" key={current.id}>
        {current.starters.map((s) => (
          <StarterButton key={s.q} q={s.q} why={s.why} onAsk={askNow} />
        ))}
      </div>
    </div>
  );

  return (
    <div ref={scroller} className="ask h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-[1480px] flex-col px-8">
        <header className="ask-hero pt-8">
          <div className="t-label">Patient 360</div>
          <h1 className="t-display mt-1 text-[40px]">{backend === 'foundry' ? 'Ask (Foundry)' : 'Ask (GHCP)'}</h1>
          <p className="t-muted mt-3 text-[15px] leading-relaxed">
            Ask {who} about one patient, several together, or all 3,554. {backend === 'foundry' ? 'The model' : 'Copilot'} reads each
            record where it lives (Epic Clarity, the PACS database, the documents lakehouse and the oncology research silos) and answers
            with the record's own views: timelines, results over time, scans with the radiologists' outlines, slides, reports and tumour
            genomes. Each answer shows the steps it took.
          </p>
          <div className="ask-meta">
            <AccountLine />
            {started && (
              <button type="button" className="chat-link" onClick={() => chat.reset('ask')}>
                New conversation
              </button>
            )}
          </div>
        </header>

        <div className={`ask-shell${historyApi.available ? '' : ' no-side'}${side ? '' : ' hs-hidden'}`}>
          {historyApi.available &&
            (side ? (
              <History
                onHide={() => toggleSide(false)}
                onOpened={(b) => b !== backend && navigate(b === 'foundry' ? '/ask/foundry' : '/ask')}
              />
            ) : (
              <button type="button" className="hs-show" title="Show your chats" onClick={() => toggleSide(true)}>
                <PanelLeft size={16} />
              </button>
            ))}
          <div className="ask-main">
            <div className="flex-1">
              <div ref={log} className="ask-log">
                {c.turns.map((t) => (
                  <div key={t.id} className="turn">
                    <div className="turn-msg">
                      <p className="turn-q">{t.question}</p>
                      {t.about && <p className="turn-ctx">{t.about}</p>}
                    </div>
                    <Answer turn={t} onAddPatients={(rows) => chat.addPatients('ask', rows)} />
                  </div>
                ))}
              </div>
              <div className={`ask-fold ${started && !showStarters ? 'is-closed' : ''}`}>
                <div className="ask-fold-in">{starters}</div>
              </div>
            </div>

            <div className="ask-dock">
              <div className="ask-dock-row">
                <PatientStrip surface="ask" />
                <div className="ask-dock-tools">
                  <ModelPicker />
                  {started && (
                    <button type="button" className="chat-link shrink-0" onClick={() => setShowStarters((v) => !v)}>
                      {showStarters ? 'Hide suggested questions' : 'Suggested questions'}
                    </button>
                  )}
                </div>
              </div>
              <Composer surface="ask" pickers={false} autoFocus onSent={() => ((stick.current = true), setShowStarters(false))} />
              <p className="ask-foot">
                For demonstration, education and research only. Every patient is synthetic or a public, de-identified research case.{' '}
                {backend === 'foundry' ? 'The model' : 'Copilot'} describes what the record shows; clinical decisions belong to the treating
                team.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
