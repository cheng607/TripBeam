import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EditCommand, Itinerary, TripRoute } from '@tripbeam/contracts';
import { createShare, editTrip, getAlternatives, getShare, getTrip, saveTrip } from './api/trips';
import { MapCanvas } from './map-canvas';
import { PoiChoice } from './poi-choice';
import { routeColor } from './route-colors';
type EditWithoutVersion = EditCommand extends infer Command ? Command extends EditCommand ? Omit<Command, 'baseVersion'> : never : never;

function AppHeader({ back = '/' }: { back?: string }) {
  return <header className="app-header"><Link to={back} className="brand"><span className="brand-mark">↗</span>TripBeam</Link><p>城市临时出行 · 真实地点与路网数据</p></header>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function Loading({ text = '正在读取行程…' }: { text?: string }) { return <div className="app-shell"><AppHeader /><main className="state-page" role="status"><span className="loading-orbit" /><h1>{text}</h1><p>正在获取地点和路网信息，请稍候。</p></main></div>; }
function Failed({ message }: { message: string }) { return <div className="app-shell"><AppHeader /><main className="state-page" role="alert"><h1>暂时无法展示行程</h1><p>{message}</p><Link className="primary-link" to="/">返回重新规划</Link></main></div>; }
const formatMinutes = (minutes: number) => minutes === 0 ? '0分' : `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}小时` : ''}${minutes % 60 ? `${minutes % 60}分` : ''}`;
const clockTime = (start: string, offset: number) => { const [hours, minutes] = start.split(':').map(Number); const total = hours! * 60 + minutes! + offset; return `${total >= 1440 ? '次日 ' : ''}${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; };
const riskLabel: Record<string, string> = { OPENING_HOURS_UNCERTAIN: '营业时间待确认', MAP_UNAVAILABLE: '地图暂不可用', POI_DATA_PARTIAL: '地点信息待确认', ROUTE_TIME_TIGHT: '时间余量较少', PREFERENCE_RELAXED: '已放宽部分偏好', ROUTE_COUNT_LIMITED: '可用路线数量有限' };

function RouteCard({ route, index, active, onSelect, onEdit }: { route: TripRoute; index: number; active: boolean; onSelect: () => void; onEdit: () => void }) {
  return <article className={`route-card ${active ? 'is-active' : ''}`} style={{ '--route-color': routeColor(index) } as React.CSSProperties} role="button" aria-pressed={active} tabIndex={0} onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); } }}>
    <div className="route-topline" /><div className="route-card-heading"><span>方案 {String.fromCharCode(65 + index)}</span>{active && <em>已聚焦</em>}</div>
    <h2>{route.title}</h2><div className="fingerprint">{route.pois.map((poi, poiIndex) => <span key={poi.id}>{poiIndex > 0 && <i>—</i>}{poi.name}</span>)}</div>
    <div className="metrics"><Metric label="总时长" value={formatMinutes(route.totalDurationMinutes)} /><Metric label="总距离" value={`${(route.totalDistanceMeters / 1000).toFixed(1)}km`} /><Metric label="步行强度" value={{ low: '低', medium: '中', high: '高' }[route.walkingIntensity]} /><Metric label="时间余量" value={formatMinutes(route.bufferMinutes)} /></div>
    {route.experienceStory && <p className="route-story">体验主线：{route.experienceStory}</p>}<p className="route-reason">{route.recommendationReason}</p>{route.tradeoff && <p className="route-tradeoff">取舍：{route.tradeoff}</p>}{route.poiInsights?.length ? <div className="poi-insights">{route.poiInsights.map((insight) => <p key={insight.poiId}>✓ {route.pois.find((poi) => poi.id === insight.poiId)?.name}：{insight.evidence.join('；')}{insight.risks.length ? `。注意：${insight.risks.join('；')}` : ''}</p>)}</div> : null}{route.risks.length > 0 && <div className="risk-tags">{route.risks.map((risk) => <span key={risk}>! {riskLabel[risk] ?? risk}</span>)}</div>}
    <button className="route-edit" type="button" onClick={(event) => { event.stopPropagation(); onEdit(); }}>查看并编辑 →</button>
  </article>;
}

