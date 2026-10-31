import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerateResponseSchema, ShareSnapshotSchema, type Place, type Poi, type PreferenceDraft, type RouteLeg } from '@tripbeam/contracts';
import { createApp } from '../src/app.js';
import { buildRoute } from '../src/planner.js';
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
const preference: PreferenceDraft = { originLabel: '春熙路', startTime: '14:00', availableMinutes: 120, playPreferences: ['当地美食', '拍照散步'], travelPreferences: ['步行'], mustHave: ['当地美食'], avoid: ['不存在的地点'] };
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
    expect(new Set(trip.routes.map((route) => route.title.split(' · ').at(-1))).size).toBe(trip.routes.length);
    for (const [index, route] of trip.routes.entries()) for (const other of trip.routes.slice(index + 1)) {
      const ids = new Set(route.pois.map((poi) => poi.id));
      const shared = other.pois.filter((poi) => ids.has(poi.id)).length;
      expect(shared / Math.min(route.pois.length, other.pois.length)).toBeLessThanOrEqual(0.5);
    }

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

  it('uses route time rather than a fixed origin radius, and still rejects time overflow', async () => {
    const farButReachable: Poi = { ...candidates[0]!, id: 'far', place: { ...candidates[0]!.place, coordinate: { lat: 30.8, lng: 104.081 } }, stayMinutes: 5 };
    const route = await buildRoute({ origin, city: '成都', preference, pois: [farButReachable], theme: 'balanced', title: '远距离但可达', map });
    expect(route.constraintStatus).toBe('valid');
    expect(route.pois[0]!.stayMinutes).toBe(5);
    const longMap: MapProvider = { ...map, leg: async (from, to, mode) => ({ fromId: from.label, toId: to.label, mode, durationMinutes: 120, distanceMeters: 400, geometry: [from.coordinate, to.coordinate] }) };
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const app = createApp({ map: longMap, store: new FilePlanStore(join(folder, 'plans.json')) });
    const response = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: preference });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('ROUTE_UNAVAILABLE');
    await app.close();
  });

  it('compresses a recommended stop duration only after real road-network legs have been checked', async () => {
    const longVisit: Poi = { ...candidates[0]!, id: 'long-visit', stayMinutes: 90, minStayMinutes: 20, maxStayMinutes: 120 };
    const measuredMap: MapProvider = {
      ...map,
      leg: async (from, to, mode) => ({ fromId: from.label, toId: to.label, mode, durationMinutes: 15, distanceMeters: 900, geometry: [from.coordinate, to.coordinate] }),
    };
    const route = await buildRoute({ origin, city: '成都', preference: { ...preference, availableMinutes: 100 }, pois: [longVisit], theme: 'balanced', title: '动态停留', map: measuredMap });
    expect(route.totalDurationMinutes).toBe(100);
    expect(route.pois[0]!.stayMinutes).toBe(60);
    expect(route.scheduledStops[0]).toMatchObject({ arrivalMinuteOffset: 15, departureMinuteOffset: 75 });
  });

  it('keeps the selected place combination and gives its core destination more of the dwell budget', async () => {
    const selectedPlaces: Poi[] = [
      { ...candidates[0]!, id: 'core-food', stayMinutes: 70, minStayMinutes: 20, tags: ['当地美食'] },
      { ...candidates[1]!, id: 'supporting-walk', stayMinutes: 70, minStayMinutes: 20, tags: ['拍照散步'] },
    ];
    const route = await buildRoute({ origin, city: '成都', preference: { ...preference, availableMinutes: 100, playPreferences: ['当地美食'] }, pois: selectedPlaces, theme: 'balanced', title: '地点优先', map });
    const core = route.pois.find((poi) => poi.visitRole === 'core')!;
    const supporting = route.pois.find((poi) => poi.visitRole === 'supporting')!;
    expect(core.id).toBe('core-food');
    expect(core.stayMinutes).toBeGreaterThan(supporting.stayMinutes);
    expect(route.totalDurationMinutes).toBe(100);
  });

  it('returns one verified route as a usable degraded itinerary instead of discarding it', async () => {
    const singleViable: Poi[] = [
      { ...candidates[0]!, id: 'nearby-food', stayMinutes: 30 },
      { ...candidates[1]!, id: 'far-park', stayMinutes: 30 },
    ];
    const oneRouteMap: MapProvider = {
      ...map,
      nearby: async () => singleViable,
      leg: async (from, to, mode) => {
        const touchesFarPark = from.label === '城市公园' || to.label === '城市公园';
        return { fromId: from.label, toId: to.label, mode, durationMinutes: touchesFarPark ? 100 : 6, distanceMeters: 450, geometry: [from.coordinate, to.coordinate] };
      },
    };
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const app = createApp({ map: oneRouteMap, store: new FilePlanStore(join(folder, 'plans.json')) });
    const response = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: preference });
    expect(response.statusCode).toBe(201);
    const trip = GenerateResponseSchema.parse(response.json()).itinerary;
    expect(trip).toMatchObject({ status: 'degraded' });
    expect(trip.routes).toHaveLength(1);
    expect(trip.routes[0]!.constraintStatus).toBe('valid');
    await app.close();
  });

  it('closes the route with a return leg and keeps buffer separate from remaining time', async () => {
    const route = await buildRoute({ origin, city: '成都', preference, pois: candidates.slice(0, 2), theme: 'balanced', title: '闭环路线', map });
    expect(route.returnsToOrigin).toBe(true);
    expect(route.endPlace).toEqual(origin);
    expect(route.legs).toHaveLength(route.pois.length + 1);
    expect(route.legs.at(-1)).toMatchObject({ fromId: route.pois.at(-1)!.id, toId: 'origin' });
    expect(route.bufferMinutes).toBe(10);
    expect(route.remainingMinutes).toBe(preference.availableMinutes - route.totalDurationMinutes);
    expect(route.totalDurationMinutes).toBe(
      route.legs.reduce((sum, leg) => sum + leg.durationMinutes, 0)
      + route.pois.reduce((sum, poi) => sum + poi.stayMinutes, 0)
      + route.bufferMinutes,
    );
    expect(route.scheduledStops[0]).toMatchObject({ arrivalTime: '14:06', departureTime: '14:31' });
    expect(route.legs.every((leg) => leg.plannedDepartureMinuteOffset !== undefined && leg.plannedArrivalMinuteOffset !== undefined)).toBe(true);
    expect(route.risks).not.toContain('TRIP_DATE_ASSUMED');
  });

  it('enables night transit from each leg departure instead of only the trip start time', async () => {
    const contexts: Array<{ departureTime: string; includeNightService: boolean }> = [];
    const nightMap: MapProvider = {
      ...map,
      leg: async (from, to, mode, _city, context) => {
        contexts.push({ departureTime: context!.departureTime, includeNightService: context!.includeNightService });
        return { fromId: from.label, toId: to.label, mode, durationMinutes: 6, distanceMeters: 450, geometry: [from.coordinate, to.coordinate] };
      },
    };
    await buildRoute({ origin, city: '成都', preference: { ...preference, startTime: '19:55', travelPreferences: ['公共交通'] }, pois: candidates.slice(0, 2), theme: 'balanced', title: '夜间换乘', map: nightMap });
    expect(contexts.map((item) => item.includeNightService)).toEqual([false, true, true]);
  });

  it('does not claim to satisfy hard constraints without place-level evidence', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const app = createApp({ map, store: new FilePlanStore(join(folder, 'plans.json')) });
    const response = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: { ...preference, mustHave: ['无障碍'] } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    expect(response.json().message).toContain('没有可验证满足');
    await app.close();
  });

  it('returns AMap weather with a generated itinerary and preflights replacement choices', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const weatherMap: MapProvider = { ...map, weather: async () => ({ city: '成都', condition: '多云', temperatureCelsius: 22, reportedAt: '2026-10-31 14:00:00', source: 'amap' }) };
    const app = createApp({ map: weatherMap, store: new FilePlanStore(join(folder, 'plans.json')) });
    const generated = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: preference });
    expect(generated.statusCode).toBe(201);
    const trip = GenerateResponseSchema.parse(generated.json()).itinerary;
    expect(trip.weather).toMatchObject({ city: '成都', condition: '多云', temperatureCelsius: 22 });
    const route = trip.routes[0]!;
    const alternatives = await app.inject({ method: 'GET', url: `/v1/itineraries/${trip.id}/routes/${route.id}/alternatives?replacePoiId=${route.pois[0]!.id}` });
    expect(alternatives.statusCode).toBe(200);
    expect(alternatives.json().alternatives.every((poi: Poi) => !route.pois.some((used) => used.id === poi.id))).toBe(true);
    await app.close();
  });

  it('rejects a plan when it cannot offer two concrete, distinct routes', async () => {
    const limitedCandidates: Poi[] = [
      { ...candidates[0]!, id: 'venue-only', placeKind: 'venue' },
      { ...candidates[1]!, id: 'district-only', name: '城市步行街', placeKind: 'area' },
    ];
    const limitedMap: MapProvider = { ...map, nearby: async () => limitedCandidates };
    const folder = await mkdtemp(join(tmpdir(), 'tripbeam-test-')); folders.push(folder);
    const app = createApp({ map: limitedMap, store: new FilePlanStore(join(folder, 'plans.json')) });
    const response = await app.inject({ method: 'POST', url: '/v1/itineraries/generate', payload: preference });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('POI_INSUFFICIENT');
    expect(response.json().message).toContain('具体地点');
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
