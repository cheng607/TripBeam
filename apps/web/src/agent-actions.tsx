import { useRef, useState } from 'react';
import type { Itinerary } from '@tripbeam/contracts';
import { sendAgentTurn, type AgentTurn } from './agent-session';

export function AgentActions({ trip, routeId, onUpdated, mode, disabled = false, onPendingChange }: { trip: Itinerary; routeId?: string; onUpdated: (trip: Itinerary) => void; mode: 'compare' | 'editor'; disabled?: boolean; onPendingChange?: (pending: boolean) => void }) {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failedTurn, setFailedTurn] = useState<AgentTurn>();
  const [steps, setSteps] = useState<string[]>([]);
  const inFlight = useRef(false);
  const run = async (body: AgentTurn) => {
    if (inFlight.current || disabled) return;
    inFlight.current = true; setPending(true); onPendingChange?.(true); setFeedback(''); setFailedTurn(undefined); setSteps([]);
    try {
      const result = await sendAgentTurn(body);
      setFeedback(result.message); setSteps(result.steps); setInput('');
      if (result.actions.includes('retry')) setFailedTurn({ ...body, turnId: crypto.randomUUID() });
      if (result.itinerary) onUpdated(result.itinerary);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '操作暂未完成，请重试。'); setFailedTurn(body);
    } finally { inFlight.current = false; setPending(false); onPendingChange?.(false); }
  };
  const command = (action: AgentTurn['action'], text: string): AgentTurn => ({ turnId: crypto.randomUUID(), action, text, itineraryId: trip.id, routeId: routeId ?? trip.routes[0]?.id, baseVersion: trip.version, ...(action === 'regenerate' ? { preferencePatch: trip.preference } : {}) });
  return <section className="agent-actions" aria-label="继续与旅行助手对话" aria-busy={pending}>
    <div className="agent-action-heading"><div><p className="overline">TRIPBEAM 旅行助手</p><h2>{mode === 'compare' ? '还想换一种逛法？' : '也可以直接告诉我怎么改'}</h2></div><div className="agent-action-buttons">
      <button type="button" className="secondary-button" disabled={pending || disabled} onClick={() => void run(command('explain_route', '解释这条路线的推荐理由和取舍'))}>为什么推荐这条</button>
      {mode === 'compare' && <button type="button" className="secondary-button" disabled={pending || disabled} onClick={() => void run(command('regenerate', '保持这些条件，再找一组路线'))}>再找一组方案 ↗</button>}
    </div></div>
    {mode === 'editor' && <form className="agent-inline-form" onSubmit={(event) => { event.preventDefault(); if (input.trim()) void run(command('message', input.trim())); }}>
      <label htmlFor="route-instruction" className="sr-only">用自然语言调整路线</label><input id="route-instruction" maxLength={1000} value={input} disabled={pending || disabled} placeholder="例如：删掉第二站，或者添加候选列表中的地点名称" onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />
      <button className="primary-button" disabled={pending || disabled || !input.trim()}>{pending ? '正在处理…' : '调整路线 ↑'}</button>
    </form>}
    {(pending || feedback) && <div className="agent-feedback" role="status"><p>{pending ? (mode === 'compare' ? '正在处理请求，请稍候。新方案需要重新查询地点和路网。' : '正在处理请求；路线改动会重新检查时间和交通条件。') : feedback}</p>{!pending && steps.length > 0 && <details><summary>查看本次处理记录</summary><ol>{steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></details>}{failedTurn && <button className="secondary-button" type="button" onClick={() => void run(failedTurn)}>重试这次操作</button>}</div>}
  </section>;
}
