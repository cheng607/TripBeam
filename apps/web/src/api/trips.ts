import { ApiErrorSchema, ClarificationResponseSchema, GenerateResponseSchema, ItinerarySchema, PoiSchema, ShareSnapshotSchema, SessionSchema, TurnResultSchema, type EditCommand, type Itinerary, type Poi, type PreferenceDraft, type ShareSnapshot, type AgentSession, type TurnResult } from '@tripbeam/contracts';
import { z } from 'zod';

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3101';

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); this.name = 'ApiRequestError'; }
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(90_000), headers: { 'Content-Type': 'application/json', ...init?.headers } }); }
  catch (error) { throw new Error(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? '规划等待时间较长，请稍后重试。你的输入已保留。' : '暂时无法连接规划服务，请检查网络后重试。'); }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error('规划服务返回了无效响应。'); }
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    throw new ApiRequestError(parsed.success ? parsed.data.message : `请求失败（${response.status}）`, response.status, parsed.success ? parsed.data.code : undefined);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('规划服务响应不符合接口契约。');
  return parsed.data;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
export const parseIntent = (text: string) => request('/v1/conversations/local/messages', ClarificationResponseSchema, json({ text }));
export const createSession = () => request('/v1/sessions', z.object({ requestId: z.string().uuid(), token: z.string().min(20), session: SessionSchema }).strict(), json({}));
export const deleteSession = (id: string, token: string) => request(`/v1/sessions/${encodeURIComponent(id)}`, z.object({ requestId: z.string().uuid(), deleted: z.literal(true) }).strict(), { method: 'DELETE', headers: { 'x-session-token': token } });
export const getSession = (id: string, token: string): Promise<AgentSession> => request(`/v1/sessions/${encodeURIComponent(id)}`, z.object({ requestId: z.string().uuid(), session: SessionSchema }).strict(), { headers: { 'x-session-token': token } }).then((value) => value.session);
export const sendSessionTurn = (sessionId: string, token: string, body: { turnId: string; text: string; action?: 'message' | 'confirm_preferences' | 'regenerate' | 'explain_route'; preferencePatch?: Partial<PreferenceDraft>; itineraryId?: string; routeId?: string; baseVersion?: number }): Promise<TurnResult> => request(`/v1/sessions/${sessionId}/turns`, TurnResultSchema, { ...json(body), headers: { 'x-session-token': token } });
export const generateTrip = (preference: PreferenceDraft) => request('/v1/itineraries/generate', GenerateResponseSchema, json(preference)).then((value) => value.itinerary);
export const getTrip = (id: string): Promise<Itinerary> => request(`/v1/itineraries/${encodeURIComponent(id)}`, GenerateResponseSchema).then((value) => value.itinerary);
export const getAlternatives = (id: string, routeId: string, replacePoiId?: string): Promise<Poi[]> => request(`/v1/itineraries/${encodeURIComponent(id)}/routes/${encodeURIComponent(routeId)}/alternatives${replacePoiId ? `?replacePoiId=${encodeURIComponent(replacePoiId)}` : ''}`, z.object({ requestId: z.string().uuid(), alternatives: z.array(PoiSchema) }).strict()).then((value) => value.alternatives);
export const editTrip = (id: string, routeId: string, command: EditCommand): Promise<Itinerary> => request(`/v1/itineraries/${encodeURIComponent(id)}/routes/${encodeURIComponent(routeId)}/edits`, GenerateResponseSchema, json(command)).then((value) => value.itinerary);
export const saveTrip = (id: string, baseVersion: number): Promise<Itinerary> => request(`/v1/itineraries/${encodeURIComponent(id)}/save`, GenerateResponseSchema, json({ baseVersion })).then((value) => value.itinerary);
export const restoreTrip = (id: string, routeId: string, baseVersion: number): Promise<Itinerary> => request(`/v1/itineraries/${encodeURIComponent(id)}/routes/${encodeURIComponent(routeId)}/restore`, GenerateResponseSchema, json({ baseVersion })).then((value) => value.itinerary);
export const createShare = (id: string, routeId: string): Promise<ShareSnapshot> => request(`/v1/itineraries/${encodeURIComponent(id)}/share`, z.object({ requestId: z.string().uuid(), snapshot: ShareSnapshotSchema }).strict(), json({ routeId })).then((value) => value.snapshot);
export const getShare = (token: string): Promise<ShareSnapshot> => request(`/v1/shares/${encodeURIComponent(token)}`, z.object({ requestId: z.string().uuid(), snapshot: ShareSnapshotSchema }).strict()).then((value) => value.snapshot);
export const validateTripResponse = ItinerarySchema.parse;
