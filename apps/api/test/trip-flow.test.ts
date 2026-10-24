import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerateResponseSchema, ShareSnapshotSchema, type Place, type Poi, type RouteLeg } from '@tripbeam/contracts';
import { createApp } from '../src/app.js';
import { haversineMeters } from '../src/planner.js';
import { FilePlanStore } from '../src/store.js';
import type { MapProvider } from '../src/maps.js';
import { MapProviderError } from '../src/maps.js';

const origin: Place = { label: '春熙路', address: '成都春熙路', coordinate: { lat: 30.657, lng: 104.081 } };
const candidates: Poi[] = [
  ['a', '小吃店', '当地美食', 30.659, 104.084],
  ['b', '城市公园', '拍照散步', 30.661, 104.086],
  ['c', '茶馆', '当地美食', 30.663, 104.088],
  ['d', '老街', '拍照散步', 30.658, 104.09],
].map(([id, name, tag, lat, lng]) => ({ id: String(id), name: String(name), category: String(tag), tags: [String(tag)], place: { label: String(name), address: '成都', coordinate: { lat: Number(lat), lng: Number(lng) } }, stayMinutes: 25 }));

const map: MapProvider = {
  resolve: async () => ({ place: origin, city: '成都' }),
  nearby: async () => candidates,
  leg: async (from, to, mode): Promise<RouteLeg> => ({ fromId: from.label, toId: to.label, mode, durationMinutes: 6, distanceMeters: 450, geometry: [from.coordinate, to.coordinate] }),
};
    const preference = { originLabel: '春熙路', startTime: '14:00', availableMinutes: 120, playPreferences: ['当地美食', '拍照散步'], travelPreferences: ['步行'], mustHave: ['当地美食'], avoid: ['不存在的地点'] };
const folders: string[] = [];
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('deterministic planning API', () => {
  it('generates distinct valid routes, recalculates edits, and freezes a saved share', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const store = new FilePlanStore(join(folder, 'plans.json'));
    const app = createApp({ map, store, copyWriter: { writeRouteCopy: async () => '基于已验证地点的推荐说明。' } });
    const generated = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: preference });
    expect(generated.statusCode).toBe(201);
    const trip = GenerateResponseSchema.parse(generated.json()).itinerary;
    expect(trip.status).toBe('complete');
    expect(trip.routes.length).toBeGreaterThanOrEqual(2);
    expect(trip.routes.every((route) => route.constraintStatus === 'valid' && route.totalDurationMinutes <= 120)).toBe(true);
    expect(trip.routes.every((route) => route.experienceStory && route.matchedPreferences?.includes('当地美食') && route.poiInsights?.length === route.pois.length)).toBe(true);
    expect(new Set(trip.routes.map((route) => route.pois.map((poi) => poi.id).join('|'))).size).toBe(trip.routes.length);

    const route = trip.routes.find((item) => item.pois.length > 1)!;
    const saved = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/save`, payload: { baseVersion: trip.version } });
    expect(saved.statusCode).toBe(200);
    const shared = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/share`, payload: { routeId: route.id } });
    expect(shared.statusCode).toBe(201);
    const snapshot = ShareSnapshotSchema.parse(shared.json().snapshot);

    const edited = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/routes/${route.id}/edits`, payload: { operation: 'remove', baseVersion: trip.version, poiId: route.pois.at(-1)!.id } });
    expect(edited.statusCode).toBe(200);
    const newTrip = GenerateResponseSchema.parse(edited.json()).itinerary;
    expect(newTrip.version).toBe(2);
    expect(newTrip.savedVersion).toBeNull();
    expect(newTrip.routes.find((item) => item.id === route.id)!.pois.length).toBe(route.pois.length - 1);
    const fetched = await app.inject({ method: 'GET', url: `/v1/shares/${snapshot.token}` });
    expect(fetched.statusCode).toBe(200);
    expect(ShareSnapshotSchema.parse(fetched.json().snapshot).route.pois).toEqual(snapshot.route.pois);
    const stale = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/routes/${route.id}/edits`, payload: { operation: 'remove', baseVersion: 1, poiId: route.pois[0]!.id } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('VERSION_CONFLICT');
    const used = new Set(newTrip.routes.find((item) => item.id === route.id)!.pois.map((poi) => poi.id));
    const alternative = candidates.find((poi) => !used.has(poi.id))!;
    const added = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/routes/${route.id}/edits`, payload: { operation: 'add', baseVersion: 2, poiId: alternative.id } });
    expect(added.statusCode).toBe(200);
    const afterAdd = GenerateResponseSchema.parse(added.json()).itinerary;
    expect(afterAdd.version).toBe(3);
    const changedRoute = afterAdd.routes.find((item) => item.id === route.id)!;
    expect(changedRoute.scheduledStops).toHaveLength(changedRoute.pois.length);
    const reordered = await app.inject({ method: 'POST', url: `/v1/itineraries/${trip.id}/routes/${route.id}/edits`, payload: { operation: 'reorder', baseVersion: 3, poiIds: changedRoute.pois.map((poi) => poi.id).reverse() } });
    expect(reordered.statusCode).toBe(200);
    const afterReorder = GenerateResponseSchema.parse(reordered.json()).itinerary;
    expect(afterReorder.routes.find((item) => item.id === route.id)!.pois[0]!.id).toBe(changedRoute.pois.at(-1)!.id);
    expect(ShareSnapshotSchema.parse((await app.inject({ method: 'GET', url: `/v1/shares/${snapshot.token}` })).json().snapshot).version).toBe(1);
    await app.close();
  });

  it('enforces the 8km spatial rule and rejects time overflow', async () => {
    expect(haversineMeters(origin.coordinate, { lat: 30.8, lng: 104.081 })).toBeGreaterThan(8_000);
    const longMap: MapProvider = { ...map, leg: async (from, to, mode) => ({ fromId: from.label, toId: to.label, mode, durationMinutes: 120, distanceMeters: 400, geometry: [from.coordinate, to.coordinate] }) };
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const app = createApp({ map: longMap, store: new FilePlanStore(join(folder, 'plans.json')) });
    const response = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: preference });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('ROUTE_UNAVAILABLE');
    await app.close();
  });

  it('reports map outages explicitly instead of estimating a path', async () => {
    const failedMap: MapProvider = { ...map, leg: async () => { throw new MapProviderError('路网暂不可用。', 'MAP_UNAVAILABLE'); } };
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const app = createApp({ map: failedMap, store: new FilePlanStore(join(folder, 'plans.json')) });
    const response = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: preference });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('MAP_UNAVAILABLE');
    await app.close();
  });

  it('keeps a multi-turn session and routes intent through the planner boundary', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-session-')); folders.push(folder);
    const app = createApp({ map, store: new FilePlanStore(join(folder, 'plans.json')) });
    const created = await app.inject({ method: 'POST', url: '/v1/sessions' });
    expect(created.statusCode).toBe(201);
    const session = created.json();
    const first = await app.inject({ method: 'POST', url: `/v1/sessions/${session.session.id}/turns`, headers: { 'x-session-token': session.token }, payload: { turnId: randomUUID(), text: '下午想吃当地菜，正常步行' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().session.phase).toBe('needs_user_input');
    const second = await app.inject({ method: 'POST', url: `/v1/sessions/${session.session.id}/turns`, headers: { 'x-session-token': session.token }, payload: { turnId: randomUUID(), text: '从春熙路出发，14点，2小时，愿意步行', action: 'message' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().itinerary.id).toBeTypeOf('string');
    await app.close();
  });
});
