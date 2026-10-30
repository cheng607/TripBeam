import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { PLAY_PREFERENCE_OPTIONS, TRAVEL_PREFERENCE_OPTIONS, PreferenceExtractionSchema, type AgentSession, type PreferenceExtraction, type TurnResult } from '@tripbeam/contracts';
import { ComparePage, EditorPage, SharePage } from './pages';
import { PlannerJourney, PreferenceSummary } from './planner-ui';
import { ensureAgentSession, forgetAgentSession, readCachedAgentSession, sendAgentTurn, sessionMessages, type AgentTurn } from './agent-session';

type RequiredField = 'originLabel' | 'startTime' | 'availableMinutes' | 'playPreferences' | 'travelPreferences';
type TravelPreference = (typeof TRAVEL_PREFERENCE_OPTIONS)[number];
const DURATIONS = [30, 60, 120, 180, 240] as const;
const questions: Record<RequiredField, { title: string; description: string }> = {
  originLabel: { title: '你从哪里出发？', description: '城市加地标更准确，比如「武汉光谷广场」或酒店的完整名称。' },
  startTime: { title: '准备几点出发？', description: '选择预计开始时间，用来安排每一站的到达和停留。' },
  availableMinutes: { title: '留给这次出行多久？', description: '适合 30 分钟到 4 小时的城市短途探索。' },
  playPreferences: { title: '这次更想体验什么？', description: '选择 1–3 项；其他想法也可以在对话中补充。' },
  travelPreferences: { title: '愿意怎样出行？', description: '可多选。我们会用这些方式的路网数据检查时间和距离。' },
};
const requiredFields = Object.keys(questions) as RequiredField[];
function missingPreference(preference: PreferenceExtraction): RequiredField[] {
  return requiredFields.filter((field) => { const value = preference[field]; return value === undefined || (Array.isArray(value) && value.length === 0); });
}

