import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIntent } from './trips';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('browser API boundary', () => {
  it('presents structured backend errors instead of opaque failures', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      requestId: crypto.randomUUID(), code: 'MAP_NOT_CONFIGURED', message: '地图服务尚未配置。',
    }), { status: 503 })) as typeof fetch;
    await expect(parseIntent('想散步')).rejects.toThrow('地图服务尚未配置。');
  });

  it('rejects responses that violate the shared OpenAPI-compatible contract', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'ready_for_planner', routes: [] }), { status: 200 })) as typeof fetch;
    await expect(parseIntent('想散步')).rejects.toThrow('响应不符合接口契约');
  });
});
