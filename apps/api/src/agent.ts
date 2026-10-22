import { AgentDecisionSchema, PreferenceExtractionSchema, type AgentDecision, type AgentSession, type PreferenceExtraction } from '@tripbeam/contracts';
import type { ClarificationWriter, IntentParser } from './deepseek.js';

export interface AgentOrchestrator {
  readonly source: 'dify' | 'native' | 'fallback';
  decide(input: { text: string; preference: PreferenceExtraction; phase: AgentSession['phase'] }): Promise<AgentDecision>;
  clarify(missingFields: string[]): Promise<string>;
}

const intentFor = (text: string): AgentDecision['intent'] => {
  if (/(删除|删掉|去掉|移除)/.test(text)) return 'edit_route';
  if (/(替换|换成|换一个|改成|添加|增加|加上|排序|重新排列)/.test(text)) return 'edit_route';
  if (/(为什么|怎么安排|解释|推荐理由)/.test(text)) return 'explain_route';
  if (/(重新生成|再来一条|换一条|重新规划)/.test(text)) return 'regenerate';
  return 'collect_preference';
};

const editFor = (text: string): AgentDecision['edit'] | undefined => {
  const remove = text.match(/(?:删除|删掉|去掉|移除)\s*(.+)/);
  if (remove) return { operation: 'remove', target: remove[1]?.trim() };
  const replace = text.match(/(?:替换|换掉)\s*(.+?)\s*(?:为|成|换成)\s*(.+)/);
  if (replace) return { operation: 'replace', target: replace[1]?.trim(), replacement: replace[2]?.trim() };
  const add = text.match(/(?:添加|增加|加上)\s*(.+)/);
  if (add) return { operation: 'add', target: add[1]?.trim() };
  return undefined;
};

function heuristicPatch(text: string): PreferenceExtraction {
  const duration = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|h)/i);
  const time = text.match(/(?:下午|上午|早上|晚上)?\s*(\d{1,2})(?:[:点时](\d{1,2})?)?/);
  const origin = text.match(/(?:从|出发点是|起点是|我在)\s*([^，,。\s]+(?:路|站|广场|机场|酒店|公园|附近)?)/);
  const playPreferences = ['当地美食', '拍照散步', '文化展览', '自然放松', '逛街购物', '夜生活']
    .filter((item) => text.includes(item) || (item === '当地美食' && /吃|美食|本地菜|餐/.test(text)) || (item === '拍照散步' && /散步|拍照/.test(text)))
    .slice(0, 3);
  const travelPreferences = ['步行', '自行车', '公共交通', '打车', '自驾'].filter((item) => text.includes(item));
  return PreferenceExtractionSchema.parse({
    originLabel: origin?.[1],
    startTime: time ? `${String(Number(time[1]) % 24).padStart(2, '0')}:${String(Number(time[2] ?? 0)).padStart(2, '0')}` : undefined,
    availableMinutes: duration ? Math.round(Number(duration[1]) * 60) : undefined,
    playPreferences: playPreferences.length ? playPreferences : undefined,
    travelPreferences: travelPreferences.length ? travelPreferences : undefined,
  });
}

function mergePatch(patch: PreferenceExtraction, text: string): PreferenceExtraction {
  const heuristic = heuristicPatch(text);
  return PreferenceExtractionSchema.parse({
    ...patch,
    originLabel: patch.originLabel ?? heuristic.originLabel,
    startTime: patch.startTime ?? heuristic.startTime,
    availableMinutes: patch.availableMinutes ?? heuristic.availableMinutes,
    playPreferences: patch.playPreferences?.length ? patch.playPreferences : heuristic.playPreferences,
    travelPreferences: patch.travelPreferences?.length ? patch.travelPreferences : heuristic.travelPreferences,
  });
}

export class NativeAgentOrchestrator implements AgentOrchestrator {
  readonly source = 'native' as const;
  constructor(private readonly parser: IntentParser, private readonly clarificationWriter: ClarificationWriter) {}
  async decide(input: { text: string; preference: PreferenceExtraction; phase: AgentSession['phase'] }) {
    let patch: PreferenceExtraction;
    try { patch = mergePatch(PreferenceExtractionSchema.parse(await this.parser.parsePreference(input.text)), input.text); }
    catch { patch = heuristicPatch(input.text); }
    const intent = intentFor(input.text);
    return AgentDecisionSchema.parse({ intent, patch, edit: intent === 'edit_route' ? editFor(input.text) : undefined });
  }
  async clarify(missingFields: string[]) {
    try { return await this.clarificationWriter.writeClarification({ missingFields }); }
    catch { return `请补充：${missingFields.join('、')}。`; }
  }
}

export class DifyWorkflowAgent implements AgentOrchestrator {
  readonly source = 'dify' as const;
  constructor(private readonly config: { apiKey: string; baseUrl: string; workflowPath?: string; timeoutMs?: number }) {}
  async decide(input: { text: string; preference: PreferenceExtraction; phase: AgentSession['phase'] }) {
    const outputs = await this.run({ action: 'decide', text: input.text, currentPreference: input.preference, phase: input.phase });
    return AgentDecisionSchema.parse(outputs);
  }
  async clarify(missingFields: string[]) {
    const outputs = await this.run({ action: 'clarify', missingFields });
    if (!outputs || typeof outputs !== 'object' || typeof (outputs as { message?: unknown }).message !== 'string') throw new Error('Dify clarification output invalid');
    return (outputs as { message: string }).message;
  }
  private async run(inputs: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${this.config.workflowPath ?? '/v1/workflows/run'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs, response_mode: 'blocking', user: 'tripbeam-session' }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 5_000),
    });
    if (!response.ok) throw new Error(`Dify HTTP ${response.status}`);
    const body = await response.json() as { data?: { outputs?: unknown }; outputs?: unknown };
    return body.data?.outputs ?? body.outputs ?? body;
  }
}
