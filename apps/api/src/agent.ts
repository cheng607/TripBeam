import { AgentDecisionSchema, PreferenceExtractionSchema, type AgentDecision, type AgentSession, type PreferenceExtraction } from '@tripbeam/contracts';
import type { ClarificationWriter, IntentParser } from './deepseek.js';

export interface AgentOrchestrator {
  readonly source: 'dify' | 'native' | 'fallback';
  decide(input: { text: string; preference: PreferenceExtraction; phase: AgentSession['phase'] }): Promise<AgentDecision & { usedFallback?: boolean }>;
  clarify(missingFields: string[]): Promise<string>;
}

const intentFor = (text: string): AgentDecision['intent'] => {
  if (/(重新生成|再来一条|换一条|重新规划)/.test(text)) return 'regenerate';
  if (/(?:改成|改为|只想|只愿意|只用|只选)(?:步行|自行车|公共交通|打车|自驾|\d+\s*(?:小时|分钟))/.test(text)) return 'collect_preference';
  if (/(删除|删掉|去掉|移除)/.test(text)) return 'edit_route';
  if (/(替换|换成|换一个|改成|添加|增加|加上|排序|重新排列)/.test(text)) return 'edit_route';
  if (/(为什么|怎么安排|解释|推荐理由)/.test(text)) return 'explain_route';
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

const numberValue = (value: string): number => {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '半') return 0.5;
  if (value.includes('十')) { const [tens, units] = value.split('十'); return (digits[tens!] ?? 1) * 10 + (digits[units!] ?? 0); }
  return digits[value] ?? NaN;
};

// The fallback only extracts explicit units. A duration or street number must
// never become a departure time, and unsupported values remain unanswered.
export function heuristicPatch(text: string): PreferenceExtraction {
  const number = '[\\d零一二两三四五六七八九十]+(?:\\.\\d+)?';
  const hours = text.match(new RegExp(`(${number}|半)\\s*个?(半)?\\s*(?:小时|h)(半)?`, 'i'));
  const minutes = text.match(new RegExp(`(${number})\\s*分钟`));
  const availableMinutes = hours ? Math.round((numberValue(hours[1]!) + (hours[2] || hours[3] ? 0.5 : 0)) * 60) : minutes ? numberValue(minutes[1]!) : undefined;
  const time = text.match(new RegExp(`(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚)?\\s*(${number})(?:[:：](\\d{2})|点(?:(半)|(${number})分?)?)`));
  let hour = time ? numberValue(time[2]!) : undefined;
  const minute = time ? time[3] ? Number(time[3]) : time[4] ? 30 : time[5] ? numberValue(time[5]) : 0 : undefined;
  if (hour !== undefined && hour < 12 && /中午|下午|傍晚|晚上|今晚/.test(time?.[1] ?? '')) hour += 12;
  if (hour === 12 && /凌晨|早上|上午/.test(time?.[1] ?? '')) hour = 0;
  const startTime = hour !== undefined && minute !== undefined && Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : undefined;
  const origin = text.match(/(?:从|出发点是|起点是|我在)\s*([^，,。\s]+)/);
  const originLabel = origin?.[1]?.replace(/(?:出发|开始).*$/, '').trim();
  const playPreferences = ['当地美食', '拍照散步', '文化展览', '自然放松', '逛街购物', '夜生活']
    .filter((item) => text.includes(item) || (item === '当地美食' && /吃|美食|本地菜|餐/.test(text)) || (item === '拍照散步' && /散步|拍照/.test(text)))
    .slice(0, 3);
  const travelPreferences = ['步行', '自行车', '公共交通', '打车', '自驾'].filter((item) => text.includes(item) && !new RegExp(`(?:不|别|不要|不想|不愿意|不考虑)(?:再|坐|骑|用|选择)?${item}`).test(text));
  const customPreferences = text.split(/[，,。；;、]/).map((item) => item.trim()).filter((item) => /不吃辣|少走路|不想太累|带老人|带小孩|带孩子|轮椅|书店|咖啡/.test(item) && item.length <= 30).slice(0, 5);
  return PreferenceExtractionSchema.parse({
    originLabel: originLabel && originLabel.length <= 120 ? originLabel : undefined,
    startTime,
    availableMinutes: availableMinutes !== undefined && availableMinutes >= 30 && availableMinutes <= 240 ? availableMinutes : undefined,
    playPreferences: playPreferences.length ? playPreferences : undefined,
    travelPreferences: travelPreferences.length ? travelPreferences : undefined,
    customPreferences: customPreferences.length ? customPreferences : undefined,
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
    customPreferences: patch.customPreferences?.length ? patch.customPreferences : heuristic.customPreferences,
  });
}

export class NativeAgentOrchestrator implements AgentOrchestrator {
  readonly source = 'native' as const;
  constructor(private readonly parser: IntentParser, private readonly clarificationWriter: ClarificationWriter) {}
  async decide(input: { text: string; preference: PreferenceExtraction; phase: AgentSession['phase'] }) {
    let patch: PreferenceExtraction; let usedFallback = false;
    try { patch = mergePatch(PreferenceExtractionSchema.parse(await this.parser.parsePreference(input.text)), input.text); }
    catch { patch = heuristicPatch(input.text); usedFallback = true; }
    const intent = intentFor(input.text);
    return { ...AgentDecisionSchema.parse({ intent, patch, edit: intent === 'edit_route' ? editFor(input.text) : undefined }), usedFallback };
  }
  async clarify(missingFields: string[]) {
    try { const message = await this.clarificationWriter.writeClarification({ missingFields: missingFields.slice(0, 3) }); if (!message.trim() || message.length > 240) throw new Error('Invalid clarification'); return message; }
    catch {
      const labels: Record<string, string> = { originLabel: '出发地点', startTime: '出发时间', availableMinutes: '可用时长（30 分钟至 4 小时）', playPreferences: '想体验的内容', travelPreferences: '可接受的交通方式' };
      return `再告诉我${missingFields.slice(0, 3).map((field) => labels[field] ?? field).join('、')}，就能继续规划。`;
    }
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
