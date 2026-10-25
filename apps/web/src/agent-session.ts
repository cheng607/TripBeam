import { SessionSchema, type AgentSession } from '@tripbeam/contracts';
import { z } from 'zod';
import { ApiRequestError, createSession, getSession, sendSessionTurn } from './api/trips';

const STORAGE_KEY = 'tripbeam-agent-session-v1';
const StoredSessionSchema = z.object({ token: z.string().min(20), session: SessionSchema });
export type SessionConnection = z.infer<typeof StoredSessionSchema>;
export type AgentTurn = Parameters<typeof sendSessionTurn>[2];
let connection: SessionConnection | undefined;
let initialized = false;
let pending: Promise<SessionConnection> | undefined;

export function readCachedAgentSession(): SessionConnection | undefined {
  if (connection) return connection;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = StoredSessionSchema.safeParse(JSON.parse(raw));
      if (parsed.success) connection = parsed.data;
    }
  } catch { /* Browsers with storage disabled can still use this tab's memory. */ }
  return connection;
}

function remember(next: SessionConnection) {
  connection = next;
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* In-memory session remains available. */ }
  return next;
}

export function forgetAgentSession() {
  connection = undefined;
  initialized = false;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
}

// One connection promise prevents StrictMode, page mounts and the first submit
// from creating different anonymous sessions for the same conversation.
export function ensureAgentSession(): Promise<SessionConnection> {
  if (initialized && connection) return Promise.resolve(connection);
  if (pending) return pending;
  pending = (async () => {
    const cached = readCachedAgentSession();
    if (cached) {
      try {
        const session = await getSession(cached.session.id, cached.token);
        initialized = true;
        return remember({ token: cached.token, session });
      } catch (error) {
        if (!(error instanceof ApiRequestError) || ![401, 404].includes(error.status)) throw error;
        forgetAgentSession();
      }
    }
    const created = await createSession();
    initialized = true;
    return remember({ token: created.token, session: created.session });
  })().finally(() => { pending = undefined; });
  return pending;
}

export async function sendAgentTurn(body: AgentTurn) {
  const current = await ensureAgentSession();
  try {
    const result = await sendSessionTurn(current.session.id, current.token, body);
    remember({ token: current.token, session: result.session });
    return result;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) initialized = false;
    throw error;
  }
}

export function sessionMessages(session?: AgentSession) {
  return session?.messages.length ? session.messages.map(({ role, text }) => ({ role, text })) : [{ role: 'assistant' as const, text: '想去哪里、想做什么，或只是有几个小时空闲，都可以告诉我。我们一起把想法变成一条能出发的路线。' }];
}
