import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionSchema, TurnResultSchema, type Poi, type PreferenceDraft, type TurnRequest } from '@tripbeam/contracts';
import { createApp } from '../src/app.js';
import { MapProviderError, type MapProvider } from '../src/maps.js';
import { MemorySessionStore } from '../src/session-store.js';
import { FilePlanStore } from '../src/store.js';
import { resolveNaturalEdit } from '../src/route-service.js';

const preference: PreferenceDraft = { originLabel: '成都春熙路', startTime: '14:00', availableMinutes: 120, playPreferences: ['当地美食', '拍照散步'], travelPreferences: ['步行', '打车'] };
const origin = { label: '春熙路', address: '成都春熙路', coordinate: { lat: 30.657, lng: 104.081 } };
const candidates: Poi[] = ['小吃店', '城市公园', '茶馆', '老街', '漫长展览'].map((name, i) => ({
  id: `poi-${i}`, name, category: i % 2 ? '拍照散步' : '当地美食', tags: [i % 2 ? '拍照散步' : '当地美食'],
  place: { label: name, address: '成都', coordinate: { lat: 30.658 + i * 0.001, lng: 104.082 + i * 0.001 } },
  placeKind: 'venue', stayMinutes: i === 4 ? 180 : 25,
}));
const map: MapProvider = {
  resolve: async () => ({ place: origin, city: '成都' }), nearby: async () => candidates,
  leg: async (from, to, mode) => ({ fromId: from.label, toId: to.label, mode, durationMinutes: 6, distanceMeters: 400, geometry: [from.coordinate, to.coordinate] }),
};
const folders: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function setup(mapProvider = map) {
  const folder = await mkdtemp(join(tmpdir(), 'tripbeam-agent-test-')); folders.push(folder);
  const app = createApp({ map: mapProvider, store: new FilePlanStore(join(folder, 'plans.json')), sessionStore: new MemorySessionStore(), intentParser: { parsePreference: async () => { throw new Error('offline'); } }, clarificationWriter: { writeClarification: async () => { throw new Error('offline'); } } });
  apps.push(app);
  const created = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
  const headers = { 'x-session-token': created.token as string };
  const sessionUrl = `/v1/sessions/${created.session.id}`;
  const turn = (body: Partial<TurnRequest> = {}) => app.inject({ method: 'POST', url: `${sessionUrl}/turns`, headers, payload: { turnId: randomUUID(), text: '', ...body } });
  return { app, headers, sessionUrl, turn };
}

