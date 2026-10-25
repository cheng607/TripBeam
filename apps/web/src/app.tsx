import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { PLAY_PREFERENCE_OPTIONS, TRAVEL_PREFERENCE_OPTIONS, type PreferenceExtraction, type TurnResult } from '@tripbeam/contracts';
import { createSession, parseIntent, sendSessionTurn } from './api/trips';
import { usePreferenceDraftStore } from './store/preference-draft';
import { ComparePage, EditorPage, SharePage } from './pages';

type SessionIdentity = { id: string; token: string };
type RequiredField = 'originLabel' | 'startTime' | 'availableMinutes' | 'playPreferences' | 'travelPreferences';
type TravelPreference = (typeof TRAVEL_PREFERENCE_OPTIONS)[number];
const DURATIONS = [60, 120, 180, 240] as const;
const questions: Record<RequiredField, { title: string; description: string }> = {
  originLabel: { title: '你从哪里出发？', description: '填写附近的地标、商场、酒店或地址即可。' },
  startTime: { title: '准备几点出发？', description: '选择预计开始时间，我会据此安排每个停靠点。' },
  availableMinutes: { title: '这次大概有多久？', description: '选择可用时长，最多规划 4 小时。' },
  playPreferences: { title: '这次更想做什么？', description: '选择 1–3 项；模型会将其作为地点筛选方向。' },
  travelPreferences: { title: '愿意怎样出行？', description: '可多选，我会按实际路网校验路线。' },
};

function HomePage() {
  const navigate = useNavigate();
  const persistedDraft = usePreferenceDraftStore((store) => store.draft);
  const setPersistedDraft = usePreferenceDraftStore((store) => store.setDraft);
  const [session, setSession] = useState<SessionIdentity>();
  const [draft, setDraft] = useState<PreferenceExtraction>(persistedDraft);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([{ role: 'assistant', text: '说说你这次想怎么逛吧。信息不完整也没关系，我会逐项确认后再生成路线。' }]);
  const [missingFields, setMissingFields] = useState<RequiredField[]>([]);
  const [input, setInput] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [notice, setNotice] = useState('');
  const activeField = missingFields[0];

  useEffect(() => { createSession().then((created) => setSession({ id: created.session.id, token: created.token })).catch(() => undefined); }, []);
  const selectedPlay = useMemo(() => draft.playPreferences ?? [], [draft.playPreferences]);
  const selectedTravel = useMemo<TravelPreference[]>(() => draft.travelPreferences ?? [], [draft.travelPreferences]);

  function applyTurn(result: TurnResult) {
    setDraft(result.session.preference);
    setMissingFields(result.missingFields.filter((field): field is RequiredField => field in questions));
    if (result.itinerary) { setPersistedDraft(result.itinerary.preference); navigate(`/compare/${result.itinerary.id}`); return; }
    setMessages((items) => [...items, { role: 'assistant', text: result.message }]);
    if (result.source === 'fallback') setNotice('模型暂不可用，已使用本地规则继续收集信息。');
  }
  async function ensureSession(): Promise<SessionIdentity> {
    if (session) return session;
    const created = await createSession(); const identity = { id: created.session.id, token: created.token };
    setSession(identity); return identity;
  }
  async function sendText(text: string) {
    const trimmed = text.trim(); if (!trimmed || collecting) return;
    setMessages((items) => [...items, { role: 'user', text: trimmed }]); setInput(''); setCollecting(true); setNotice('');
    try { const identity = await ensureSession(); applyTurn(await sendSessionTurn(identity.id, identity.token, { turnId: crypto.randomUUID(), text: trimmed })); }
    catch (error) {
      try {
        const fallback = await parseIntent(trimmed);
        setDraft((current) => ({ ...current, ...fallback.preference }));
        setMissingFields(fallback.missingFields.filter((field): field is RequiredField => field in questions));
        setMessages((items) => [...items, { role: 'assistant', text: fallback.message }]);
      } catch { setNotice(error instanceof Error ? error.message : '暂时无法解析你的想法，请稍后再试。'); }
    } finally { setCollecting(false); }
  }
  async function answerField(patch: PreferenceExtraction, displayText: string) {
    if (collecting) return;
    setMessages((items) => [...items, { role: 'user', text: displayText }]); setCollecting(true); setNotice(''); setFieldValue('');
    try {
      const identity = await ensureSession();
      applyTurn(await sendSessionTurn(identity.id, identity.token, { turnId: crypto.randomUUID(), text: displayText, action: 'confirm_preferences', preferencePatch: patch }));
    } catch (error) { setNotice(error instanceof Error ? error.message : '提交失败，请再试一次。'); }
    finally { setCollecting(false); }
  }
  const toggle = (field: 'playPreferences' | 'travelPreferences', value: string) => {
    const current = draft[field] ?? []; const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    if (field === 'playPreferences' && next.length > 3) { setNotice('游玩偏好最多选 3 项。'); return; }
    setDraft((state) => ({ ...state, [field]: next }));
  };
  return <div className="page-shell conversation-shell">
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark">↗</span>TripBeam</a><span className="draft-state"><span className="draft-dot" />对话会话已建立</span></header>
    <main id="top" className="conversation-flow" aria-labelledby="page-title">
      <p className="eyebrow">TRIPBEAM / 城市临时出行</p><h1 id="page-title">今天这几小时，<br />想怎么过？</h1><p className="intro">先随便说一句。模型只会追问真正缺少的出发条件，不再要求你填写整张偏好表。</p>
      <div className="chat-log" aria-live="polite">{messages.map((message, index) => message.role === 'assistant' ? <ChatMessage key={`${message.text}-${index}`}>{message.text}</ChatMessage> : <div className="user-message" key={`${message.text}-${index}`}><p>{message.text}</p></div>)}{collecting && <ChatMessage>正在检查已知信息，并准备下一项问题…</ChatMessage>}</div>
      {activeField && <ClarificationCard field={activeField} selectedPlay={selectedPlay} selectedTravel={selectedTravel} fieldValue={fieldValue} setFieldValue={setFieldValue} onToggle={toggle} onAnswer={answerField} disabled={collecting} />}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendText(input); }}><label className="sr-only" htmlFor="tripInput">描述你的出行想法</label><textarea id="tripInput" value={input} onChange={(event) => setInput(event.target.value)} rows={3} maxLength={1000} placeholder={activeField ? '也可以直接补充更多要求，例如：不想走太远、想逛书店' : '例如：下午从光谷出发，想喝咖啡散步，两个小时，步行'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="composer-footer"><p><kbd>Enter</kbd> 发送 <span>·</span> <kbd>Shift + Enter</kbd> 换行</p><button className="send-button" type="submit" disabled={collecting || !input.trim()}>{collecting ? '正在检查…' : <>发送 <span>↑</span></>}</button></div></form>
      {!activeField && messages.length === 1 && <div className="examples">{['下午从光谷出发，想喝咖啡散步，两个小时，步行', '今晚想吃当地菜，顺便拍照，不想太累', '我在春熙路附近，三小时，打车也可以'].map((example) => <button key={example} type="button" onClick={() => setInput(example)}>{example}</button>)}</div>}
    </main>{notice && <div className="toast show" role="status">{notice}</div>}
  </div>;
}

