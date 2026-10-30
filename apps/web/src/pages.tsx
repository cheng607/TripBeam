import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EditCommand, Itinerary, Place, TripRoute } from '@tripbeam/contracts';
import { createShare, editTrip, getAlternatives, getShare, getTrip, restoreTrip, saveTrip } from './api/trips';
import { MapCanvas } from './map-canvas';
import { PoiChoice } from './poi-choice';
import { routeColor } from './route-colors';
import { AgentActions } from './agent-actions';
import { PlannerJourney, clockTime, formatMinutes, riskLabel } from './planner-ui';
import { navigationUrl } from './navigation';

type EditWithoutVersion = EditCommand extends infer Command ? Command extends EditCommand ? Omit<Command, 'baseVersion'> : never : never;
type Notice = { text: string; kind: 'success' | 'error' };

function AppHeader() {
  return <header className="app-header"><Link to="/" className="brand" aria-label="TripBeam 城市旅行规划"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="26" cy="12" r="6.5" fill="#f2c653"/><path d="M7 29.5c5.1 0 6.4-9.2 12-9.2s6.2 8.2 13.5 8.2" fill="none" stroke="#27866f" strokeWidth="3.4" strokeLinecap="round"/><circle cx="7" cy="29.5" r="2.8" fill="#e97849"/><circle cx="32.5" cy="28.5" r="2.8" fill="#4d91b8"/></svg></span><span className="brand-wordmark"><strong>Trip</strong>Beam</span><span className="brand-caption">城市旅行规划</span></Link><Link className="header-new-trip" to="/">规划一次出发 ↗</Link></header>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function Loading({ text = '正在读取行程…' }: { text?: string }) { return <div className="app-shell"><AppHeader /><main className="state-page" role="status"><span className="loading-orbit" /><h1>{text}</h1><p>即将展示地点清单、路线安排和出行提示。</p></main></div>; }
function Failed({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div className="app-shell"><AppHeader /><main className="state-page" role="alert"><p className="eyebrow">暂时遇到一点问题</p><h1>还没能读取这份行程</h1><p>{message}</p><div className="state-actions">{onRetry && <button className="secondary-button" type="button" onClick={onRetry}>再试一次</button>}<Link className="primary-link" to="/">返回规划</Link></div></main></div>; }

function TripBrief({ trip, onAdjust }: { trip: Itinerary; onAdjust: () => void }) {
  return <div className="trip-brief-bar"><div><span>⌖ {trip.origin.label}</span><span>◷ {trip.preference.startTime} 出发</span><span>{formatMinutes(trip.preference.availableMinutes)}</span><span>{trip.preference.travelPreferences.join(' / ')}</span></div><button type="button" onClick={onAdjust}>调整偏好 ↗</button></div>;
}

function TimeBudget({ route }: { route: TripRoute }) {
  const travel = route.legs.reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const stay = route.scheduledStops.reduce((sum, stop) => sum + stop.departureMinuteOffset - stop.arrivalMinuteOffset, 0);
  const buffer = Math.max(0, route.totalDurationMinutes - travel - stay);
  const total = route.totalDurationMinutes + route.bufferMinutes;
  return <div className="time-budget" aria-label={`出行 ${travel} 分钟，停留 ${stay} 分钟，预留缓冲 ${buffer} 分钟，可用余量 ${route.bufferMinutes} 分钟`}>
    <div className="time-budget-track" aria-hidden="true"><span className="travel-time" style={{ width: `${travel / total * 100}%` }} /><span className="stay-time" style={{ width: `${stay / total * 100}%` }} /><span className="buffer-time" style={{ width: `${buffer / total * 100}%` }} /><span className="free-time" style={{ width: `${route.bufferMinutes / total * 100}%` }} /></div>
    <div className="time-budget-legend"><span><i className="travel-time" />路上 {travel} 分</span><span><i className="stay-time" />停留 {stay} 分</span><span><i className="buffer-time" />缓冲 {buffer} 分</span><span><i className="free-time" />余量 {route.bufferMinutes} 分</span></div>
  </div>;
}

function RouteCard({ route, index, active, onSelect, onEdit }: { route: TripRoute; index: number; active: boolean; onSelect: () => void; onEdit: () => void }) {
  return <article className={`route-card ${active ? 'is-active' : ''}`} style={{ '--route-color': routeColor(index) } as CSSProperties} tabIndex={0} aria-label={`方案 ${String.fromCharCode(65 + index)}：${route.title}，点击在地图中查看`} onClick={onSelect} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect(); } }}>
    <div className="route-topline" />
    <div className="route-card-heading"><span>ROUTE {String.fromCharCode(65 + index)}</span><button type="button" className="route-focus" aria-pressed={active} onClick={onSelect}>{active ? '● 地图中已选' : '在地图中查看'}</button></div>
    <h2>{route.title}</h2><p className="route-reason">{route.experienceStory ?? route.recommendationReason}</p>
    {route.matchedPreferences?.length ? <div className="matched-tags">{route.matchedPreferences.map((value) => <span key={value}>{value}</span>)}</div> : null}
    <div className="metrics"><Metric label="预计总时长" value={formatMinutes(route.totalDurationMinutes)} /><Metric label="路网总距离" value={`${(route.totalDistanceMeters / 1000).toFixed(1)} km`} /><Metric label="步行强度" value={{ low: '轻松', medium: '适中', high: '较高' }[route.walkingIntensity]} /><Metric label="可用时间余量" value={formatMinutes(route.bufferMinutes)} /></div>
    <div className="fingerprint">{route.pois.map((poi, poiIndex) => <span key={poi.id}>{poiIndex > 0 && <i aria-hidden="true">→</i>}{poi.name}</span>)}</div>
    {route.tradeoff && <p className="route-tradeoff"><b>选择这条路线</b>{route.tradeoff}</p>}
    <details className="route-evidence"><summary>为什么适合我 <span>推荐依据与提醒</span></summary><p>{route.recommendationReason}</p>{route.poiInsights?.length ? <div className="poi-insights">{route.poiInsights.map((insight) => <div key={insight.poiId}><strong>{route.pois.find((poi) => poi.id === insight.poiId)?.name}</strong><p>{insight.evidence.join('；')}</p>{insight.risks.length > 0 && <p className="evidence-warning">留意：{insight.risks.join('；')}</p>}</div>)}</div> : null}</details>
    {route.risks.length > 0 && <div className="risk-tags">{route.risks.map((risk) => <span key={risk}>{riskLabel[risk] ?? risk}</span>)}</div>}
    <button className="route-edit" type="button" onClick={(event) => { event.stopPropagation(); onEdit(); }}>选择这条，继续调整 ↗</button>
  </article>;
}

