import cors from '@fastify/cors';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentDecisionSchema, ConversationMessageRequestSchema, EditCommandSchema, ItinerarySchema, PreferenceDraftSchema, PreferenceExtractionSchema, SessionSchema, TurnRequestSchema, type ApiError, type ClarificationResponse, type Poi, type PreferenceValidationResponse, type AgentSession, type TurnResult, type PreferenceExtraction, type AgentDecision } from '@tripbeam/contracts';
import { DeepSeekIntentParser, type ClarificationWriter, type IntentParser, type RouteCopyWriter } from './deepseek.js';
import { AMapProvider, DemoMapProvider, MapProviderError, type MapProvider } from './maps.js';
import { buildRoute, generateItinerary, PlannerError } from './planner.js';
import { FilePlanStore, type PlanStore } from './store.js';
import { PostgresPlanStore } from './pg-store.js';
import { DifyWorkflowAgent, NativeAgentOrchestrator, type AgentOrchestrator } from './agent.js';
import { FileSessionStore, MemorySessionStore, PgSessionStore, authorized, newSession, type SessionRecord, type SessionStore } from './session-store.js';
import { editRoute, feasibleAlternatives, resolveNaturalEdit, restoreRoute, WorkflowError } from './route-service.js';

const fields = ['originLabel', 'startTime', 'availableMinutes', 'playPreferences', 'travelPreferences'] as const;
const idParams = z.object({ id: z.string().uuid() });
const routeParams = idParams.extend({ routeId: z.string().uuid() });
type AppOptions = { intentParser?: IntentParser; clarificationWriter?: ClarificationWriter; copyWriter?: RouteCopyWriter; agent?: AgentOrchestrator; map?: MapProvider; store?: PlanStore; sessionStore?: SessionStore; logger?: boolean };

