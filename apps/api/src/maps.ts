import type { Coordinate, Place, Poi, RouteLeg } from '@tripbeam/contracts';

export class MapProviderError extends Error {
  constructor(message: string, public readonly code: 'MAP_NOT_CONFIGURED' | 'LOCATION_NOT_FOUND' | 'MAP_UNAVAILABLE' | 'ROUTE_UNAVAILABLE') {
    super(message);
    this.name = 'MapProviderError';
  }
}

export interface MapProvider {
  resolve(text: string): Promise<{ place: Place; city: string }>;
  nearby(origin: Place, preferences: string[]): Promise<Poi[]>;
  leg(from: Place, to: Place, mode: RouteLeg['mode'], city: string): Promise<RouteLeg>;
}

/** Local-only deterministic provider for UI/MVP development when AMap is unreachable. */
export class DemoMapProvider implements MapProvider {
  async resolve(text: string) {
    const place: Place = { label: text, address: `${text}（演示定位）`, coordinate: { lat: 31.2304, lng: 121.4737 } };
    return { place, city: '上海' };
  }
  async nearby(origin: Place, preferences: string[]) {
    const names = ['本地特色餐馆', '城市公园', '历史博物馆', '老街步行区', '社区书店', '江边观景台'];
    const tags = preferences.length ? preferences : ['拍照散步'];
    return names.map((name, index): Poi => ({
      id: `demo-${index + 1}`, name, category: index % 2 ? '景点' : '餐饮', tags: [tags[index % tags.length]!],
      place: { label: name, address: '演示地址（非实时数据）', coordinate: { lat: origin.coordinate.lat + 0.004 * Math.cos(index), lng: origin.coordinate.lng + 0.004 * Math.sin(index) } },
      stayMinutes: 25 + (index % 3) * 10,
    }));
  }
  async leg(from: Place, to: Place, mode: RouteLeg['mode']) {
    const dLat = (to.coordinate.lat - from.coordinate.lat) * 111_000;
    const dLng = (to.coordinate.lng - from.coordinate.lng) * 95_000;
    const distanceMeters = Math.max(200, Math.round(Math.sqrt(dLat * dLat + dLng * dLng)));
    const speed = mode === '步行' ? 75 : mode === '自行车' ? 220 : 350;
    return { fromId: from.label, toId: to.label, mode, durationMinutes: Math.max(1, Math.ceil(distanceMeters / speed)), distanceMeters, geometry: [from.coordinate, to.coordinate] };
  }
}

const themeQueries: Record<string, { query: string; category: string; stay: number }> = {
  当地美食: { query: '特色餐饮', category: '餐饮', stay: 50 },
  拍照散步: { query: '景点', category: '景点', stay: 35 },
  文化展览: { query: '博物馆', category: '文化', stay: 55 },
  自然放松: { query: '公园', category: '自然', stay: 40 },
  逛街购物: { query: '商场', category: '购物', stay: 45 },
  夜生活: { query: '夜市', category: '夜生活', stay: 45 },
};

type JsonObject = Record<string, unknown>;
const record = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number => Number(value);
const first = (value: unknown): JsonObject => record(list(value)[0]);

function gcjDelta({ lat, lng }: Coordinate): Coordinate {
  const x = lng - 105; const y = lat - 35;
  let dLat = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x));
  dLat += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLat += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  dLat += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  let dLng = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x));
  dLng += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLng += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  dLng += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  const radLat = lat / 180 * Math.PI;
  const magic = 1 - .00669342162296594323 * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  return { lat: dLat * 180 / ((6335552.717000426 / (magic * sqrtMagic)) * Math.PI), lng: dLng * 180 / ((6378245 / sqrtMagic) * Math.cos(radLat) * Math.PI) };
}
const inChina = ({ lat, lng }: Coordinate) => lng >= 72.004 && lng <= 137.8347 && lat >= .8293 && lat <= 55.8271;
export function gcjToWgs(coordinate: Coordinate): Coordinate {
  if (!inChina(coordinate)) return coordinate;
  const d = gcjDelta(coordinate); return { lat: coordinate.lat - d.lat, lng: coordinate.lng - d.lng };
}
export function wgsToGcj(coordinate: Coordinate): Coordinate {
  if (!inChina(coordinate)) return coordinate;
  const d = gcjDelta(coordinate); return { lat: coordinate.lat + d.lat, lng: coordinate.lng + d.lng };
}
const parseCoordinate = (value: unknown): Coordinate | null => {
  const [lng, lat] = string(value).split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat!) <= 90 && Math.abs(lng!) <= 180 ? { lat: lat!, lng: lng! } : null;
};
const queryCoordinate = (coordinate: Coordinate): string => {
  const gcj = wgsToGcj(coordinate); return `${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}`;
};
const polyline = (value: unknown): Coordinate[] => string(value).split(';').map(parseCoordinate).filter((point): point is Coordinate => point !== null).map(gcjToWgs);

export class AMapProvider implements MapProvider {
  private readonly cache = new Map<string, { expires: number; result: JsonObject }>();
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  constructor(private readonly key?: string, private readonly baseUrl = 'https://restapi.amap.com') {}