export function ComparePage() {
  const { itineraryId } = useParams(); const navigate = useNavigate();
  const query = useQuery({ queryKey: ['trip', itineraryId], queryFn: () => getTrip(itineraryId!), enabled: Boolean(itineraryId) });
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  if (!itineraryId) return <Failed message="缺少行程编号。" />;
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failed message={query.error.message} />;
  const trip = query.data; const active = trip.routes.find((route) => route.id === selectedRouteId) ?? trip.routes[0]!;
  return <div className="app-shell"><AppHeader /><main className="decision-page"><div className="decision-header"><div><Link to="/" className="back-link">← 修改偏好</Link><h1>把这几小时，留给更适合此刻的路线</h1><p>{trip.origin.label}附近 · {trip.preference.startTime} 开始 · 可用 {formatMinutes(trip.preference.availableMinutes)} · {trip.preference.playPreferences.join('、')}</p></div><button className="secondary-button" type="button" onClick={() => navigate('/')}>调整条件重新生成</button></div>
    {trip.status === 'degraded' && <p className="inline-alert">附近仅找到 {trip.routes.length} 条满足硬约束的路线。可返回调整出发点、时间或偏好。</p>}
    <section className={`route-board count-${trip.routes.length}`} aria-label="路线方案对比">{trip.routes.map((route, index) => <RouteCard key={route.id} route={route} index={index} active={active.id === route.id} onSelect={() => setSelectedRouteId(route.id)} onEdit={() => navigate(`/editor/${trip.id}/${route.id}`)} />)}</section>
    <section className="compare-bottom"><div className="difference-matrix" style={{ '--route-count': trip.routes.length } as React.CSSProperties}><h2>路线差异</h2><div className="matrix-row"><strong>方案</strong>{trip.routes.map((route, index) => <span key={route.id}>{String.fromCharCode(65 + index)} · {route.title}</span>)}</div><div className="matrix-row"><strong>停靠点</strong>{trip.routes.map((route) => <span key={route.id}>{route.pois.length} 个</span>)}</div><div className="matrix-row"><strong>时间余量</strong>{trip.routes.map((route) => <span key={route.id}>{formatMinutes(route.bufferMinutes)}</span>)}</div><div className="matrix-row"><strong>路网距离</strong>{trip.routes.map((route) => <span key={route.id}>{(route.totalDistanceMeters / 1000).toFixed(1)}km</span>)}</div><p className="map-data-note">地点、路线与数字均来自服务端地图和规则校验；现场开放情况请出发前确认。</p></div><MapCanvas origin={trip.origin} routes={trip.routes} activeRouteId={active.id} onSelectRoute={setSelectedRouteId} /></section>
  </main><footer className="decision-footer"><span><b style={{ color: routeColor(trip.routes.indexOf(active)) }}>方案 {String.fromCharCode(65 + trip.routes.indexOf(active))}</b> · {active.title}</span><button className="primary-button" type="button" onClick={() => navigate(`/editor/${trip.id}/${active.id}`)}>查看并编辑 →</button></footer></div>;
}