function ClarificationCard({ field, selectedPlay, selectedTravel, fieldValue, setFieldValue, onToggle, onAnswer, disabled }: { field: RequiredField; selectedPlay: string[]; selectedTravel: TravelPreference[]; fieldValue: string; setFieldValue: (value: string) => void; onToggle: (field: 'playPreferences' | 'travelPreferences', value: string) => void; onAnswer: (patch: PreferenceExtraction, displayText: string) => void; disabled: boolean }) {
  const question = questions[field]; const submitText = field === 'originLabel' ? fieldValue.trim() : field === 'startTime' ? fieldValue : '';
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (submitText) void onAnswer({ [field]: submitText }, submitText); };
  return <section className="clarify step-question" aria-labelledby="clarify-title"><div className="clarify-heading"><span className="avatar">T</span><div><p className="overline">需要确认 1 项</p><h2 id="clarify-title">{question.title}</h2><p>{question.description}</p></div></div>
    {(field === 'originLabel' || field === 'startTime') && <form className="step-answer" onSubmit={submit}><input aria-label={question.title} autoFocus={field === 'originLabel'} type={field === 'startTime' ? 'time' : 'text'} value={fieldValue} onChange={(event) => setFieldValue(event.target.value)} placeholder={field === 'originLabel' ? '例如：武汉光谷广场' : undefined} /><button className="primary-button" type="submit" disabled={disabled || !submitText}>确认</button></form>}
    {field === 'availableMinutes' && <div className="duration-options step-options">{DURATIONS.map((duration) => <button key={duration} type="button" disabled={disabled} onClick={() => void onAnswer({ availableMinutes: duration }, `${duration / 60} 小时`)}>{duration / 60} 小时</button>)}</div>}
    {field === 'playPreferences' && <><div className="interest-options step-options">{PLAY_PREFERENCE_OPTIONS.map((option) => <button key={option} type="button" className={selectedPlay.includes(option) ? 'is-selected' : ''} disabled={disabled} onClick={() => onToggle('playPreferences', option)}>{option}</button>)}</div><button className="primary-button step-confirm" type="button" disabled={disabled || !selectedPlay.length} onClick={() => void onAnswer({ playPreferences: selectedPlay }, selectedPlay.join('、'))}>确认偏好</button></>}
    {field === 'travelPreferences' && <><div className="travel-options step-options">{TRAVEL_PREFERENCE_OPTIONS.map((option) => <button key={option} type="button" className={selectedTravel.includes(option) ? 'is-selected' : ''} disabled={disabled} onClick={() => onToggle('travelPreferences', option)}>{option}</button>)}</div><button className="primary-button step-confirm" type="button" disabled={disabled || !selectedTravel.length} onClick={() => void onAnswer({ travelPreferences: selectedTravel }, selectedTravel.join('、'))}>确认出行方式</button></>}</section>;
}

export function App() { return <Routes><Route path="/" element={<HomePage />} /><Route path="/compare/:itineraryId" element={<ComparePage />} /><Route path="/editor/:itineraryId/:routeId" element={<EditorPage />} /><Route path="/share/:token" element={<SharePage />} /><Route path="*" element={<HomePage />} /></Routes>; }
function ChatMessage({ children }: { children: ReactNode }) { return <div className="assistant-message"><span className="avatar">T</span><p>{children}</p></div>; }