function NavigationLink({ from, to, mode }: { from: Place; to: Place; mode: TripRoute['legs'][number]['mode'] }) {
  return <a className="navigation-button" href={navigationUrl(from, to, mode)} target="_blank" rel="noopener noreferrer" aria-label={`在高德地图中导航到${to.label}`}><span aria-hidden="true">➤</span> 去导航</a>;
}

function StayDurationInput({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (minutes: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const minutes = Number(draft);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) { setDraft(String(value)); return; }
    if (minutes !== value) onSave(minutes);
  };
  return <label className="stay-duration-field"><span>建议停留</span><input type="number" aria-label="建议停留时长（分钟）" min={1} max={180} step={5} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><span>分钟</span></label>;
}

export function ComparePage() {
  const { itineraryId } = useParams(); const navigate = useNavigate(); const client = useQueryClient();
  const query = useQuery({ queryKey: ['trip', itineraryId], queryFn: () => getTrip(itineraryId!), enabled: Boolean(itineraryId) });
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  if (!itineraryId) return <Failed message="缺少行程编号。" />;
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failed message={query.error.message} onRetry={() => void query.refetch()} />;
  const trip = query.data; const active = trip.routes.find((route) => route.id === selectedRouteId) ?? trip.routes[0]!;
  const adjust = () => navigate('/', { state: { preference: trip.preference, itineraryId: trip.id } });
  return <div className="app-shell"><AppHeader /><main className="decision-page">
    <PlannerJourney step={1} itineraryId={trip.id} />
    <div className="decision-header"><div><p className="eyebrow">A LITTLE TIME, A GOOD TRIP</p><h1>{trip.routes.length > 1 ? '不同的走法，一样值得出发。' : '为此刻的你，找到一条可行路线。'}</h1><p>比较节奏、地点和取舍，选一条最合心意的，再一起调整。</p></div><span className="result-count">{trip.routes.length} 个方案<span>已完成路网与时间校验</span></span></div>
    <TripBrief trip={trip} onAdjust={adjust} />
    <AgentActions trip={trip} routeId={active.id} mode="compare" onUpdated={(updated) => { client.setQueryData(['trip', updated.id], updated); if (updated.id !== trip.id) { setSelectedRouteId(null); navigate(`/compare/${updated.id}`); } }} />
    {trip.status === 'degraded' && <div className="inline-alert" role="status"><strong>这次可选路线有限</strong><p>附近找到 {trip.routes.length} 条满足当前条件的路线。可以直接选用，也可以调整出发点、时间或偏好后重新规划。</p></div>}
    <section className={`route-board count-${trip.routes.length}`} aria-label="路线方案对比">{trip.routes.map((route, index) => <RouteCard key={route.id} route={route} index={index} active={active.id === route.id} onSelect={() => setSelectedRouteId(route.id)} onEdit={() => navigate(`/editor/${trip.id}/${route.id}`)} />)}</section>
    <section className="compare-bottom"><div className="difference-matrix"><p className="eyebrow">MAKE IT YOURS</p><h2>再看一眼，差别在哪里</h2><div className="matrix-scroll"><table className="route-comparison-table"><thead><tr><th scope="col">比较一下</th>{trip.routes.map((route, index) => <th scope="col" key={route.id} style={{ color: routeColor(index) }}>方案 {String.fromCharCode(65 + index)}</th>)}</tr></thead><tbody><tr><th scope="row">停靠地点</th>{trip.routes.map((route) => <td key={route.id}>{route.pois.length} 个</td>)}</tr><tr><th scope="row">路上时间</th>{trip.routes.map((route) => <td key={route.id}>{route.legs.reduce((sum, leg) => sum + leg.durationMinutes, 0)} 分钟</td>)}</tr><tr><th scope="row">时间余量</th>{trip.routes.map((route) => <td key={route.id}>{route.bufferMinutes} 分钟</td>)}</tr><tr><th scope="row">出行方式</th>{trip.routes.map((route) => <td key={route.id}>{[...new Set(route.legs.map((leg) => leg.mode))].join(' / ')}</td>)}</tr></tbody></table></div><p className="map-data-note">时长为规划估计，包含出行、停留与缓冲；营业、预约和现场情况请在出发前确认。</p></div><div className="compare-map-area"><MapCanvas origin={trip.origin} routes={trip.routes} activeRouteId={active.id} onSelectRoute={setSelectedRouteId} /><p className="map-data-note">点击方案或地图图例，即可查看对应路线。</p></div></section>
  </main><footer className="decision-footer"><span><b style={{ color: routeColor(trip.routes.indexOf(active)) }}>方案 {String.fromCharCode(65 + trip.routes.indexOf(active))}</b> · {active.title}</span><button className="primary-button" type="button" onClick={() => navigate(`/editor/${trip.id}/${active.id}`)}>按这条路线继续 →</button></footer></div>;
}