  private async request(url: URL): Promise<Response> {
    const previous = this.requestQueue;
    let release!: () => void;
    this.requestQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, 350 - (Date.now() - this.lastRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const response = await fetch(url, { signal: AbortSignal.timeout(Number(process.env.AMAP_TIMEOUT_MS ?? 8_000)) });
      this.lastRequestAt = Date.now();
      return response;
    } finally { release(); }
  }

  private async get(path: string, params: Record<string, string>): Promise<JsonObject> {
    if (!this.key) throw new MapProviderError('地图服务尚未配置，请设置 AMAP_WEB_KEY。', 'MAP_NOT_CONFIGURED');
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries({ ...params, key: this.key, output: 'json' })) url.searchParams.set(key, value);
    const cacheKey = `${path}:${JSON.stringify(params)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.result;
    let response: Response;
    try { response = await this.request(url); }
    catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? '请求超时' : '网络连接失败';
      throw new MapProviderError(`地图服务暂不可用（${reason}），请检查 API 服务器出网、代理、域名白名单和 Key 配额。`, 'MAP_UNAVAILABLE');
    }
    if (!response.ok) throw new MapProviderError('地图服务暂不可用，请稍后重试。', 'MAP_UNAVAILABLE');
    let data: JsonObject;
    try { data = record(await response.json()); }
    catch { throw new MapProviderError('地图服务返回了无效响应。', 'MAP_UNAVAILABLE'); }
    const success = string(data.status) === '1' || string(data.infocode) === '10000' || number(data.errcode) === 0;
    if (!success) throw new MapProviderError(`地图服务拒绝了请求（${string(data.infocode) || string(data.info) || 'unknown'}），请检查配额与密钥。`, 'MAP_UNAVAILABLE');
    this.cache.set(cacheKey, { expires: Date.now() + 5 * 60_000, result: data });
    return data;
  }

  async resolve(text: string): Promise<{ place: Place; city: string }> {
    const data = await this.get('/v3/place/text', { keywords: text, offset: '5', extensions: 'base' });
    const poi = list(data.pois).map(record).find((item) => parseCoordinate(item.location));
    if (!poi) throw new MapProviderError('未找到出发地点，请输入更具体的地标或地址。', 'LOCATION_NOT_FOUND');
    const coordinate = parseCoordinate(poi.location)!;
    const cityValue = poi.cityname;
    return { place: { label: string(poi.name) || text, address: string(poi.address) || text, coordinate: gcjToWgs(coordinate) }, city: string(cityValue) || '中国' };
  }

  async nearby(origin: Place, preferences: string[]): Promise<Poi[]> {
    const queries = preferences.slice(0, 8).map((preference) => ({ preference, ...themeQueries[preference] ?? { query: preference, category: '其他', stay: 35 } }));
    if (!queries.some((item) => item.category === '景点')) queries.push({ preference: '拍照散步', ...themeQueries.拍照散步! });
    const responses = await Promise.all(queries.map(async (item) => ({ item, data: await this.get('/v3/place/around', {
      location: queryCoordinate(origin.coordinate), keywords: item.query, radius: '8000', offset: '20', sortrule: 'weight', extensions: 'base',
    }) })));
    const found = new Map<string, Poi>();
    for (const { item, data } of responses) for (const raw of list(data.pois)) {
      const poi = record(raw); const coordinate = parseCoordinate(poi.location); const id = string(poi.id);
      if (!coordinate || !id || !string(poi.name)) continue;
      const existing = found.get(id);
      if (existing) { if (!existing.tags.includes(item.preference)) existing.tags.push(item.preference); continue; }
      found.set(id, { id, name: string(poi.name), category: item.category, tags: [item.preference],
        place: { label: string(poi.name), address: string(poi.address) || string(poi.pname) || '地址待确认', coordinate: gcjToWgs(coordinate) },
        stayMinutes: item.stay });
    }
    return [...found.values()];
  }

  async leg(from: Place, to: Place, mode: RouteLeg['mode'], city: string): Promise<RouteLeg> {
    const query = { origin: queryCoordinate(from.coordinate), destination: queryCoordinate(to.coordinate) };
    let data: JsonObject; let path: JsonObject; let steps: JsonObject[] = []; let duration = 0; let distance = 0;
    if (mode === '自行车') {
      data = await this.get('/v4/direction/bicycling', query);
      path = first(record(data.data).paths); steps = list(path.steps).map(record);
    } else if (mode === '公共交通') {
      data = await this.get('/v3/direction/transit/integrated', { ...query, city });
      path = first(record(data.route).transits);
      const segments = list(path.segments).map(record);
      for (const segment of segments) {
        steps.push(...list(record(segment.walking).steps).map(record));
        steps.push(...list(record(segment.bus).buslines).map(record));
      }
    } else {
      data = await this.get(mode === '步行' ? '/v3/direction/walking' : '/v3/direction/driving', query);
      path = first(record(data.route).paths); steps = list(path.steps).map(record);
    }
    duration = number(path.duration); distance = number(path.distance);
    const geometry = steps.flatMap((step) => polyline(step.polyline));
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(distance) || distance < 0 || geometry.length < 2) {
      throw new MapProviderError('该出行方式暂时无法获得可靠的路网线路。', 'ROUTE_UNAVAILABLE');
    }
    return {
      fromId: from.label, toId: to.label, mode, durationMinutes: Math.max(1, Math.ceil(duration / 60)),
      distanceMeters: Math.round(distance), geometry: geometry.slice(0, 3000),
    };
  }
}
