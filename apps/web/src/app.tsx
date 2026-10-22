import { useEffect, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { PLAY_PREFERENCE_OPTIONS, PreferenceDraftSchema, TRAVEL_PREFERENCE_OPTIONS, type PreferenceDraft } from '@tripbeam/contracts';
import { createSession, generateTrip, parseIntent, sendSessionTurn } from './api/trips';
import { usePreferenceDraftStore } from './store/preference-draft';
import { ComparePage, EditorPage, SharePage } from './pages';

const DURATIONS = [60, 120, 180, 240] as const;

const summaryRows = (draft: Partial<PreferenceDraft>) => [
  ['⌖', '出发点', draft.originLabel || '从哪里开始？'],
  ['◷', '时间与时长', draft.availableMinutes ? `${draft.startTime} 开始 · ${draft.availableMinutes} 分钟` : '什么时候有空？'],
  ['✦', '游玩偏好', draft.playPreferences?.length ? draft.playPreferences.join('、') : '想玩什么？'],
  ['⇄', '出行偏好', draft.travelPreferences?.length ? draft.travelPreferences.join('、') : '愿意怎样出行？'],
] as const;

function HomePage() {
  const navigate = useNavigate();
  const persistedDraft = usePreferenceDraftStore((store) => store.draft);
  const setPersistedDraft = usePreferenceDraftStore((store) => store.setDraft);
  const [conversation, setConversation] = useState<string[]>([]);
  const [assistantMessage, setAssistantMessage] = useState('我已提取你明确表达的偏好。请核对出发条件，再生成真实路线。');
  const [collecting, setCollecting] = useState(false);
  const [showClarification, setShowClarification] = useState(false);
  const [customPlay, setCustomPlay] = useState('');
  const [notice, setNotice] = useState('');
  const [session, setSession] = useState<{ id: string; token: string }>();
  useEffect(() => { createSession().then((created) => setSession({ id: created.session.id, token: created.token })).catch(() => undefined); }, []);
  const form = useForm<PreferenceDraft>({
    resolver: zodResolver(PreferenceDraftSchema),
    mode: 'onChange',
    defaultValues: {
      originLabel: persistedDraft.originLabel ?? '',
      startTime: persistedDraft.startTime ?? '14:00',
      availableMinutes: persistedDraft.availableMinutes,
      playPreferences: persistedDraft.playPreferences ?? [],
      travelPreferences: persistedDraft.travelPreferences ?? [],
    },
  });
  const draft = form.watch();
  const missingPreferenceCount = [
    !draft.originLabel?.trim(),
    !draft.startTime || !draft.availableMinutes,
    !draft.playPreferences?.length,
    !draft.travelPreferences?.length,
  ].filter(Boolean).length;
  const preferenceComplete = missingPreferenceCount === 0;
  const preferenceMutation = useMutation({
    mutationFn: async (values: PreferenceDraft) => session
      ? (await sendSessionTurn(session.id, session.token, { turnId: crypto.randomUUID(), text: '确认这些出行条件并生成路线', action: 'confirm_preferences', preferencePatch: values })).itinerary
      : generateTrip(values),
    onSuccess: (itinerary) => {
      if (!itinerary) return;
      setPersistedDraft(itinerary.preference);
      navigate(`/compare/${itinerary.id}`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : '生成路线失败，请稍后重试。'),
  });

  function addPlayPreference(value: string) {
    const current = form.getValues('playPreferences');
    if (current.includes(value)) {
      form.setValue('playPreferences', current.filter((item) => item !== value), { shouldValidate: true });
      return;
    }
    if (current.length === 3) { setNotice('游玩偏好最多选择 3 项'); return; }
    form.setValue('playPreferences', [...current, value], { shouldValidate: true });
  }

  function addCustomPreference() {
    const value = customPlay.trim();
    if (!value) return;
    if (value.length > 20) { setNotice('自定义偏好不能超过 20 个字'); return; }
    if (form.getValues('playPreferences').includes(value)) { setNotice('这个游玩偏好已经添加'); return; }
    addPlayPreference(value); setCustomPlay('');
  }

  function toggleTravelPreference(value: (typeof TRAVEL_PREFERENCE_OPTIONS)[number]) {
    const current = form.getValues('travelPreferences');
    form.setValue('travelPreferences', current.includes(value) ? current.filter((item) => item !== value) : [...current, value], { shouldValidate: true });
  }

  function requestPreferenceField(field: 'origin' | 'time' | 'play' | 'travel') {
    setShowClarification(true);
    const targetId = field === 'origin' ? 'originLabel' : field === 'time' ? 'startTime' : field === 'play' ? 'customPlay' : 'travel-options';
    window.setTimeout(() => document.getElementById(targetId)?.focus(), 0);
  }

  async function startCollecting(text: string) {
    const trimmed = text.trim();
    if (!trimmed || collecting) return;
    setConversation((items) => [...items, trimmed]);
    setCollecting(true);
    setNotice('');
    try {
      if (session) {
        const result = await sendSessionTurn(session.id, session.token, { turnId: crypto.randomUUID(), text: trimmed });
        form.reset({ ...form.getValues(), ...result.session.preference });
        setAssistantMessage(result.message);
        if (result.itinerary) { setPersistedDraft(result.itinerary.preference); navigate(`/compare/${result.itinerary.id}`); }
        if (result.source === 'fallback') setNotice('AI 服务暂不可用，已切换为规则化兜底。');
      } else {
        const result = await parseIntent(trimmed);
        form.reset({ ...form.getValues(), ...result.preference });
        setAssistantMessage(result.message);
        if (result.source === 'fallback') setNotice('暂未能自动提取偏好，请在弹窗中确认条件。');
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : '偏好解析暂不可用，请手动补充。'); }
    finally { setCollecting(false); setShowClarification(true); }
  }

  return <div className="page-shell">
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-mark">↗</span>TripBeam</a>
      <div className="topbar-actions"><button className="location-button" type="button" onClick={() => { setShowClarification(true); setTimeout(() => document.getElementById('originLabel')?.focus(), 0); }}>⌖ 添加出发位置</button><span className="draft-state"><span className="draft-dot" />草稿已保存</span></div>
    </header>
    <main id="top" className="main-grid">
      <section className="conversation" aria-labelledby="page-title">
        <p className="eyebrow">TRIPBEAM / 城市临时出行</p>
        <h1 id="page-title">今天这几小时，<br />想怎么过？</h1>
        <p className="intro">告诉我大概从哪出发、什么时候有空，剩下的可以一起想。</p>
        <div className="chat-log" aria-live="polite">
          <ChatMessage>先用一句话说说你现在想做什么。细节不完整也没关系。</ChatMessage>
          {conversation.map((message, index) => <div className="user-message" key={`${message}-${index}`}><p>{message}</p></div>)}
          {collecting ? <ChatMessage>正在整理你的出发条件…</ChatMessage> : conversation.length > 0 ? <ChatMessage>{assistantMessage}</ChatMessage> : null}
        </div>
        <form className="composer" onSubmit={(event) => { event.preventDefault(); const text = new FormData(event.currentTarget).get('tripInput'); if (typeof text === 'string') { startCollecting(text); event.currentTarget.reset(); } }}>
          <label className="sr-only" htmlFor="tripInput">描述你的出行想法</label>
          <textarea id="tripInput" name="tripInput" rows={3} maxLength={1000} placeholder="例如：下午想吃点当地菜，顺便拍照，不想太累" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="composer-footer"><p><kbd>Enter</kbd> 发送 <span>·</span> <kbd>Shift + Enter</kbd> 换行</p><button className="send-button" type="submit" disabled={collecting}>{collecting ? '正在整理…' : <>开始梳理 <span>↑</span></>}</button></div>
        </form>
        <div className="examples">{['想吃点当地的', '想散步拍照', '不想赶路'].map((example) => <button key={example} type="button" onClick={() => { const input = document.getElementById('tripInput') as HTMLTextAreaElement | null; if (input) { input.value = example; input.focus(); } }}>{example}</button>)}</div>
        {showClarification && <div className="modal-backdrop clarification-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowClarification(false); }}><section className="clarify clarification-dialog" role="dialog" aria-modal="true" aria-labelledby="clarify-title">
          <div className="clarify-heading"><span className="avatar">T</span><div><p className="overline">{preferenceComplete ? '已补充完整' : `还差 ${missingPreferenceCount} 项`}</p><h2 id="clarify-title">{preferenceComplete ? '出发条件已齐全，可以继续规划' : '补充这几项，就能继续规划'}</h2></div><button type="button" className="dialog-close" aria-label="关闭补充偏好" onClick={() => setShowClarification(false)}>×</button></div>
          <form onSubmit={form.handleSubmit((values) => preferenceMutation.mutate(values))}>
            <div className="question-grid">
              <fieldset className="question-card"><legend><span className="question-number">01</span>从哪里出发？</legend><p>用来将范围控制在附近。</p><label className="field-label" htmlFor="originLabel">地点、酒店或地标</label><input id="originLabel" placeholder="例如：成都春熙路" {...form.register('originLabel')} /><button className="text-button" type="button" onClick={() => { setNotice('请直接输入附近的地址或地标，以便地图服务精确定位。'); document.getElementById('originLabel')?.focus(); }}>⌖ 输入当前附近地标</button></fieldset>
              <fieldset className="question-card"><legend><span className="question-number">02</span>什么时候，有多久？</legend><p>最多可规划 4 小时。</p><label className="field-label" htmlFor="startTime">开始时间</label><input id="startTime" type="time" {...form.register('startTime')} /><div className="duration-options">{DURATIONS.map((duration) => <button key={duration} type="button" className={draft.availableMinutes === duration ? 'is-selected' : ''} onClick={() => form.setValue('availableMinutes', duration, { shouldValidate: true })}>{duration / 60} 小时</button>)}</div></fieldset>
              <fieldset className="question-card interest-card"><legend><span className="question-number">03</span>你的偏好</legend>
                <PreferenceHeading title="游玩偏好" description="选择 1–3 项，也可以添加自己的想法。" />
                <div className="interest-options">{PLAY_PREFERENCE_OPTIONS.map((option) => <button key={option} type="button" className={draft.playPreferences?.includes(option) ? 'is-selected' : ''} onClick={() => addPlayPreference(option)}>{option}</button>)}</div>
                <div className="custom-preference"><label className="sr-only" htmlFor="customPlay">添加自定义游玩偏好</label><input id="customPlay" value={customPlay} onChange={(event) => setCustomPlay(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomPreference(); } }} placeholder="例如：看日落、逛书店" /><button type="button" onClick={addCustomPreference}>添加</button></div>
                <div className="custom-tags">{draft.playPreferences?.filter((item) => !PLAY_PREFERENCE_OPTIONS.includes(item as (typeof PLAY_PREFERENCE_OPTIONS)[number])).map((item) => <span className="custom-tag" key={item}>{item}<button type="button" aria-label={`删除 ${item}`} onClick={() => addPlayPreference(item)}>×</button></span>)}</div>
                <div className="travel-group"><PreferenceHeading title="出行偏好" description="选择你愿意使用的方式，可多选。" /><div id="travel-options" className="travel-options">{TRAVEL_PREFERENCE_OPTIONS.map((option) => <button key={option} type="button" className={draft.travelPreferences?.includes(option) ? 'is-selected' : ''} onClick={() => toggleTravelPreference(option)}>{option}</button>)}</div></div>
              </fieldset>
            </div>
            <div className="clarify-actions"><p>{preferenceComplete ? '提交后将查询真实地点与路网，再由规则引擎校验路线。' : '请先补充出发点、时长、游玩偏好和出行偏好。'}</p><button className="primary-button" type="submit" disabled={!preferenceComplete || preferenceMutation.isPending}>{preferenceMutation.isPending ? '正在生成路线…' : <>继续规划 <span>→</span></>}</button></div>
          </form>
        </section></div>}
      </section>
      <SummaryPanel draft={draft} isComplete={preferenceComplete} isCollecting={showClarification} onRequestField={requestPreferenceField} />
    </main>
    {notice && <div className="toast show" role="status">{notice}</div>}
  </div>;
}

export function App() { return <Routes><Route path="/" element={<HomePage />} /><Route path="/compare/:itineraryId" element={<ComparePage />} /><Route path="/editor/:itineraryId/:routeId" element={<EditorPage />} /><Route path="/share/:token" element={<SharePage />} /><Route path="*" element={<HomePage />} /></Routes>; }

function ChatMessage({ children }: { children: ReactNode }) { return <div className="assistant-message"><span className="avatar">T</span><p>{children}</p></div>; }
function PreferenceHeading({ title, description }: { title: string; description: string }) { return <div className="preference-group-heading"><div><h3>{title}</h3><p>{description}</p></div><span>必填</span></div>; }
function SummaryPanel({ draft, isComplete, isCollecting, onRequestField }: { draft: Partial<PreferenceDraft>; isComplete: boolean; isCollecting: boolean; onRequestField: (field: 'origin' | 'time' | 'play' | 'travel') => void }) { const rows = summaryRows(draft); const pendingHints = ['从哪里开始？', '什么时候有空？', '想玩什么？', '愿意怎样出行？']; const confirmed = rows.filter(([, , description]) => !pendingHints.includes(description)); const pending = rows.filter(([, , description]) => pendingHints.includes(description)); const fieldByTitle = { '出发点': 'origin', '时间与时长': 'time', '游玩偏好': 'play', '出行偏好': 'travel' } as const; return <aside className="preference-panel"><div className="summary-header"><div><p className="overline">你的出行偏好</p><h2>此刻已听懂什么</h2></div><span className={`summary-status ${isComplete ? 'complete' : ''}`}>{isComplete ? '已补充完整' : isCollecting ? '补充中' : '待补充'}</span></div><div className="summary-section"><h3>已确认</h3><ul>{confirmed.length ? confirmed.map(([icon, title, description]) => <li className="confirmed-item" key={title}><span className="summary-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div><span className="chevron">✓</span></li>) : <li className="empty-item">还没有确认的信息</li>}</ul></div><div className="summary-section pending"><h3>待确认</h3><ul>{pending.map(([icon, title, description]) => <li key={title}><button type="button" onClick={() => onRequestField(fieldByTitle[title])}><span className="summary-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div><span className="chevron">›</span></button></li>)}</ul></div><div className="summary-note"><span>i</span><p>路线、时间与距离会在规则引擎校验后显示。本页仅收集你的出发条件。</p></div></aside>; }