export function EditorPage() {
  const { itineraryId, routeId } = useParams(); const navigate = useNavigate(); const client = useQueryClient();
  const query = useQuery({ queryKey: ['trip', itineraryId], queryFn: () => getTrip(itineraryId!), enabled: Boolean(itineraryId) });
  const alternatives = useQuery({ queryKey: ['alternatives', itineraryId, routeId], queryFn: () => getAlternatives(itineraryId!, routeId!), enabled: Boolean(itineraryId && routeId) });
  const [activePoiId, setActivePoiId] = useState<string>(); const [selectedAlternative, setSelectedAlternative] = useState(''); const [notice, setNotice] = useState<Notice>(); const [agentPending, setAgentPending] = useState(false);
  useEffect(() => { setActivePoiId(undefined); setSelectedAlternative(''); setNotice(undefined); }, [routeId]);
  const updateTrip = (trip: Itinerary) => { client.setQueryData(['trip', trip.id], trip); setSelectedAlternative(''); void client.invalidateQueries({ queryKey: ['alternatives', itineraryId, routeId] }); };
  const onError = (error: Error) => setNotice({ text: error.message, kind: 'error' });
  const editMutation = useMutation({ mutationFn: (command: EditCommand) => editTrip(itineraryId!, routeId!, command), onSuccess: (trip) => { updateTrip(trip); setNotice(trip.invalidDraft ? { text: '这次调整超出限制，已保留草稿。请查看原因或恢复有效路线。', kind: 'error' } : { text: '路线已重新计算，新的时间与路网安排已更新。', kind: 'success' }); }, onError });
  const restoreMutation = useMutation({ mutationFn: (version: number) => restoreTrip(itineraryId!, query.data?.invalidDraft?.routeId ?? routeId!, version), onSuccess: (trip) => { updateTrip(trip); setNotice({ text: '已恢复上一个通过校验的路线。', kind: 'success' }); }, onError });
  const saveMutation = useMutation({ mutationFn: (version: number) => saveTrip(itineraryId!, version), onSuccess: (trip) => { updateTrip(trip); setNotice({ text: `路线已保存，当前为第 ${trip.version} 版。`, kind: 'success' }); }, onError });
  const shareMutation = useMutation({ mutationFn: () => createShare(itineraryId!, routeId!), onSuccess: (snapshot) => navigate(`/share/${snapshot.token}`), onError });
  if (!itineraryId || !routeId) return <Failed message="缺少行程或路线编号。" />;
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failed message={query.error.message} onRetry={() => void query.refetch()} />;
  const trip = query.data; const route = trip.routes.find((item) => item.id === routeId);
  if (!route) return <Failed message="这条路线不存在，可以返回重新选择方案。" />;
  const activeStop = Math.max(0, route.pois.findIndex((poi) => poi.id === activePoiId));
  const invalid = trip.invalidDraft;
  const mutationPending = editMutation.isPending || restoreMutation.isPending || saveMutation.isPending || shareMutation.isPending;
  const pending = mutationPending || agentPending;
  const edit = (command: EditWithoutVersion) => { setNotice(undefined); editMutation.mutate({ ...command, baseVersion: trip.version } as EditCommand); };
  return <div className="app-shell editor-shell"><AppHeader /><main className="editor-page">
    <PlannerJourney step={2} itineraryId={trip.id} routeId={route.id} />
    <div className="editor-top"><div><Link className="back-link" to={`/compare/${trip.id}`}>← 返回方案对比</Link><h1>{route.title}</h1><p>{trip.origin.label}出发 · {trip.preference.startTime} 开始 · {route.pois.length} 个停靠点</p></div><div className="route-tabs" aria-label="选择路线">{trip.routes.map((item, index) => <button className={item.id === route.id ? 'active' : ''} aria-pressed={item.id === route.id} disabled={pending} onClick={() => navigate(`/editor/${trip.id}/${item.id}`)} type="button" key={item.id}>方案 {String.fromCharCode(65 + index)}</button>)}</div></div>
    <AgentActions trip={trip} routeId={route.id} mode="editor" disabled={mutationPending || Boolean(invalid)} onPendingChange={setAgentPending} onUpdated={(updated) => { updateTrip(updated); setNotice(undefined); if (updated.id !== trip.id) navigate(`/compare/${updated.id}`); }} />
    {invalid && <section className="invalid-draft-panel" role="alert"><div><p className="eyebrow">需要调整</p><h2>这次修改还不能作为出行方案</h2><p>下方地图保留上一个有效路线。拟修改的地点为：{invalid.pois.map((poi) => poi.name).join(' → ')}。</p><ul>{invalid.violations.map((violation, index) => <li key={`${violation.code}-${index}`}>{violation.message}</li>)}</ul></div><button type="button" className="secondary-button" disabled={pending} onClick={() => restoreMutation.mutate(trip.version)}>{restoreMutation.isPending ? '正在恢复…' : '放弃草稿，恢复有效路线'}</button></section>}
    <section className="editor-overview" aria-label="时间安排概览"><div className="overview-metrics"><Metric label="预计行程" value={formatMinutes(route.totalDurationMinutes)} /><Metric label="路网距离" value={`${(route.totalDistanceMeters / 1000).toFixed(1)} km`} /><Metric label="步行强度" value={{ low: '轻松', medium: '适中', high: '较高' }[route.walkingIntensity]} /></div><TimeBudget route={route} /></section>
    <div className="editor-grid"><section className="itinerary-list"><div className="section-heading"><h2>按自己的节奏走</h2><span>{route.pois.length} 个停靠点</span></div><p className="section-description">点选地点查看地图，使用箭头调整先后。</p><div className="origin-line"><span className="origin-symbol">⌖</span><div><strong>{trip.origin.label}</strong><small>{trip.preference.startTime} 从这里出发</small></div></div>
      {route.pois.map((poi, index) => { const stop = route.scheduledStops[index]!; const leg = route.legs[index]; return <div className="timeline-stop" key={poi.id}>
        {leg && <p className="leg-summary"><span aria-hidden="true">↓</span>{leg.mode} {leg.durationMinutes} 分钟 · {(leg.distanceMeters / 1000).toFixed(1)} km</p>}
        <div className={`stop-row ${activeStop === index ? 'active' : ''}`}><div className="stop-main"><button type="button" className="stop-select" onClick={() => setActivePoiId(poi.id)} aria-pressed={activeStop === index}><span className="stop-number">{index + 1}</span><span className="stop-details"><strong>{poi.name}</strong><small>{clockTime(trip.preference.startTime, stop.arrivalMinuteOffset)}–{clockTime(trip.preference.startTime, stop.departureMinuteOffset)} · 停留 {stop.departureMinuteOffset - stop.arrivalMinuteOffset} 分钟</small><small>{poi.place.address}</small></span></button><div className="stop-inline-actions"><StayDurationInput value={poi.stayMinutes} disabled={pending || Boolean(invalid)} onSave={(stayMinutes) => edit({ operation: 'stay', poiId: poi.id, stayMinutes })} /><NavigationLink from={index === 0 ? trip.origin : route.pois[index - 1]!.place} to={poi.place} mode={leg?.mode ?? '步行'} /></div></div><div className="stop-actions"><button type="button" disabled={pending || Boolean(invalid) || index === 0} aria-label={`上移 ${poi.name}`} onClick={() => { const ids = route.pois.map((item) => item.id); [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; edit({ operation: 'reorder', poiIds: ids }); }}>↑</button><button type="button" disabled={pending || Boolean(invalid) || index === route.pois.length - 1} aria-label={`下移 ${poi.name}`} onClick={() => { const ids = route.pois.map((item) => item.id); [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!]; edit({ operation: 'reorder', poiIds: ids }); }}>↓</button><button type="button" disabled={pending || Boolean(invalid) || route.pois.length <= 1} aria-label={`删除 ${poi.name}`} onClick={() => edit({ operation: 'remove', poiId: poi.id })}>×</button></div></div>
      </div>; })}
      <div className="alternative-picker"><div className="replacement-heading"><span className="alternative-label">让这条路线更像你的选择</span><small>当前选中：{route.pois[activeStop]!.name}</small></div><PoiChoice pois={alternatives.data ?? []} selectedId={selectedAlternative} onSelect={setSelectedAlternative} loading={alternatives.isPending} error={alternatives.isError} />{alternatives.isError && <button type="button" className="text-button" onClick={() => void alternatives.refetch()}>重新获取附近地点</button>}{selectedAlternative && <p className="replacement-preview">可以替换 <strong>{route.pois[activeStop]!.name}</strong>，也可以添加到路线末尾。调整后会重新校验时间和路网。</p>}<div className="alternative-actions"><button type="button" className="secondary-button" disabled={pending || Boolean(invalid) || !selectedAlternative || route.pois.length >= 8} onClick={() => edit({ operation: 'add', poiId: selectedAlternative })}>添加到行程末尾</button><button type="button" className="primary-button" disabled={pending || Boolean(invalid) || !selectedAlternative} onClick={() => edit({ operation: 'replace', poiId: route.pois[activeStop]!.id, replacementPoiId: selectedAlternative })}>{editMutation.isPending ? '正在重算…' : '替换选中地点'}</button></div></div>
    </section><section className="editor-map" aria-label="路线地图"><MapCanvas origin={trip.origin} routes={[route]} activeRouteId={route.id} routeColorOffset={trip.routes.findIndex((item) => item.id === route.id)} activeStopIndex={activeStop} onSelectStop={(index) => setActivePoiId(route.pois[index]?.id)} /><div className="map-stop-caption">{activeStop + 1}. {route.pois[activeStop]!.name}</div></section></div>
    <div className={`constraint-bar ${invalid ? 'invalid' : editMutation.isPending || agentPending ? 'recalculating' : 'valid'}`} role="status"><span>{invalid ? '待处理草稿 · 保存和分享暂不可用' : editMutation.isPending ? '正在查询路网，重新计算时间与距离…' : agentPending ? '旅行助手正在处理请求，结果将在完成后更新…' : '✓ 路网与时间校验通过'}</span><span>{invalid ? '先恢复有效路线，再继续调整' : `可用余量 ${formatMinutes(route.bufferMinutes)} · 第 ${trip.version} 版`}</span></div>
    {notice && <p className={`editor-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    {route.risks.length > 0 && <p className="editor-risk-note">出发前留意：{route.risks.map((risk) => riskLabel[risk] ?? risk).join('；')}。</p>}
  </main><footer className="editor-footer"><span>{invalid ? '处理草稿后即可保存分享' : trip.savedVersion === trip.version ? '当前版本已保存，可以分享给同行的人' : '调整好了？保存这一版，带着行程出发。'}</span><div><button className="secondary-button" disabled={pending || Boolean(invalid) || trip.savedVersion === trip.version} type="button" onClick={() => { setNotice(undefined); saveMutation.mutate(trip.version); }}>{saveMutation.isPending ? '保存中…' : trip.savedVersion === trip.version ? '✓ 已保存' : '保存路线'}</button><button className="primary-button" disabled={pending || Boolean(invalid) || trip.savedVersion !== trip.version} type="button" onClick={() => { setNotice(undefined); shareMutation.mutate(); }}>{shareMutation.isPending ? '正在创建…' : '分享这份行程 ↗'}</button></div></footer></div>;
}

export function SharePage() {
  const { token } = useParams(); const [copyNotice, setCopyNotice] = useState<Notice>(); const [manualCopy, setManualCopy] = useState('');
  const query = useQuery({ queryKey: ['share', token], queryFn: () => getShare(token!), enabled: Boolean(token) });
  if (!token) return <Failed message="缺少分享令牌。" />;
  if (query.isPending) return <Loading text="正在读取分享行程…" />;
  if (query.isError) return <Failed message={query.error.message} onRetry={() => void query.refetch()} />;
  const snapshot = query.data; const route = snapshot.route;
  const copy = async (kind: 'link' | 'itinerary') => {
    const text = kind === 'link' ? window.location.href : [route.title, `从 ${snapshot.origin.label} 出发 · ${snapshot.preference.startTime}`, `预计 ${formatMinutes(route.totalDurationMinutes)} · ${(route.totalDistanceMeters / 1000).toFixed(1)} km`, ...route.pois.map((poi, index) => `${index + 1}. ${clockTime(snapshot.preference.startTime, route.scheduledStops[index]!.arrivalMinuteOffset)}–${clockTime(snapshot.preference.startTime, route.scheduledStops[index]!.departureMinuteOffset)} ${poi.name}\n${poi.place.address}`), `出发前确认：${route.risks.map((risk) => riskLabel[risk] ?? risk).join('；') || '营业时间、预约与现场情况'}`, window.location.href].join('\n\n');
    try { await navigator.clipboard.writeText(text); setManualCopy(''); setCopyNotice({ text: kind === 'link' ? '分享链接已复制。' : '行程清单已复制，可以发送给同行的人。', kind: 'success' }); }
    catch { setManualCopy(text); setCopyNotice({ text: '浏览器未允许复制，可以选中下方内容手动复制。', kind: 'error' }); }
  };
  return <div className="app-shell share-shell"><AppHeader /><main className="share-page"><PlannerJourney step={3} itineraryId={snapshot.itineraryId} routeId={route.id} /><div className="share-heading"><span className="share-stamp" aria-hidden="true">↗</span><p className="eyebrow">READY FOR A LITTLE ADVENTURE</p><h1>{route.title}</h1><p>{snapshot.origin.label}出发 · {snapshot.preference.startTime} 开始</p><span className="snapshot-label">保存的第 {snapshot.version} 版 · {new Date(snapshot.createdAt).toLocaleDateString('zh-CN')}</span></div>
    <section className="share-card"><div className="share-metrics"><Metric label="预计总时长" value={formatMinutes(route.totalDurationMinutes)} /><Metric label="路网距离" value={`${(route.totalDistanceMeters / 1000).toFixed(1)} km`} /><Metric label="可用时间余量" value={formatMinutes(route.bufferMinutes)} /></div><MapCanvas origin={snapshot.origin} routes={[route]} activeRouteId={route.id} /><div className="share-story"><h2>这一路，慢慢发现</h2><p>{route.experienceStory ?? route.recommendationReason}</p></div><ol className="share-timeline">{route.pois.map((poi, index) => { const leg = route.legs[index]; return <li key={poi.id}><span>{index + 1}</span><div><small className="share-stop-time">{clockTime(snapshot.preference.startTime, route.scheduledStops[index]!.arrivalMinuteOffset)}–{clockTime(snapshot.preference.startTime, route.scheduledStops[index]!.departureMinuteOffset)}</small><strong>{poi.name}</strong><p>{poi.place.address}</p>{leg && <p>{leg.mode} {leg.durationMinutes} 分钟到达 · 建议停留 {poi.stayMinutes} 分钟</p>}<NavigationLink from={index === 0 ? snapshot.origin : route.pois[index - 1]!.place} to={poi.place} mode={leg?.mode ?? '步行'} /></div></li>; })}</ol><div className="share-risk"><strong>出发前再确认一下</strong><p>{route.risks.length ? route.risks.map((risk) => riskLabel[risk] ?? risk).join('；') : '营业时间、预约要求和现场情况'}。路线时长为规划估计，请为临时变化留出余量。</p></div></section>
    <div className="share-actions"><button className="secondary-button" type="button" onClick={() => void copy('link')}>复制分享链接</button><button className="primary-button" type="button" onClick={() => void copy('itinerary')}>复制行程清单 ↗</button></div>{copyNotice && <p className={`copy-notice ${copyNotice.kind}`} role="status">{copyNotice.text}</p>}{manualCopy && <textarea className="manual-copy" aria-label="可手动复制的分享内容" readOnly value={manualCopy} onFocus={(event) => event.currentTarget.select()} rows={6} />}<p className="snapshot-note">这是一份固定的行程快照，后续编辑不会改变此链接的内容。</p><div className="share-secondary-links"><Link to={`/editor/${snapshot.itineraryId}/${route.id}`}>返回继续调整</Link><Link to="/">规划我自己的出发 →</Link></div>
  </main></div>;
}