describe('Agent conversation and recovery', () => {
  it('retains known fields across incomplete turns and restores the authenticated session', async () => {
    const { app, headers, sessionUrl, turn } = await setup();
    const first = TurnResultSchema.parse((await turn({ text: '从春熙路出发，两个小时，想吃当地美食' })).json());
    expect(first.source).toBe('fallback');
    expect(first.missingFields).toEqual(['startTime', 'travelPreferences']);
    const second = TurnResultSchema.parse((await turn({ text: '下午三点' })).json());
    expect(second.session.preference).toMatchObject({ originLabel: '春熙路', availableMinutes: 120, startTime: '15:00', playPreferences: ['当地美食'] });
    expect(second.missingFields).toEqual(['travelPreferences']);
    expect((await app.inject({ method: 'GET', url: sessionUrl })).statusCode).toBe(401);
    const restored = await app.inject({ method: 'GET', url: sessionUrl, headers });
    expect(restored.statusCode).toBe(200);
    expect(Object.keys(restored.json()).sort()).toEqual(['requestId', 'session']);
    expect(SessionSchema.parse(restored.json().session)).toEqual(second.session);
  });

  it('treats form selections as replacements and asks again when an interest selection is empty', async () => {
    const { turn } = await setup();
    await turn({ action: 'confirm_preferences', preferencePatch: { ...preference, startTime: undefined } });
    const replacement = TurnResultSchema.parse((await turn({ action: 'confirm_preferences', preferencePatch: { travelPreferences: ['步行'], playPreferences: [] } })).json());
    expect(replacement.source).toBe('form');
    expect(replacement.session.preference.travelPreferences).toEqual(['步行']);
    expect(replacement.missingFields).toEqual(['startTime', 'playPreferences']);
    expect(replacement.itinerary).toBeUndefined();
  });

  it('explains an existing route without generating or changing it', async () => {
    let resolveCalls = 0;
    const { app, turn } = await setup({ ...map, resolve: async (...args) => { resolveCalls++; return map.resolve(...args); } });
    const generated = TurnResultSchema.parse((await turn({ action: 'confirm_preferences', preferencePatch: preference })).json());
    const trip = generated.itinerary!;
    const before = resolveCalls;
    const result = TurnResultSchema.parse((await turn({ action: 'explain_route', itineraryId: trip.id, routeId: trip.routes[1]!.id })).json());
    expect(result.intent).toBe('explain_route');
    expect(result.itinerary).toEqual(trip);
    expect(result.message).toContain(trip.routes[1]!.pois[0]!.name);
    expect(resolveCalls).toBe(before);
    const other = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
    const denied = await app.inject({ method: 'POST', url: `/v1/sessions/${other.session.id}/turns`, headers: { 'x-session-token': other.token }, payload: { turnId: randomUUID(), text: '', action: 'explain_route', itineraryId: trip.id, routeId: trip.routes[0]!.id } });
    expect(denied.statusCode).toBe(403);
  });

  it('retains preferences after an external map outage and retries the same planning request', async () => {
    let failed = true;
    const { app, headers, sessionUrl, turn } = await setup({ ...map, resolve: async (...args) => { if (failed) throw new MapProviderError('地图连接暂不可用。', 'MAP_UNAVAILABLE'); return map.resolve(...args); } });
    const outage = TurnResultSchema.parse((await turn({ action: 'confirm_preferences', preferencePatch: preference })).json());
    expect(outage.session.phase).toBe('error');
    expect(outage.actions).toContain('retry');
    expect(outage.itinerary).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: sessionUrl, headers })).json().session.preference).toEqual(preference);
    failed = false;
    const retried = TurnResultSchema.parse((await turn({ action: 'regenerate' })).json());
    expect(retried.itinerary?.preference).toEqual(preference);
  });

  it('accepts a full regeneration patch on a fresh session and rejects turn-id reuse with changed content', async () => {
    const { turn } = await setup();
    const turnId = randomUUID();
    const request = { turnId, action: 'regenerate' as const, preferencePatch: { ...preference, travelPreferences: ['步行'] as PreferenceDraft['travelPreferences'] } };
    const first = await turn(request);
    expect(first.statusCode).toBe(200);
    expect(first.json().itinerary.preference.travelPreferences).toEqual(['步行']);
    expect((await turn(request)).json()).toEqual(first.json());
    expect((await turn({ ...request, text: 'changed' })).statusCode).toBe(409);
  });

  it('serializes concurrent retries so one turn generates exactly one itinerary', async () => {
    let resolveCalls = 0;
    const { app, headers, sessionUrl, turn } = await setup({ ...map, resolve: async (...args) => { resolveCalls++; return map.resolve(...args); } });
    const request = { turnId: randomUUID(), action: 'regenerate' as const, preferencePatch: preference };
    const responses = await Promise.all([turn(request), turn(request), turn(request)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(responses[1]!.json()).toEqual(responses[0]!.json());
    expect(responses[2]!.json()).toEqual(responses[0]!.json());
    expect(resolveCalls).toBe(1);
    const restored = (await app.inject({ method: 'GET', url: sessionUrl, headers })).json().session;
    expect(restored.revision).toBe(1);
    expect(restored.itineraryIds).toHaveLength(1);
  });

  it('preserves an invalid edit separately and restores the last verified route with a version check', async () => {
    const { app, turn } = await setup();
    const generated = TurnResultSchema.parse((await turn({ action: 'confirm_preferences', preferencePatch: preference })).json());
    const trip = generated.itinerary!; const route = trip.routes[0]!;
    const edited = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/routes/${route.id}/edits`, payload: { operation: 'add', baseVersion: trip.version, poiId: 'poi-4' } });
    expect(edited.statusCode).toBe(200);
    const draft = edited.json().itinerary;
    expect(draft.invalidDraft.pois.at(-1).id).toBe('poi-4');
    expect(draft.routes[0]).toEqual(route);
    const stale = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/routes/${route.id}/restore`, payload: { baseVersion: trip.version } });
    expect(stale.statusCode).toBe(409);
    const restored = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/routes/${route.id}/restore`, payload: { baseVersion: draft.version } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().itinerary).toMatchObject({ version: draft.version + 1, savedVersion: null, routes: trip.routes });
    expect(restored.json().itinerary.invalidDraft).toBeUndefined();
  });

  it('resolves numbered stops only within the selected route and recalculates a natural-language edit', async () => {
    const { turn } = await setup();
    const trip = TurnResultSchema.parse((await turn({ action: 'confirm_preferences', preferencePatch: preference })).json()).itinerary!;
    const route = trip.routes.find((item) => item.pois.length > 1)!;
    const plan = { itinerary: trip, city: '成都', candidates };
    expect(resolveNaturalEdit(plan, route.id, { operation: 'remove', target: '最后一站' })).toMatchObject({ poiId: route.pois.at(-1)!.id });
    expect(() => resolveNaturalEdit(plan, route.id, { operation: 'remove', target: '第八站' })).toThrow('当前路线只有');
    expect(() => resolveNaturalEdit(plan, route.id, { operation: 'add', target: '第二站' })).toThrow('没有找到');
    expect(() => resolveNaturalEdit(plan, route.id, { operation: 'replace', target: '第一站', replacement: '第二站' })).toThrow('没有找到');
    const edited = await turn({ text: '删掉第二站', itineraryId: trip.id, routeId: route.id, baseVersion: trip.version });
    expect(edited.statusCode).toBe(200);
    const result = TurnResultSchema.parse(edited.json());
    expect(result.intent).toBe('edit_route');
    expect(result.itinerary!.routes.find((item) => item.id === route.id)!.pois.map((poi) => poi.id)).toEqual(route.pois.filter((_, index) => index !== 1).map((poi) => poi.id));
    expect(result.itinerary!.version).toBe(trip.version + 1);
  });
});
