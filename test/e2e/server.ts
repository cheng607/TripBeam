/** Isolated browser fixture: no .env loading, external API calls, or real itinerary writes. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/api/src/app.js';
import { NativeAgentOrchestrator } from '../../apps/api/src/agent.js';
import { DemoMapProvider } from '../../apps/api/src/maps.js';
import { FilePlanStore } from '../../apps/api/src/store.js';
import { MemorySessionStore } from '../../apps/api/src/session-store.js';

process.env.WEB_ORIGIN = 'http://127.0.0.1:4174,http://localhost:4174';
process.env.RATE_LIMIT_PER_MINUTE = '0';
const folder = await mkdtemp(join(tmpdir(), 'tripbeam-browser-fixture-'));
const parser = { parsePreference: async () => { throw new Error('Offline fixture: model intentionally unavailable'); } };
const clarificationWriter = { writeClarification: async () => '再确认一下出发条件，就可以开始规划。' };
const app = createApp({
  map: new DemoMapProvider(),
  store: new FilePlanStore(join(folder, 'plans.json')),
  sessionStore: new MemorySessionStore(),
  intentParser: parser,
  clarificationWriter,
  copyWriter: { writeRouteCopy: async () => '浏览器验收用演示数据，不可用于真实出行。' },
  agent: new NativeAgentOrchestrator(parser, clarificationWriter),
});
app.addHook('onClose', async () => { await rm(folder, { recursive: true, force: true }); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host: '127.0.0.1', port: 3102 });
console.log('TripBeam browser fixture ready at http://127.0.0.1:3102 (DEMO DATA ONLY)');
