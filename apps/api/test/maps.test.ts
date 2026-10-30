import { afterEach, describe, expect, it, vi } from 'vitest';
import { AMapProvider, gcjToWgs, MapProviderError, wgsToGcj } from '../src/maps.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('AMap adapter', () => {
  it('never calls a provider without a server-side key', async () => {
    const fetch = vi.fn(); globalThis.fetch = fetch;
    await expect(new AMapProvider().resolve('春熙路')).rejects.toMatchObject({ code: 'MAP_NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves and filters provider coordinates and real walking geometry', async () => {
    const bodies = [
      { status: '1', pois: [{ id: 'origin', name: '春熙路', location: '104.081,30.657', address: '成都市锦江区', cityname: '成都' }] },
      { status: '1', pois: [{ id: 'a', name: '餐厅', location: '104.084,30.659', address: '成都', type: '餐饮服务;中餐厅', typecode: '050100', tag: '川菜,担担面', indoor_map: '1', biz_ext: { rating: '4.6', cost: '68', meal_ordering: '1' } }] },
      { status: '1', pois: [{ id: 'b', name: '公园', location: '104.086,30.661', address: '成都' }] },
      { status: '1', route: { paths: [{ duration: '360', distance: '480', steps: [{ polyline: '104.081,30.657;104.082,30.658;104.084,30.659' }] }] } },
    ];
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(bodies.shift()), { status: 200 }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const map = new AMapProvider('test-key');
    const { place, city } = await map.resolve('春熙路');
    expect(city).toBe('成都');
    const pois = await map.nearby(place, ['当地美食']);
    expect(pois).toHaveLength(2);
    expect(pois.map((poi) => poi.placeKind)).toEqual(['venue', 'landmark']);
    expect(pois[0]!.metadata).toMatchObject({ provider: 'amap', categoryPath: '餐饮服务;中餐厅', typeCode: '050100', cuisineTags: ['川菜', '担担面'], rating: 4.6, averageCost: 68, hasIndoorMap: true, supportsMealOrdering: true });
    expect(pois[0]!.place.providerId).toBe('a');
    const leg = await map.leg(place, pois[0]!.place, '步行', city);
    expect(leg.durationMinutes).toBe(6);
    expect(leg.distanceMeters).toBe(480);
    expect(leg.geometry).toHaveLength(3);
    expect(new URL(fetch.mock.calls[0]![0] as string).searchParams.get('key')).toBe('test-key');
  });

  it('passes the itinerary departure time and mobility policy to AMap transit routing', async () => {
    const body = {
      status: '1', route: { transits: [{ duration: '600', distance: '1200', walking_distance: '240', segments: [{
        walking: { steps: [{ polyline: '104.081,30.657;104.082,30.658' }] },
        bus: { buslines: [{ polyline: '104.082,30.658;104.084,30.659' }] },
      }] }] },
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body), { status: 200 }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const map = new AMapProvider('test-key');
    const leg = await map.leg(
      { label: '起点', address: '成都', coordinate: { lat: 30.657, lng: 104.081 }, providerId: 'origin-poi' },
      { label: '终点', address: '成都', coordinate: { lat: 30.659, lng: 104.084 }, providerId: 'destination-poi' },
      '公共交通', '成都', { departureDate: '2026-10-31', departureTime: '21:20', departureMinuteOffset: 80, transitStrategy: 'least_walking', includeNightService: true },
    );
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/v3/direction/transit/integrated');
    expect(url.searchParams.get('date')).toBe('2026-10-31');
    expect(url.searchParams.get('time')).toBe('21:20');
    expect(url.searchParams.get('strategy')).toBe('3');
    expect(url.searchParams.get('nightflag')).toBe('1');
    expect(url.searchParams.get('extensions')).toBe('all');
    expect(leg.walkingDistanceMeters).toBe(240);
    expect(leg.transitTransferCount).toBe(0);
  });

  it('normalizes current weather from AMap without exposing the provider response', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ status: '1', lives: [{ city: '成都', weather: '小雨', temperature: '18', winddirection: '北', windpower: '≤3', humidity: '81', reporttime: '2026-10-31 14:00:00' }] }), { status: 200 }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    await expect(new AMapProvider('test-key').weather('成都')).resolves.toMatchObject({ city: '成都', condition: '小雨', temperatureCelsius: 18, humidity: 81, source: 'amap' });
  });

  it('keeps coordinate conversions approximately reversible', () => {
    const coordinate = { lat: 30.657, lng: 104.081 };
    const converted = gcjToWgs(wgsToGcj(coordinate));
    expect(Math.abs(converted.lat - coordinate.lat)).toBeLessThan(.0001);
    expect(Math.abs(converted.lng - coordinate.lng)).toBeLessThan(.0001);
    expect(new MapProviderError('x', 'MAP_UNAVAILABLE').name).toBe('MapProviderError');
  });
});