export function createApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: process.env.TRUST_PROXY === 'true', genReqId: () => randomUUID() });
  const rateLimit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120);
  const buckets = new Map<string, { resetAt: number; count: number }>();
  const llm = new DeepSeekIntentParser({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat', timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 10_000) });
  const parser = options.intentParser ?? llm;
  const clarificationWriter = options.clarificationWriter ?? llm;
  const copyWriter = options.copyWriter ?? llm;
  const nativeAgent = new NativeAgentOrchestrator(parser, clarificationWriter);
  const agent: AgentOrchestrator = options.agent ?? (process.env.DIFY_API_KEY ? new DifyWorkflowAgent({ apiKey: process.env.DIFY_API_KEY, baseUrl: process.env.DIFY_BASE_URL ?? 'http://127.0.0.1', workflowPath: process.env.DIFY_WORKFLOW_PATH }) : nativeAgent);
  // Serialize reads and writes for one session, including idempotent retries.
  // Multi-process deployment still requires a shared transaction/lock strategy.
  const sessionTurns = new Map<string, Promise<void>>();
  async function inSessionOrder<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionTurns.get(id) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    sessionTurns.set(id, pending);
    await previous;
    try { return await operation(); }
    finally { release(); if (sessionTurns.get(id) === pending) sessionTurns.delete(id); }
  }
  const map = options.map ?? (process.env.DEMO_MAP === 'true' ? new DemoMapProvider() : new AMapProvider(process.env.AMAP_WEB_KEY));
  const store: PlanStore = options.store ?? (process.env.DATABASE_URL
    ? new PostgresPlanStore(process.env.DATABASE_URL)
    : new FilePlanStore(process.env.TRIPBEAM_DATA_FILE || fileURLToPath(new URL('../data/itineraries.json', import.meta.url))));
  const sessionStore: SessionStore = options.sessionStore ?? (process.env.DATABASE_URL
    ? new PgSessionStore(process.env.DATABASE_URL)
    : new FileSessionStore(process.env.TRIPBEAM_SESSION_FILE || fileURLToPath(new URL('../data/sessions.json', import.meta.url))));
  const configuredRetentionDays = Number(process.env.TRIPBEAM_DRAFT_TTL_DAYS ?? 30);
  const retentionDays = Number.isFinite(configuredRetentionDays) && configuredRetentionDays > 0 ? configuredRetentionDays : 30;
  const cleanupExpiredData = async () => {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    await sessionStore.deleteExpired(cutoff);
    await store.deleteExpiredDrafts(cutoff);
  };
  let cleanupTimer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    await cleanupExpiredData();
    cleanupTimer = setInterval(() => { void cleanupExpiredData().catch((error) => app.log.error(error, 'retention cleanup failed')); }, 6 * 60 * 60 * 1000);
    cleanupTimer.unref();
  });
  app.addHook('onClose', async () => { if (cleanupTimer) clearInterval(cleanupTimer); });
  if (!options.store && store instanceof PostgresPlanStore) app.addHook('onClose', async () => { await store.close(); });
  if (!options.sessionStore && sessionStore instanceof PgSessionStore) app.addHook('onClose', async () => { await sessionStore.close?.(); });
  const allowedOrigins = (process.env.WEB_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? ['http://127.0.0.1:4173', 'http://localhost:4173']);
  void app.register(cors, { origin: allowedOrigins, credentials: false });
  app.addHook('onRequest', async (request, reply) => {
    if (rateLimit <= 0 || request.method === 'GET' || request.url === '/health' || request.url === '/ready') return;
    const now = Date.now(); const key = request.ip; const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { resetAt: now + 60_000, count: 0 } : current;
    bucket.count += 1; buckets.set(key, bucket);
    if (bucket.count > rateLimit) return reply.code(429).header('Retry-After', Math.ceil((bucket.resetAt - now) / 1000)).send(apiError(request.id, 'INTERNAL_ERROR', '请求过于频繁，请稍后重试。'));
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/health', async () => ({ status: 'ok' as const, mapConfigured: Boolean(options.map || process.env.AMAP_WEB_KEY || process.env.DEMO_MAP === 'true'), mapMode: process.env.DEMO_MAP === 'true' ? 'demo' : 'amap', storageMode: process.env.DATABASE_URL ? 'postgres' : 'file', llmConfigured: Boolean(options.intentParser || process.env.DEEPSEEK_API_KEY || process.env.DIFY_API_KEY), agentSource: agent.source }));
  app.get('/ready', async (_request, reply) => {
    const production = process.env.NODE_ENV === 'production';
    const issues: string[] = [];
    if (production && process.env.DEMO_MAP === 'true') issues.push('DEMO_MAP must be false in production');
    if (!options.map && !process.env.DEMO_MAP && !process.env.AMAP_WEB_KEY) issues.push('AMAP_WEB_KEY is missing');
    if (!options.agent && !process.env.DEEPSEEK_API_KEY && !process.env.DIFY_API_KEY) issues.push('DEEPSEEK_API_KEY or DIFY_API_KEY is missing');
    if (production && !process.env.DATABASE_URL) issues.push('DATABASE_URL is required in production');
    if (production && !process.env.WEB_ORIGIN) issues.push('WEB_ORIGIN is required in production');
    if (process.env.DATABASE_URL) {
      try { await Promise.all([store.healthCheck?.(), sessionStore.healthCheck?.()]); }
      catch { issues.push('PostgreSQL health check failed'); }
    }
    const warnings = !process.env.DATABASE_URL ? ['DATABASE_URL 未配置，当前使用本地文件存储，仅适合单进程开发。'] : [];
    return issues.length ? reply.code(503).send({ status: 'not_ready', issues, warnings }) : reply.send({ status: 'ready', warnings });
  });
  app.post('/v1/preferences/validate', async (request, reply) => {
    const parsed = PreferenceDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    const response: PreferenceValidationResponse = { requestId: request.id, accepted: true, preference: parsed.data, plannerStatus: 'not_started' };
    return reply.send(response);
  });
  app.post('/v1/sessions', async (request, reply) => {
    const created = newSession(); await sessionStore.put(created.record);
    return reply.code(201).send({ requestId: request.id, token: created.token, session: created.record.session });
  });
  app.delete('/v1/sessions/:id', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationError(request.id, params.error.issues));
    return inSessionOrder(params.data.id, async () => {
      const record = await sessionStore.get(params.data.id);
      if (!authorized(record, String(request.headers['x-session-token'] ?? '')) || !record) return reply.code(401).send(apiError(request.id, 'NOT_FOUND', '会话不存在或令牌无效。'));
      await store.deleteDraftsByOwner(record.session.id);
      await sessionStore.delete(record.session.id);
      return reply.send({ requestId: request.id, deleted: true });
    });
  });
  app.get('/v1/sessions/:id', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationError(request.id, params.error.issues));
    const record = await sessionStore.get(params.data.id);
    if (!authorized(record, String(request.headers['x-session-token'] ?? '')) || !record) return reply.code(401).send(apiError(request.id, 'NOT_FOUND', '会话不存在或令牌无效。'));
    await sessionStore.put(record);
    return reply.send({ requestId: request.id, session: SessionSchema.parse(record.session) });
  });
  app.post('/v1/sessions/:id/turns', async (request, reply) => {
    const params = idParams.safeParse(request.params); const body = TurnRequestSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationError(request.id, params.error.issues));
    if (!body.success) return reply.code(400).send(validationError(request.id, body.error.issues));
    return inSessionOrder(params.data.id, async () => {
      const record = await sessionStore.get(params.data.id);
      const token = String(request.headers['x-session-token'] ?? '');
      if (!authorized(record, token)) return reply.code(401).send(apiError(request.id, 'NOT_FOUND', '会话不存在或令牌无效。'));
      if (!record) return reply.code(404).send(apiError(request.id, 'NOT_FOUND', '会话不存在。'));
      const fingerprint = JSON.stringify(body.data);
      const previous = record.turns[body.data.turnId];
      if (previous?.fingerprint === fingerprint) { await sessionStore.put(record); return reply.send(previous.result); }
      if (previous) return reply.code(409).send(apiError(request.id, 'VERSION_CONFLICT', '同一轮请求不能使用不同内容，请重新发送。'));
      try {
        const result = await handleTurn(record, body.data, { agent, nativeAgent, map, store, requestId: request.id, log: app.log });
        record.turns[body.data.turnId] = { fingerprint, result };
        await sessionStore.put(record);
        return reply.send(result);
      } catch (error) { return sendError(reply, request.id, error); }
    });
  });
  app.post('/internal/planner/merge-and-check', async (request, reply) => {
    if (!internalAuthorized(request.headers['x-planner-token'])) return reply.code(401).send(apiError(request.id, 'NOT_FOUND', '内部接口未授权。'));
    const body = z.object({ current: PreferenceExtractionSchema, patch: PreferenceExtractionSchema }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send(validationError(request.id, body.error.issues));
    const preference = mergePreference(body.data.current, body.data.patch); const missingFields = missingPreferenceFields(preference);
    return reply.send({ requestId: request.id, preference, missingFields, ready: missingFields.length === 0 });
  });
  app.post('/internal/planner/generate', async (request, reply) => {
    if (!internalAuthorized(request.headers['x-planner-token'])) return reply.code(401).send(apiError(request.id, 'NOT_FOUND', '内部接口未授权。'));
    const parsed = PreferenceDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    try { return reply.send(await generateItinerary(parsed.data, map)); } catch (error) { return sendError(reply, request.id, error); }
  });
  app.post('/internal/planner/edit', async (request, reply) => {
    if (!internalAuthorized(request.headers['x-planner-token'])) return reply.code(401).send(apiError(request.id, 'NOT_FOUND', '内部接口未授权。'));
    const body = z.object({ itineraryId: z.string().uuid(), routeId: z.string().uuid(), command: EditCommandSchema }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send(validationError(request.id, body.error.issues));
    try { const result = await editRoute(store, map, body.data.itineraryId, body.data.routeId, body.data.command); return reply.send({ requestId: request.id, itinerary: result.itinerary }); }
    catch (error) { return sendError(reply, request.id, error); }
  });
  app.post('/v1/conversations/:conversationId/messages', async (request, reply) => {
    const parsed = ConversationMessageRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    try {
      const decision = await agent.decide({ text: parsed.data.text, preference: {}, phase: 'collecting' });
      const preference = PreferenceExtractionSchema.parse(decision.patch);
      const missingFields = missingPreferenceFields(preference);
      let message = missingFields.length ? '还需要确认几项出行条件。' : '偏好已提取，请核对后继续规划。';
      if (missingFields.length) try { message = z.string().min(1).max(180).parse(await clarificationWriter.writeClarification({ missingFields })); } catch { /* Keep deterministic prompt. */ }
      const response: ClarificationResponse = { requestId: request.id, status: missingFields.length ? 'needs_user_input' : 'ready_for_planner', preference, missingFields, message, source: agent.source === 'fallback' || decision.usedFallback ? 'fallback' : 'llm' };
      return reply.send(response);
    } catch {
      const response: ClarificationResponse = { requestId: request.id, status: 'needs_user_input', preference: {}, missingFields: [...fields], message: '请在表单中确认出行条件。', source: 'fallback' };
      return reply.send(response);
    }
  });
  app.post('/v1/locations/resolve', async (request, reply) => {
    const parsed = z.object({ text: z.string().trim().min(1).max(120) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    try { return reply.send({ requestId: request.id, ...await map.resolve(parsed.data.text) }); }
    catch (error) { return sendError(reply, request.id, error); }
  });
  app.get('/v1/locations/resolve', async (request, reply) => reply.code(405).send(apiError(request.id, 'VALIDATION_ERROR', '该接口只接受 POST，请提交 {"text":"地点名称"}。')));
  app.post('/v1/itineraries/generate', async (request, reply) => {
    const parsed = PreferenceDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    try {
      const generated = await generateItinerary(parsed.data, map);
      await Promise.all(generated.itinerary.routes.map(async (route) => {
        try { route.recommendationReason = z.string().min(1).max(300).parse(await copyWriter.writeRouteCopy({ theme: route.title, poiNames: route.pois.map((poi) => poi.name), riskCodes: route.risks })); }
        catch { /* Keep deterministic copy. */ }
      }));
      generated.itinerary = ItinerarySchema.parse(generated.itinerary);
      await store.putPlan(generated);
      return reply.code(201).send({ requestId: request.id, itinerary: generated.itinerary });
    } catch (error) { return sendError(reply, request.id, error); }
  });
  app.get('/v1/itineraries/:id', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    const plan = await store.getPlan(parsed.data.id);
    return plan ? reply.send({ requestId: request.id, itinerary: plan.itinerary }) : reply.code(404).send(apiError(request.id, 'NOT_FOUND', '行程不存在。'));
  });
  app.get('/v1/itineraries/:id/routes/:routeId/alternatives', async (request, reply) => {
    const parsed = routeParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    const query = z.object({ replacePoiId: z.string().min(1).optional() }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send(validationError(request.id, query.error.issues));
    const plan = await store.getPlan(parsed.data.id);
    const route = plan?.itinerary.routes.find((item) => item.id === parsed.data.routeId);
    if (!plan || !route) return reply.code(404).send(apiError(request.id, 'NOT_FOUND', '路线不存在。'));
    try { return reply.send({ requestId: request.id, alternatives: await feasibleAlternatives(plan, route.id, map, query.data.replacePoiId) }); }
    catch (error) { return sendError(reply, request.id, error); }
  });
  app.post('/v1/itineraries/:id/routes/:routeId/edits', async (request, reply) => {
    const parsed = routeParams.safeParse(request.params); const command = EditCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    if (!command.success) return reply.code(400).send(validationError(request.id, command.error.issues));
    try { const result = await editRoute(store, map, parsed.data.id, parsed.data.routeId, command.data); return reply.send({ requestId: request.id, itinerary: result.itinerary }); }
    catch (error) { return sendError(reply, request.id, error); }
  });
  app.post('/v1/itineraries/:id/routes/:routeId/restore', async (request, reply) => {
    const parsed = routeParams.safeParse(request.params);
    const body = z.object({ baseVersion: z.number().int().min(1) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    if (!body.success) return reply.code(400).send(validationError(request.id, body.error.issues));
    try {
      const result = await restoreRoute(store, parsed.data.id, body.data.baseVersion, parsed.data.routeId);
      return reply.send({ requestId: request.id, itinerary: result.itinerary });
    } catch (error) { return sendError(reply, request.id, error); }
  });
  app.post('/v1/itineraries/:id/save', async (request, reply) => {
    const parsed = idParams.safeParse(request.params); const body = z.object({ baseVersion: z.number().int().min(1) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    if (!body.success) return reply.code(400).send(validationError(request.id, body.error.issues));
    const result = await store.save(parsed.data.id, body.data.baseVersion);
    if (result === 'conflict') return reply.code(409).send(apiError(request.id, 'VERSION_CONFLICT', '版本不一致，请刷新后保存。'));
    return result ? reply.send({ requestId: request.id, itinerary: result.itinerary }) : reply.code(404).send(apiError(request.id, 'NOT_FOUND', '行程不存在。'));
  });
  app.post('/v1/itineraries/:id/share', async (request, reply) => {
    const parsed = idParams.safeParse(request.params); const body = z.object({ routeId: z.string().uuid() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    if (!body.success) return reply.code(400).send(validationError(request.id, body.error.issues));
    const snapshot = await store.share(parsed.data.id, body.data.routeId);
    return snapshot ? reply.code(201).send({ requestId: request.id, snapshot }) : reply.code(409).send(apiError(request.id, 'NOT_SAVED', '请先保存当前有效版本，再创建分享。'));
  });
  app.get('/v1/shares/:token', async (request, reply) => {
    const parsed = z.object({ token: z.string().min(24).max(128) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send(validationError(request.id, parsed.error.issues));
    const snapshot = await store.getShare(parsed.data.token);
    return snapshot ? reply.send({ requestId: request.id, snapshot }) : reply.code(404).send(apiError(request.id, 'NOT_FOUND', '分享链接不存在。'));
  });
  return app;
}

function apiError(requestId: string, code: ApiError['code'], message: string): ApiError { return { requestId, code, message }; }
function validationError(requestId: string, issues: Array<{ path: PropertyKey[]; message: string }>): ApiError {
  return { ...apiError(requestId, 'VALIDATION_ERROR', '请求参数不符合接口契约。'), details: issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message })) };
}
function sendError(reply: { code: (status: number) => { send: (data: ApiError) => unknown } }, requestId: string, error: unknown) {
  if (error instanceof WorkflowError) return reply.code(error.status).send(apiError(requestId, error.status === 409 ? 'VERSION_CONFLICT' : 'VALIDATION_ERROR', error.message));
  if (error instanceof MapProviderError) return reply.code(['LOCATION_NOT_FOUND', 'LOCATION_AMBIGUOUS', 'LOCATION_CITY_MISMATCH'].includes(error.code) ? 422 : 503).send(apiError(requestId, error.code, error.message));
  if (error instanceof PlannerError) return reply.code(422).send(apiError(requestId, error.code, error.message));
  return reply.code(500).send(apiError(requestId, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。'));
}

function internalAuthorized(value: unknown) { return !process.env.PLANNER_INTERNAL_TOKEN || value === process.env.PLANNER_INTERNAL_TOKEN; }
function missingPreferenceFields(preference: PreferenceExtraction) { return fields.filter((field) => preference[field] === undefined || (Array.isArray(preference[field]) && !preference[field].length)); }
function mergePreference(current: PreferenceExtraction, patch: PreferenceExtraction, append = false): PreferenceExtraction {
  const merged = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  if (append) {
    if (patch.playPreferences) merged.playPreferences = [...new Set([...(current.playPreferences ?? []), ...patch.playPreferences])].slice(-3);
    if (patch.travelPreferences) merged.travelPreferences = [...new Set([...(current.travelPreferences ?? []), ...patch.travelPreferences])].slice(0, 5) as PreferenceExtraction['travelPreferences'];
    if (patch.customPreferences) merged.customPreferences = [...new Set([...(current.customPreferences ?? []), ...patch.customPreferences])].slice(-5);
  }
  return PreferenceExtractionSchema.parse(merged);
}

async function handleTurn(record: SessionRecord, request: z.infer<typeof TurnRequestSchema>, deps: { agent: AgentOrchestrator; nativeAgent: AgentOrchestrator; map: MapProvider; store: PlanStore; requestId: string; log: { info: (data: object, message: string) => void; warn: (data: object, message: string) => void } }): Promise<TurnResult> {
  const session = record.session;
  session.revision += 1;
  session.messages.push({ role: 'user', text: request.text, createdAt: new Date().toISOString() });
  let decision: AgentDecision; let source: TurnResult['source'] = deps.agent.source;
  try {
    if (request.action === 'confirm_preferences') { decision = { intent: 'collect_preference', patch: request.preferencePatch ?? {} }; source = 'form'; }
    else if (request.action === 'regenerate') decision = { intent: 'regenerate', patch: request.preferencePatch ?? {} };
    else if (request.action === 'explain_route') decision = { intent: 'explain_route', patch: {} };
    else { const result = await deps.agent.decide({ text: request.text, preference: session.preference, phase: session.phase }); decision = result; if (result.usedFallback) source = 'fallback'; }
  } catch {
    source = 'fallback';
    try { decision = await deps.nativeAgent.decide({ text: request.text, preference: session.preference, phase: session.phase }); }
    catch { decision = { intent: 'unknown', patch: {} }; }
  }
  session.preference = mergePreference(session.preference, decision.patch, request.action === 'message' && /也|还想|另外|同时/.test(request.text) && !/只|不要|不想|改为|改成/.test(request.text));
  const missingFields = missingPreferenceFields(session.preference);
  if (['collect_preference', 'regenerate'].includes(decision.intent) && missingFields.length) {
    session.phase = 'needs_user_input'; let message: string;
    try { message = z.string().trim().min(1).max(240).parse(await deps.agent.clarify(missingFields.slice(0, 3))); } catch { message = await deps.nativeAgent.clarify(missingFields); }
    session.messages.push({ role: 'assistant', text: message, createdAt: new Date().toISOString() });
    return { requestId: deps.requestId, session, intent: decision.intent, source, message, missingFields, fieldsToAsk: missingFields.slice(0, 3), warnings: [], steps: ['解析本轮偏好', '合并会话偏好', '等待补充必填条件'], actions: ['confirm_preferences', 'adjust_preferences'] };
  }
  if (decision.intent === 'unknown') {
    const message = '我可以继续收集出行偏好、生成路线，或编辑当前路线。请告诉我想调整什么。'; session.phase = 'collecting';
    session.messages.push({ role: 'assistant', text: message, createdAt: new Date().toISOString() });
    return { requestId: deps.requestId, session, intent: 'unknown', source, message, missingFields, fieldsToAsk: [], warnings: [], steps: ['识别到无法判断的操作'], actions: ['adjust_preferences'] };
  }
  if (decision.intent === 'explain_route') {
    const itineraryId = request.itineraryId ?? session.itineraryId;
    const plan = itineraryId ? await deps.store.getPlan(itineraryId) : null;
    const route = plan?.itinerary.routes.find((item) => item.id === (request.routeId ?? session.routeId)) ?? (!request.routeId ? plan?.itinerary.routes[0] : undefined);
    if (!plan || !route) {
      const message = '先选择一条路线，我会根据已验证的地点、时间和取舍解释安排。';
      session.messages.push({ role: 'assistant', text: message, createdAt: new Date().toISOString() });
      return { requestId: deps.requestId, session, intent: decision.intent, source, message, missingFields, fieldsToAsk: [], warnings: [], steps: ['等待选择路线'], actions: ['compare'] };
    }
    if (plan.ownerSessionId && plan.ownerSessionId !== session.id) throw new WorkflowError('这条行程属于另一会话，请返回原会话后继续。', 403);
    session.itineraryId = plan.itinerary.id; session.routeId = route.id; session.preference = plan.itinerary.preference;
    const message = `${route.recommendationReason} ${route.tradeoff ?? ''} 预计共 ${route.totalDurationMinutes} 分钟，可用时间余量 ${route.remainingMinutes ?? route.bufferMinutes} 分钟；按 ${route.pois.map((poi) => poi.name).join(' → ')} 的顺序出行。营业、预约和现场交通仍需出发前确认。`;
    session.messages.push({ role: 'assistant', text: message, createdAt: new Date().toISOString() });
    return { requestId: deps.requestId, session, intent: decision.intent, source, message, missingFields: [], fieldsToAsk: [], warnings: route.risks, steps: ['读取已验证路线', '解释推荐理由与取舍'], itinerary: plan.itinerary, actions: ['compare', 'edit'] };
  }
  if (decision.intent === 'edit_route') {
    const itineraryId = request.itineraryId ?? session.itineraryId; const routeId = request.routeId ?? session.routeId;
    if (!itineraryId || !routeId || !decision.edit) { const message = '请先打开一条路线，并明确要添加、删除、替换或排序的地点。'; return { requestId: deps.requestId, session, intent: decision.intent, source, message, missingFields: [], fieldsToAsk: [], warnings: [], steps: ['等待路线编辑上下文'], actions: ['edit'] }; }
    const plan = await deps.store.getPlan(itineraryId); if (!plan) throw new WorkflowError('行程不存在。', 404);
    if (plan.ownerSessionId && plan.ownerSessionId !== session.id) throw new WorkflowError('这条行程属于另一会话，请返回原会话后继续。', 403);
    const command = resolveNaturalEdit(plan, routeId, decision.edit); if (request.baseVersion) command.baseVersion = request.baseVersion;
    const result = await editRoute(deps.store, deps.map, itineraryId, routeId, command);
    session.itineraryId = itineraryId; session.routeId = routeId; session.itineraryIds = [...new Set([...session.itineraryIds, itineraryId])];
    const itinerary = result.itinerary; session.preference = itinerary.preference; session.phase = itinerary.invalidDraft ? 'invalid_draft' : itinerary.status;
    const message = itinerary.invalidDraft ? '编辑已保留为草稿，但暂未通过时间或距离约束。' : '路线已按你的指令重新校验。';
    session.messages.push({ role: 'assistant', text: message, createdAt: new Date().toISOString() });
    return { requestId: deps.requestId, session, intent: decision.intent, source, message, missingFields: [], fieldsToAsk: [], warnings: itinerary.invalidDraft ? itinerary.invalidDraft.violations.map((v) => v.message) : [], steps: ['解析编辑命令', '确定性重算路线', '校验时间与距离约束'], itinerary, actions: itinerary.invalidDraft ? ['restore', 'edit', 'adjust_preferences'] : ['compare', 'edit'] };
  }
  if (missingFields.length) throw new WorkflowError('请先补充出行条件。');
  const preference = PreferenceDraftSchema.parse(session.preference);
  const previousPlans = await Promise.all(session.itineraryIds.map((id) => deps.store.getPlan(id)));
  const previousSignatures = previousPlans.flatMap((plan) => plan?.itinerary.routes.map((r) => r.pois.map((p) => p.id).join('|')) ?? []);
  let generated;
  try { generated = await generateItinerary(preference, deps.map, previousSignatures); }
  catch (error) {
    if (!(error instanceof MapProviderError) && !(error instanceof PlannerError)) throw error;
    session.phase = error instanceof PlannerError ? 'no_route' : 'error';
    const diagnostics = error.diagnostics;
    const message = error.message + (diagnostics ? ' ' + diagnostics.summary : '') + ' 已保留你的出行条件，可以调整条件或重试。';
    session.messages.push({ role: 'assistant', text: message, createdAt: new Date().toISOString() });
    deps.log.warn({ requestId: deps.requestId, plannerRunId: diagnostics?.plannerRunId, planner: diagnostics, code: error.code }, 'planner did not produce a route');
    return { requestId: deps.requestId, session, intent: decision.intent, source, message, missingFields: [], fieldsToAsk: [], warnings: [error.code], steps: ['已保存出行条件', '规划暂未完成'], ...(diagnostics ? { planningDiagnostics: diagnostics } : {}), actions: ['retry', 'adjust_preferences'] };
  }
  await deps.store.putPlan({ ...generated, ownerSessionId: session.id });
  session.itineraryId = generated.itinerary.id; session.routeId = generated.itinerary.routes[0]?.id; session.itineraryIds = [...new Set([...session.itineraryIds, generated.itinerary.id])];
  session.phase = generated.itinerary.status === 'degraded' ? 'degraded' : 'complete';
  const message = decision.intent === 'regenerate' ? '已基于当前偏好生成另一组路线。' : '偏好已确认，已生成可对比路线。';
  session.messages.push({ role: 'assistant', text: message, createdAt: new Date().toISOString() });
  deps.log.info({ requestId: deps.requestId, plannerRunId: generated.diagnostics.plannerRunId, planner: generated.diagnostics }, 'planner completed');
  return { requestId: deps.requestId, session, intent: decision.intent, source, message, missingFields: [], fieldsToAsk: [], warnings: generated.itinerary.routes.flatMap((r) => r.risks), steps: ['解析用户意图', '合并并校验偏好', '筛选 POI', 'Beam Search 组路', '校验路线约束'], planningDiagnostics: generated.diagnostics, itinerary: generated.itinerary, actions: ['compare', 'edit'] };
}
