import { Link } from 'react-router-dom';
import type { PreferenceExtraction } from '@tripbeam/contracts';

const journey = ['说说想法', '比较方案', '调整行程', '保存与分享'];

export function PlannerJourney({ step, itineraryId, routeId }: { step: 0 | 1 | 2 | 3; itineraryId?: string; routeId?: string }) {
  const paths = ['/', itineraryId ? `/compare/${itineraryId}` : undefined, itineraryId && routeId ? `/editor/${itineraryId}/${routeId}` : undefined];
  return <nav className="planner-journey" aria-label="规划流程"><ol>{journey.map((label, index) => <li key={label} className={index === step ? 'current' : index < step ? 'done' : ''} aria-current={index === step ? 'step' : undefined}>
    {index < step && paths[index] ? <Link to={paths[index]!}><span>{index + 1}</span>{label}</Link> : <div><span>{index < step ? '✓' : index + 1}</span>{label}</div>}
  </li>)}</ol></nav>;
}

const preferenceFields = [
  { field: 'originLabel', label: '从哪里出发', icon: '⌖' },
  { field: 'startTime', label: '出发时间', icon: '◷' },
  { field: 'availableMinutes', label: '可用时长', icon: '◴' },
  { field: 'playPreferences', label: '想要的体验', icon: '✧' },
  { field: 'travelPreferences', label: '出行方式', icon: '↗' },
] as const;

export function PreferenceSummary({ preference, onEdit }: { preference: PreferenceExtraction; onEdit?: (field: keyof PreferenceExtraction) => void }) {
  const completed = preferenceFields.filter(({ field }) => Array.isArray(preference[field]) ? (preference[field] as unknown[]).length > 0 : Boolean(preference[field])).length;
  const requirements = [
    ...(preference.mustHave ?? []).map((value) => `一定想去 · ${value}`),
    ...(preference.avoid ?? []).map((value) => `避开 · ${value}`),
    ...(preference.customPreferences ?? []),
  ];
  return <section className="preference-summary" aria-labelledby="preference-summary-title">
    <div className="preference-summary-heading"><div><p className="eyebrow">YOUR TRIP BRIEF</p><h2 id="preference-summary-title">这次出发</h2></div><span className={completed === 5 ? 'summary-status complete' : 'summary-status'}>{completed}/5 已确认</span></div>
    <dl>{preferenceFields.map(({ field, label, icon }) => {
      const raw = preference[field];
      const value = Array.isArray(raw) ? raw.join('、') : field === 'availableMinutes' && typeof raw === 'number' ? `${raw} 分钟` : raw;
      const content = <><span className="brief-icon" aria-hidden="true">{icon}</span><span><dt>{label}</dt><dd className={value ? '' : 'brief-missing'}>{value || '等待你的想法'}</dd></span>{onEdit && <span className="brief-edit" aria-hidden="true">编辑</span>}</>;
      return <div className="brief-row" key={field}>{onEdit ? <button type="button" onClick={() => onEdit(field)} aria-label={`编辑${label}`}>{content}</button> : <div>{content}</div>}</div>;
    })}</dl>
    {requirements.length > 0 && <div className="brief-requirements"><h3>特别偏好</h3><div>{requirements.map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}</div></div>}
    <p className="brief-footnote">每一个选择，都会影响地点筛选和路线安排。</p>
  </section>;
}

export const formatMinutes = (minutes: number) => minutes === 0 ? '0 分钟' : `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} 小时` : ''}${minutes % 60 ? `${Math.floor(minutes / 60) ? ' ' : ''}${minutes % 60} 分钟` : ''}`;
export const clockTime = (start: string, offset: number) => {
  const [hours, minutes] = start.split(':').map(Number);
  const total = hours! * 60 + minutes! + offset;
  return `${total >= 1440 ? '次日 ' : ''}${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export const riskLabel: Record<string, string> = {
  OPENING_HOURS_UNCERTAIN: '营业时间待确认', MAP_UNAVAILABLE: '地图暂不可用', POI_DATA_PARTIAL: '地点信息待确认',
  ROUTE_TIME_TIGHT: '时间余量较少', PREFERENCE_RELAXED: '已放宽部分偏好', ROUTE_COUNT_LIMITED: '可用路线数量有限',
};
