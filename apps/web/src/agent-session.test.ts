import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, TurnResult } from '@tripbeam/contracts';

const api = vi.hoisted(() => ({ createSession: vi.fn(), getSession: vi.fn(), sendSessionTurn: vi.fn() }));
vi.mock('./api/trips', () => ({
  ...api,
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, public status: number) { super(message); }
  },
}));

const session = (id = 'e3b75b5e-4f26-4a65-938e-44d81e5910b8'): AgentSession => ({ id, revision: 0, preference: {}, phase: 'collecting', messages: [], itineraryIds: [] });
const token = 'test-session-token-with-enough-characters';
const storageKey = 'tripbeam-agent-session-v1';
afterEach(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  const entries = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
  api.createSession.mockResolvedValue({ token, session: session() });
});

describe('agent session continuity', () => {
  it('shares one initialization across concurrent page mounts and submissions', async () => {
    const { ensureAgentSession } = await import('./agent-session');
    const [first, second] = await Promise.all([ensureAgentSession(), ensureAgentSession()]);
    expect(first.session.id).toBe(second.session.id);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect((await ensureAgentSession()).session.id).toBe(first.session.id);
    expect(api.createSession).toHaveBeenCalledTimes(1);
  });

  it('restores the server conversation after a page refresh', async () => {
    const stored = session();
    sessionStorage.setItem(storageKey, JSON.stringify({ token, session: stored }));
    const restored = { ...stored, revision: 2, preference: { originLabel: '成都春熙路' } };
    api.getSession.mockResolvedValue(restored);
    const { ensureAgentSession } = await import('./agent-session');
    expect((await ensureAgentSession()).session).toEqual(restored);
    expect(api.getSession).toHaveBeenCalledWith(stored.id, token);
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it('replaces an expired session but keeps transient failures retryable', async () => {
    const stored = session();
    sessionStorage.setItem(storageKey, JSON.stringify({ token, session: stored }));
    api.getSession.mockRejectedValueOnce(new Error('网络暂时不可用'));
    const { ensureAgentSession, readCachedAgentSession } = await import('./agent-session');
    await expect(ensureAgentSession()).rejects.toThrow('网络暂时不可用');
    expect(readCachedAgentSession()?.session.id).toBe(stored.id);
    expect(api.createSession).not.toHaveBeenCalled();
    const { ApiRequestError } = await import('./api/trips');
    api.getSession.mockRejectedValueOnce(new ApiRequestError('会话过期', 401));
    const next = session('d5b97797-38ec-43cd-8dc3-a8338e39c292');
    api.createSession.mockResolvedValue({ token, session: next });
    expect((await ensureAgentSession()).session.id).toBe(next.id);
    expect(api.createSession).toHaveBeenCalledTimes(1);
  });

  it('persists the latest server state after each successful turn', async () => {
    const next = { ...session(), revision: 1, preference: { availableMinutes: 120 } };
    api.sendSessionTurn.mockResolvedValue({ session: next } as TurnResult);
    const { sendAgentTurn, readCachedAgentSession, forgetAgentSession } = await import('./agent-session');
    const body = { turnId: 'd5b97797-38ec-43cd-8dc3-a8338e39c292', text: '我有两小时' };
    await sendAgentTurn(body);
    expect(api.sendSessionTurn).toHaveBeenCalledWith(next.id, token, body);
    expect(readCachedAgentSession()?.session).toEqual(next);
    expect(JSON.parse(sessionStorage.getItem(storageKey)!).session.revision).toBe(1);
    forgetAgentSession();
    expect(readCachedAgentSession()).toBeUndefined();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