export function EditorPage() {
  const { itineraryId, routeId } = useParams(); const navigate = useNavigate(); const client = useQueryClient();
  const query = useQuery({ queryKey: ['trip', itineraryId], queryFn: () => getTrip(itineraryId!), enabled: Boolean(itineraryId) });
  const alternatives = useQuery({ queryKey: ['alternatives', itineraryId, routeId], queryFn: () => getAlternatives(itineraryId!, routeId!), enabled: Boolean(itineraryId && routeId) });
  const [activeStop, setActiveStop] = useState(0); const [selectedAlternative, setSelectedAlternative] = useState(''); const [notice, setNotice] = useState('');
  const editMutation = useMutation({ mutationFn: (command: EditCommand) => editTrip(itineraryId!, routeId!, command), onSuccess: (trip) => { client.setQueryData(['trip', itineraryId], trip); setNotice('路线已重新计算并通过约束校验。'); void client.invalidateQueries({ queryKey: ['alternatives', itineraryId, routeId] }); }, onError: (error) => setNotice(error.message) });
  const saveMutation = useMutation({ mutationFn: (version: number) => saveTrip(itineraryId!, version), onSuccess: (trip) => { client.setQueryData(['trip', itineraryId], trip); setNotice(`已保存版本 v${trip.version}。`); }, onError: (error) => setNotice(error.message) });
  const shareMutation = useMutation({ mutationFn: () => createShare(itineraryId!, routeId!), onSuccess: (snapshot) => navigate(`/share/${snapshot.token}`), onError: (error) => setNotice(error.message) });
  if (!itineraryId || !routeId) return <Failed message="缺少行程或路线编号。" />;
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failed message={query.error.message} />;
  const trip = query.data; const route = trip.routes.find((item) => item.id === routeId);
  if (!route) return <Failed message="路线不存在。" />;
  const pending = editMutation.isPending || saveMutation.isPending || shareMutation.isPending;
  const edit = (command: EditWithoutVersion) => { setNotice(''); editMutation.mutate({ ...command, baseVersion: trip.version } as EditCommand); };
  return <div className="app-shell editor-shell"><AppHeader back={`/compare/${trip.id}`} /><main className="editor-page"><div className="editor-top"><div><Link className="back-link" to={`/compare/${trip.id}`}>← 返回对比</Link><h1>{route.title}</h1><p>{formatMinutes(route.totalDurationMinutes)} · {(route.totalDistanceMeters / 1000).toFixed(1)}km · 规则校验有效 · v{trip.version}</p></div><div className="route-tabs">{trip.routes.map((item, index) => <button className={item.id === route.id ? 'active' : ''} onClick={() => navigate(`/editor/${trip.id}/${item.id}`)} type="button" key={item.id}>方案 {String.fromCharCode(65 + index)}</button>)}</div></div>
    <div className="editor-grid"><section className="itinerary-list"><h2>行程清单</h2><div className="origin-line"><span>⌖</span><div><strong>出发点</strong><small>{trip.preference.startTime} · {trip.origin.label}</small></div></div>{route.pois.map((poi, index) => <div className={`stop-row ${activeStop === index ? 'active' : ''}`} key={poi.id} onClick={() => setActiveStop(index)}><span className="stop-number">{index + 1}</span><div className="stop-details"><strong>{poi.name}</strong><small>{clockTime(trip.preference.startTime, route.scheduledStops[index]!.arrivalMinuteOffset)}–{clockTime(trip.preference.startTime, route.scheduledStops[index]!.departureMinuteOffset)} · {poi.place.address}</small></div><div className="stop-actions"><button type="button" disabled={pending || index === 0} aria-label={`上移 ${poi.name}`} onClick={(event) => { event.stopPropagation(); const ids = route.pois.map((item) => item.id); [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; edit({ operation: 'reorder', poiIds: ids }); }}>↑</button><button type="button" disabled={pending || index === route.pois.length - 1} aria-label={`下移 ${poi.name}`} onClick={(event) => { event.stopPropagation(); const ids = route.pois.map((item) => item.id); [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!]; edit({ operation: 'reorder', poiIds: ids }); }}>↓</button><button type="button" disabled={pending || route.pois.length <= 1} aria-label={`删除 ${poi.name}`} onClick={(event) => { event.stopPropagation(); edit({ operation: 'remove', poiId: poi.id }); }}>×</button></div></div>)}
      <div className="alternative-picker"><span className="alternative-label">附近候选地点</span><PoiChoice pois={alternatives.data ?? []} selectedId={selectedAlternative} onSelect={setSelectedAlternative} loading={alternatives.isPending} error={alternatives.isError} /><div className="alternative-actions"><button type="button" className="secondary-button" disabled={pending || !selectedAlternative} onClick={() => edit({ operation: 'add', poiId: selectedAlternative })}>添加停靠点</button><button type="button" className="secondary-button" disabled={pending || !selectedAlternative || !route.pois[activeStop]} onClick={() => edit({ operation: 'replace', poiId: route.pois[activeStop]!.id, replacementPoiId: selectedAlternative })}>替换选中点</button></div></div>
    </section><section className="editor-map"><MapCanvas origin={trip.origin} routes={trip.routes} activeRouteId={route.id} onSelectStop={setActiveStop} /><div className="map-stop-caption">当前选中：{route.pois[activeStop]?.name ?? '未选择'}</div></section></div>
    <div className={`constraint-bar ${pending ? 'recalculating' : 'valid'}`}><span>{editMutation.isPending ? '◌ 正在从路网重新计算时间与距离…' : '✓ 当前路线已通过路网与时间校验'}</span><span>{notice || `剩余 ${formatMinutes(route.bufferMinutes)} · ${route.legs[0]?.mode ?? '路线方式待确认'}`}</span></div>
  </main><footer className="editor-footer"><span>编辑结果均由服务端重新校验</span><div><button className="secondary-button" disabled={pending} type="button" onClick={() => saveMutation.mutate(trip.version)}>{saveMutation.isPending ? '保存中…' : trip.savedVersion === trip.version ? '当前版本已保存' : '保存路线'}</button><button className="primary-button" disabled={pending || trip.savedVersion !== trip.version} type="button" onClick={() => shareMutation.mutate()}>{shareMutation.isPending ? '创建中…' : '创建分享快照'}</button></div></footer></div>;
}

export function SharePage() {
  const { token } = useParams(); const [copied, setCopied] = useState(false);
  const query = useQuery({ queryKey: ['share', token], queryFn: () => getShare(token!), enabled: Boolean(token) });
  if (!token) return <Failed message="缺少分享令牌。" />;
  if (query.isPending) return <Loading text="正在读取分享快照…" />;
  if (query.isError) return <Failed message={query.error.message} />;
  const snapshot = query.data; const route = snapshot.route;
  const copy = async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); } catch { setCopied(false); } };
  return <div className="app-shell share-shell"><AppHeader /><main className="share-page"><div className="share-heading"><p className="eyebrow">已验证行程快照 · v{snapshot.version}</p><h1>{route.title}</h1><p>创建于 {new Date(snapshot.createdAt).toLocaleString('zh-CN')}。后续编辑不会改变这份快照。</p></div><section className="share-card"><div className="share-metrics"><Metric label="总时长" value={formatMinutes(route.totalDurationMinutes)} /><Metric label="路网距离" value={`${(route.totalDistanceMeters / 1000).toFixed(1)}km`} /><Metric label="时间余量" value={formatMinutes(route.bufferMinutes)} /></div><MapCanvas origin={snapshot.origin} routes={[route]} activeRouteId={route.id} /><ol className="share-timeline">{route.pois.map((poi, index) => <li key={poi.id}><span>{index + 1}</span><div><strong>{poi.name}</strong><p>{clockTime(snapshot.preference.startTime, route.scheduledStops[index]!.arrivalMinuteOffset)}–{clockTime(snapshot.preference.startTime, route.scheduledStops[index]!.departureMinuteOffset)} · {poi.place.address}</p></div></li>)}</ol><div className="share-risk">{route.risks.length ? route.risks.map((risk) => riskLabel[risk] ?? risk).join('；') : '暂无需要特别留意的风险提示'}。现场信息请出发前确认。</div></section><div className="share-actions"><button className="secondary-button" type="button" onClick={copy}>{copied ? '已复制链接' : '复制链接'}</button><Link className="primary-link" to={`/editor/${snapshot.itineraryId}/${route.id}`}>返回继续编辑</Link></div></main></div>;
}
