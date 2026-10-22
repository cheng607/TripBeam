import { PreferenceExtractionSchema, type PreferenceExtraction } from '@tripbeam/contracts';
import { z } from 'zod';

export interface IntentParser {
  parsePreference(text: string): Promise<PreferenceExtraction>;
}
export interface RouteCopyWriter {
  writeRouteCopy(facts: { theme: string; poiNames: string[]; riskCodes: string[] }): Promise<string>;
}
export interface ClarificationWriter {
  writeClarification(facts: { missingFields: string[] }): Promise<string>;
}

export class ProviderUnavailableError extends Error {
  constructor(message = '意图解析服务暂不可用') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderInvalidResponseError extends Error {
  constructor(message = '意图解析服务返回了不符合契约的数据') {
    super(message);
    this.name = 'ProviderInvalidResponseError';
  }
}

const SYSTEM_PROMPT = `你是 TripBeam 的偏好提取器。只从用户文本提取明确表达的偏好，输出 JSON 对象，不能输出 Markdown。
允许字段为 originLabel、startTime(HH:mm)、availableMinutes(30–240 的整数分钟)、playPreferences(最多3项)、travelPreferences(仅步行/自行车/公共交通/打车/自驾)、customPreferences(最多5项自由偏好)、notes(最多300字)。
用户说“逛书店”“不吃辣”“带老人”等非标准偏好必须放入 customPreferences，不要擅自改写成路线、POI或标签。
未知字段必须省略。绝不输出 POI、路线、距离、时长总计、路线是否合法或任何规划建议。`;

export class DeepSeekIntentParser implements IntentParser, RouteCopyWriter, ClarificationWriter {
  constructor(private readonly config: { apiKey?: string; baseUrl: string; model: string; timeoutMs?: number }) {}

  async parsePreference(text: string): Promise<PreferenceExtraction> {
    const content = await this.complete(SYSTEM_PROMPT, text);
    try { return PreferenceExtractionSchema.parse(JSON.parse(content)); }
    catch {
      const repaired = await this.complete(`${SYSTEM_PROMPT}\n仅修复下方 JSON 的语法和字段，不新增信息。`, content);
      try { return PreferenceExtractionSchema.parse(JSON.parse(repaired)); }
      catch { throw new ProviderInvalidResponseError(); }
    }
  }

  async writeRouteCopy(facts: { theme: string; poiNames: string[]; riskCodes: string[] }): Promise<string> {
    const content = await this.complete('只根据给定的路线主题、地点名称与风险码写一句中文推荐理由。输出 JSON 对象 {"reason":"..."}。不得声称实时营业、排队、预约，不得计算或改写时间、距离、路线顺序与合规性。', JSON.stringify(facts));
    try { return z.object({ reason: z.string().min(1).max(300) }).strict().parse(JSON.parse(content)).reason; }
    catch { throw new ProviderInvalidResponseError(); }
  }

  async writeClarification(facts: { missingFields: string[] }): Promise<string> {
    const content = await this.complete('根据缺失字段写一句简短、自然的中文补充问题。输出 JSON 对象 {"question":"..."}。只能询问条件，不得推荐地点、路线或计算时间距离。', JSON.stringify(facts));
    try { return z.object({ question: z.string().min(1).max(180) }).strict().parse(JSON.parse(content)).question; }
    catch { throw new ProviderInvalidResponseError(); }
  }

  private async complete(system: string, user: string): Promise<string> {
    if (!this.config.apiKey) throw new ProviderUnavailableError();
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new ProviderUnavailableError(`意图解析服务请求失败（HTTP ${response.status}）`);
    const body: unknown = await response.json();
    return this.readContent(body);
  }

  private readContent(body: unknown): string {
    if (!body || typeof body !== 'object') throw new ProviderInvalidResponseError();
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length !== 1) throw new ProviderInvalidResponseError();
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
    if (typeof content !== 'string') throw new ProviderInvalidResponseError();
    return content;
  }
}