function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const adjustment = useRef(PreferenceExtractionSchema.safeParse(location.state?.preference));
  const adjustedPreference = adjustment.current.success ? adjustment.current.data : undefined;
  const initial = useRef(readCachedAgentSession());
  const [session, setSession] = useState<AgentSession | undefined>(initial.current?.session);
  const [draft, setDraft] = useState<PreferenceExtraction>(adjustedPreference ?? initial.current?.session.preference ?? {});
  const [messages, setMessages] = useState(sessionMessages(initial.current?.session));
  const [missingFields, setMissingFields] = useState<RequiredField[]>(initial.current ? missingPreference(initial.current.session.preference) : []);
  const [editingField, setEditingField] = useState<RequiredField | undefined>(adjustedPreference ? 'originLabel' : undefined);
  const [input, setInput] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(initial.current));
  const [notice, setNotice] = useState('');
  const [failedTurn, setFailedTurn] = useState<AgentTurn>();
  const [steps, setSteps] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const inFlight = useRef(false);
  const activeField = editingField ?? missingFields[0];
  const busy = collecting || restoring;

  useEffect(() => {
    if (!initial.current) return;
    let active = true;
    ensureAgentSession().then(({ session: restored }) => {
      if (!active) return;
      setSession(restored); if (!adjustedPreference) setDraft(restored.preference); setMessages(sessionMessages(restored));
      setMissingFields(missingPreference(restored.preference));
      if (restored.id !== initial.current?.session.id) setNotice('上次会话已过期，已建立新会话。请重新确认出行条件。');
    }).catch((error) => { if (active) setNotice(error instanceof Error ? error.message : '会话暂时无法恢复。'); }).finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!collecting) { setElapsed(0); return; }
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [collecting]);
  useEffect(() => {
    const value = activeField ? draft[activeField] : undefined;
    setFieldValue(typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  }, [activeField]);

  function applyTurn(result: TurnResult) {
    setSession(result.session); setDraft(result.session.preference); setMessages(sessionMessages(result.session));
    setMissingFields(result.missingFields.filter((field): field is RequiredField => field in questions)); setEditingField(undefined); setSteps(result.steps);
    if (result.source === 'fallback') setNotice('智能理解暂不可用，已用规则继续处理。你也可以点选条件完成规划。');
    if (result.itinerary) navigate(`/compare/${result.itinerary.id}`);
  }
  async function submitTurn(body: AgentTurn, retry = false) {
    if (inFlight.current || restoring) return;
    inFlight.current = true; setCollecting(true); setNotice(''); setFailedTurn(undefined);
    if (!retry) setMessages((items) => [...items, { role: 'user', text: body.text }]);
    try { applyTurn(await sendAgentTurn(body)); setInput(''); }
    catch (error) {
      setNotice(error instanceof Error ? error.message : '暂时无法完成这次请求。你的输入已保留。'); setFailedTurn(body);
    } finally { inFlight.current = false; setCollecting(false); }
  }
  function sendText(text: string) {
    if (!text.trim()) return;
    void submitTurn({ turnId: crypto.randomUUID(), text: text.trim() });
  }
  function answerField(patch: PreferenceExtraction, displayText: string) {
    const next = { ...draft, ...patch }; setDraft(next);
    void submitTurn({ turnId: crypto.randomUUID(), text: displayText, action: 'confirm_preferences', preferencePatch: next });
  }
  function editField(field: keyof PreferenceExtraction) {
    if (busy || !(field in questions)) return;
    const key = field as RequiredField; setEditingField(key);
    const value = draft[key]; setFieldValue(typeof value === 'string' || typeof value === 'number' ? String(value) : '');
    requestAnimationFrame(() => document.getElementById('clarify-title')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
  const toggle = (field: 'playPreferences' | 'travelPreferences', value: string) => {
    const current: string[] = draft[field] ?? []; const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    if (field === 'playPreferences' && next.length > 3) { setNotice('游玩偏好最多选择 3 项。'); return; }
    setDraft((state) => ({ ...state, [field]: next }));
  };
  const startNew = () => {
    if (busy) return;
    forgetAgentSession(); setSession(undefined); setDraft({}); setMessages(sessionMessages()); setMissingFields([]); setEditingField(undefined); setInput(''); setNotice(''); setSteps([]); setFailedTurn(undefined);
  };
  return <div className="page-shell conversation-shell">
    <header className="topbar"><Link className="brand" to="/" aria-label="TripBeam 城市旅行规划"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="26" cy="12" r="6.5" fill="#f2c653"/><path d="M7 29.5c5.1 0 6.4-9.2 12-9.2s6.2 8.2 13.5 8.2" fill="none" stroke="#27866f" strokeWidth="3.4" strokeLinecap="round"/><circle cx="7" cy="29.5" r="2.8" fill="#e97849"/><circle cx="32.5" cy="28.5" r="2.8" fill="#4d91b8"/></svg></span><span className="brand-wordmark"><strong>Trip</strong>Beam</span></Link><div className="topbar-actions"><span className="draft-state">{restoring ? '正在恢复对话…' : collecting ? '旅行助手正在处理…' : session ? '本次对话已保留' : '你的城市旅行助手'}</span>{session && <button className="secondary-button" type="button" disabled={busy} onClick={startNew}>新的规划</button>}</div></header>
    <PlannerJourney step={0} itineraryId={session?.itineraryId} />
    <main id="top" className="planner-layout" aria-labelledby="page-title">
      <section className="planner-main conversation-flow">
        <p className="eyebrow">A LITTLE TIME. A NEW CITY.</p><h1 id="page-title">空出几小时，<br />遇见一座城。</h1><p className="intro">把模糊的想法交给我，一起找到适合你的城市路线。可比较、可调整，准备好就出发。</p>
        <figure className="sunlit-scene" aria-label="晴日里的江岸散步：桥、树影和城市天际线"><svg viewBox="0 0 760 210" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sunlit-sky" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#d8eff1"/><stop offset="1" stopColor="#f6f2dc"/></linearGradient></defs><rect width="760" height="210" fill="url(#sunlit-sky)"/><circle cx="638" cy="43" r="25" fill="#f5c95e"/><path d="M0 136 Q130 125 245 139 T475 132 T760 139 V210 H0Z" fill="#9bcfc2"/><path d="M0 157 Q120 143 247 155 T496 149 T760 156 V210 H0Z" fill="#b9e0d8"/><path d="M0 133 L0 78 34 78 34 133 M43 133 V54 H88 V133 M98 133 V89 H145 V133 M155 133 V67 H205 V133 M216 133 V101 H255 V133 M274 133 V47 H322 V133 M332 133 V78 H371 V133 M382 133 V98 H425 V133 M439 133 V61 H491 V133 M501 133 V83 H542 V133" fill="#8eb9ae"/><path d="M35 78h8 M43 54v79 M155 67h8 M274 47h8 M439 61h8" stroke="#f7f4e8" strokeWidth="4" opacity=".8"/><path d="M0 141 H760" stroke="#fff9e6" strokeWidth="3" opacity=".75"/><path d="M0 183 Q100 165 202 180 T400 177 T604 181 T760 172" fill="none" stroke="#f8f4e4" strokeWidth="14"/><path d="M0 180 Q100 163 202 177 T400 173 T604 177 T760 168" fill="none" stroke="#e87d53" strokeWidth="3" strokeDasharray="2 8" strokeLinecap="round"/><path d="M565 134 Q625 101 685 134" fill="none" stroke="#668f86" strokeWidth="5"/><path d="M565 134v14 M685 134v14 M581 125v23 M669 125v23" stroke="#668f86" strokeWidth="3"/><g fill="#438b72"><circle cx="83" cy="128" r="13"/><circle cx="112" cy="126" r="17"/><circle cx="355" cy="128" r="12"/><circle cx="385" cy="127" r="17"/></g><path d="M98 128v20 M370 128v20" stroke="#9b7552" strokeWidth="5"/><rect x="18" y="17" width="139" height="25" rx="12" fill="#fffdf5" opacity=".9"/><text x="31" y="34" fill="#3f7466" fontSize="12" fontFamily="sans-serif">江边走走 · 约 2 小时</text></svg><figcaption><span>沿着水岸，慢慢走</span><span>城市的一小段晴天</span></figcaption></figure>
        {session?.itineraryId && <div className="resume-trip"><span>上次的路线还在，继续编辑或聊聊新的想法。</span><Link to={`/compare/${session.itineraryId}`}>继续查看方案 ↗</Link></div>}
        <div className="chat-log" role="log" aria-label="规划对话" aria-live="polite">{messages.map((message, index) => message.role === 'assistant' ? <ChatMessage key={index}>{message.text}</ChatMessage> : <div className="user-message" key={index}><p>{message.text}</p></div>)}</div>
        {collecting && <div className="planning-status" role="status"><span className="loading-orbit" /><div><strong>正在理解需求与检查规划条件{elapsed > 0 ? ` · ${elapsed} 秒` : ''}</strong><p>{elapsed >= 15 ? '地点和路网查询需要一些时间，请保持页面打开。' : '信息不足时会继续补问，条件完整后会查找地点并编排行程。'}</p></div></div>}
        {activeField && <ClarificationCard field={activeField} selectedPlay={draft.playPreferences ?? []} selectedTravel={draft.travelPreferences ?? []} selectedCustom={draft.customPreferences ?? []} onCustomChange={(customPreferences) => setDraft((state) => ({ ...state, customPreferences }))} fieldValue={fieldValue} setFieldValue={setFieldValue} onToggle={toggle} onAnswer={answerField} disabled={busy} />}
        {notice && <div className="inline-alert home-notice" role="status"><p>{notice}</p>{failedTurn && <button className="secondary-button" type="button" disabled={busy} onClick={() => void submitTurn(failedTurn, true)}>重试这次请求</button>}</div>}
        {session && ['no_route', 'error'].includes(session.phase) && !failedTurn && <button className="secondary-button" type="button" disabled={busy} onClick={() => void submitTurn({ turnId: crypto.randomUUID(), text: '按已确认的条件重新规划', action: 'regenerate', preferencePatch: draft })}>按这些条件重新尝试</button>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); sendText(input); }}>
          <label className="sr-only" htmlFor="tripInput">描述你的出行想法</label><textarea id="tripInput" value={input} disabled={busy} onChange={(event) => setInput(event.target.value)} rows={3} maxLength={1000} placeholder={activeField ? '继续补充，比如：不想走太远，想去有特色的书店…' : '例如：下午两点从武汉光谷广场出发，想喝咖啡散步，两个小时，步行…'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="composer-footer"><p><kbd>Enter</kbd> 发送 <span>·</span> <kbd>Shift + Enter</kbd> 换行</p><button className="send-button" type="submit" disabled={busy || !input.trim()}>{collecting ? '正在处理…' : <>开始聊聊 <span>↑</span></>}</button></div>
        </form>
        {messages.length <= 1 && !activeField && <><div className="examples">{['下午两点从武汉光谷广场出发，想喝咖啡散步，两个小时，步行', '今晚想吃当地菜，顺便拍照，不想太累', '我在成都春熙路附近，三小时，打车也可以'].map((example, index) => <button key={example} type="button" disabled={busy} onClick={() => { setInput(example); document.getElementById('tripInput')?.focus(); }}>{['☕ 咖啡与城市漫步', '◒ 美食与夜色', '⌖ 随性探索新城市'][index]}</button>)}</div><button className="text-button manual-entry" disabled={busy} type="button" onClick={() => setMissingFields(missingPreference(draft))}>也可以直接选择出行条件 →</button></>}
        {!collecting && steps.length > 0 && <details className="processing-record"><summary>查看刚才的处理记录</summary><ol>{steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></details>}
      </section>
      <aside className="planner-sidebar"><PreferenceSummary preference={draft} onEdit={busy ? undefined : editField} /><section className="agent-guide"><p className="overline">从想法到出发</p><h2>一起完成这次小旅行</h2><ol><li><strong>理解你的想法</strong><p>确认出发点、可用时间和偏好。</p></li><li><strong>找到适合的路线</strong><p>筛选地点，比较不同体验和取舍。</p></li><li><strong>调整到刚刚好</strong><p>更换地点与顺序，再检查时间和路网。</p></li><li><strong>带上行程出发</strong><p>保存方案，分享一份清晰的行程。</p></li></ol><p className="guide-note">路线时长为规划估计。营业、预约和现场情况请在出发前确认。</p></section></aside>
    </main>
  </div>;
}

function ClarificationCard({ field, selectedPlay, selectedTravel, selectedCustom, onCustomChange, fieldValue, setFieldValue, onToggle, onAnswer, disabled }: { field: RequiredField; selectedPlay: string[]; selectedTravel: TravelPreference[]; selectedCustom: string[]; onCustomChange: (value: string[]) => void; fieldValue: string; setFieldValue: (value: string) => void; onToggle: (field: 'playPreferences' | 'travelPreferences', value: string) => void; onAnswer: (patch: PreferenceExtraction, displayText: string) => void; disabled: boolean }) {
  const [customDraft, setCustomDraft] = useState(selectedCustom.join('，'));
  useEffect(() => setCustomDraft(selectedCustom.join('，')), [field]);
  const question = questions[field]; const submitText = field === 'originLabel' ? fieldValue.trim() : field === 'startTime' ? fieldValue : '';
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (submitText) onAnswer({ [field]: submitText }, `${field === 'originLabel' ? '从这里出发' : '出发时间'}：${submitText}`); };
  const duration = Number(fieldValue);
  const parseCustom = (value: string) => [...new Set(value.split(/[，,、]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 5).map((item) => item.slice(0, 30));
  return <section className="clarify step-question" aria-labelledby="clarify-title"><div className="clarify-heading"><span className="avatar">T</span><div><p className="overline">确认出行条件</p><h2 id="clarify-title">{question.title}</h2><p>{question.description}</p></div></div>
    {(field === 'originLabel' || field === 'startTime') && <form className="step-answer" onSubmit={submit}><input aria-label={question.title} disabled={disabled} required maxLength={120} type={field === 'startTime' ? 'time' : 'text'} value={fieldValue} onChange={(event) => setFieldValue(event.target.value)} placeholder={field === 'originLabel' ? '例如：武汉光谷广场' : undefined} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} /><button className="primary-button" type="submit" disabled={disabled || !submitText}>确认{field === 'originLabel' ? '出发点' : '时间'}</button></form>}
    {field === 'availableMinutes' && <><div className="duration-options step-options">{DURATIONS.map((option) => <button key={option} type="button" aria-pressed={duration === option} className={duration === option ? 'is-selected' : ''} disabled={disabled} onClick={() => setFieldValue(String(option))}>{option < 60 ? `${option} 分钟` : `${option / 60} 小时`}</button>)}</div><form className="custom-duration-form" onSubmit={(event) => { event.preventDefault(); if (Number.isInteger(duration) && duration >= 30 && duration <= 240) onAnswer({ availableMinutes: duration }, `可用时间：${duration < 60 ? `${duration} 分钟` : `${Math.floor(duration / 60)} 小时${duration % 60 ? ` ${duration % 60} 分钟` : ''}`}`); }}><label>也可以自定义时长 <span>30–240 分钟</span></label><div><input aria-label="自定义可用时长（分钟）" type="number" min={30} max={240} step={1} required value={fieldValue} onChange={(event) => setFieldValue(event.target.value)} disabled={disabled} /><button className="primary-button" type="submit" disabled={disabled || !Number.isInteger(duration) || duration < 30 || duration > 240}>确认时长</button></div></form></>}
    {field === 'playPreferences' && <><div className="interest-options step-options">{[...new Set([...PLAY_PREFERENCE_OPTIONS, ...selectedPlay])].map((option) => <button key={option} type="button" aria-pressed={selectedPlay.includes(option)} className={selectedPlay.includes(option) ? 'is-selected' : ''} disabled={disabled} onClick={() => onToggle('playPreferences', option)}>{option}</button>)}</div><label className="custom-preference-field">自定义想体验的内容 <span>可用逗号分隔，最多 5 项</span><input aria-label="自定义游玩偏好" maxLength={160} value={customDraft} disabled={disabled} placeholder="例如：独立书店、江边日落、安静咖啡馆" onChange={(event) => { setCustomDraft(event.target.value); onCustomChange(parseCustom(event.target.value)); }} /></label><button className="primary-button step-confirm" type="button" disabled={disabled || (!selectedPlay.length && !parseCustom(customDraft).length)} onClick={() => { const customPreferences = parseCustom(customDraft); onCustomChange(customPreferences); onAnswer({ playPreferences: selectedPlay, customPreferences }, `想体验：${[...selectedPlay, ...customPreferences].join('、')}`); }}>确认游玩偏好</button></>}
    {field === 'travelPreferences' && <><div className="travel-options step-options">{TRAVEL_PREFERENCE_OPTIONS.map((option) => <button key={option} type="button" aria-pressed={selectedTravel.includes(option)} className={selectedTravel.includes(option) ? 'is-selected' : ''} disabled={disabled} onClick={() => onToggle('travelPreferences', option)}>{option}</button>)}</div><button className="primary-button step-confirm" type="button" disabled={disabled || !selectedTravel.length} onClick={() => onAnswer({ travelPreferences: selectedTravel }, `出行方式：${selectedTravel.join('、')}`)}>确认出行方式</button></>}</section>;
}

export function App() { return <Routes><Route path="/" element={<HomePage />} /><Route path="/compare/:itineraryId" element={<ComparePage />} /><Route path="/editor/:itineraryId/:routeId" element={<EditorPage />} /><Route path="/share/:token" element={<SharePage />} /><Route path="*" element={<HomePage />} /></Routes>; }
function ChatMessage({ children }: { children: ReactNode }) { return <div className="assistant-message"><span className="avatar" aria-hidden="true">T</span><p>{children}</p></div>; }
