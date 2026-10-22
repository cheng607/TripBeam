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
      { status: '1', pois: [{ id: 'a', name: '餐厅', location: '104.084,30.659', address: '成都' }] },
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
    const leg = await map.leg(place, pois[0]!.place, '步行', city);
    expect(leg.durationMinutes).toBe(6);
    expect(leg.distanceMeters).toBe(480);
    expect(leg.geometry).toHaveLength(3);
    expect(new URL(fetch.mock.calls[0]![0] as string).searchParams.get('key')).toBe('test-key');
  });

  it('keeps coordinate conversions approximately reversible', () => {
    const coordinate = { lat: 30.657, lng: 104.081 };
    const converted = gcjToWgs(wgsToGcj(coordinate));
    expect(Math.abs(converted.lat - coordinate.lat)).toBeLessThan(.0001);
    expect(Math.abs(converted.lng - coordinate.lng)).toBeLessThan(.0001);
    expect(new MapProviderError('x', 'MAP_UNAVAILABLE').name).toBe('MapProviderError');
  });
});
