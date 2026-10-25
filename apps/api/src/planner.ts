import { randomUUID } from 'node:crypto';
import type { Coordinate, Itinerary, Place, Poi, PreferenceDraft, RouteLeg, TripRoute } from '@tripbeam/contracts';
import { ItinerarySchema, RouteSchema } from '@tripbeam/contracts';
import { MapProviderError, type MapProvider } from './maps.js';
import { enrichExperienceRoute, experienceFocus, type ExperienceVariant } from './experience.js';

export const POLICY_VERSION = 'experience-route-v2';
export class PlannerError extends Error {
  constructor(message: string, public readonly code: 'POI_INSUFFICIENT' | 'ROUTE_UNAVAILABLE' | 'CONSTRAINT_VIOLATION', public readonly details?: { totalDurationMinutes?: number; totalDistanceMeters?: number; excessMinutes?: number }) { super(message); }
}

export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

type RouteStrategy = {
  variant: ExperienceVariant;
  theme: TripRoute['theme'];
  maxStops: number;
  focusWeight: number;
  legPenalty: number;
  varietyBonus: number;
  stayWeight: number;
};

// These strategies deliberately optimize different experiences. They are not
// labels applied after one shared search result has been selected.
const variants: RouteStrategy[] = [
  { variant: 'deep', theme: 'balanced', maxStops: 2, focusWeight: 1.8, legPenalty: 0.35, varietyBonus: 5, stayWeight: 0.45 },
  { variant: 'wander', theme: 'balanced', maxStops: 4, focusWeight: 1.1, legPenalty: 0.7, varietyBonus: 24, stayWeight: 0.12 },
  { variant: 'easy', theme: 'easy_walk', maxStops: 3, focusWeight: 1.25, legPenalty: 1.7, varietyBonus: 8, stayWeight: 0.08 },
];
const BUFFER_MINUTES = 10;

function rank(poi: Poi, origin: Place, preferences: string[], priority: string, strategy: RouteStrategy): number {
  const preferenceScore = poi.tags.filter((tag) => preferences.includes(tag)).length * 28;
  const themeScore = priority && poi.tags.includes(priority) ? 34 * strategy.focusWeight : 0;
  const originCost = haversineMeters(origin.coordinate, poi.place.coordinate) / 160 * strategy.legPenalty;
  return preferenceScore * strategy.focusWeight + themeScore + poi.stayMinutes * strategy.stayWeight - originCost;
}

function candidateSequences(candidates: Poi[], origin: Place, preferences: string[], priority: string, availableMinutes: number, strategy: RouteStrategy): Poi[][] {
  // Keep a broader candidate set so a highly ranked POI cannot monopolize every route.
  const ranked = [...candidates].sort((a, b) => rank(b, origin, preferences, priority, strategy) - rank(a, origin, preferences, priority, strategy)).slice(0, 36);
  const beam: Array<{ pois: Poi[]; score: number; estimatedMinutes: number }> = [{ pois: [], score: 0, estimatedMinutes: 0 }];
  const output: typeof beam = [];
  for (let depth = 0; depth < strategy.maxStops; depth++) {
    const next: typeof beam = [];
    for (const state of beam) for (const poi of ranked) {
      if (state.pois.some((item) => item.id === poi.id)) continue;
      const previous = state.pois.at(-1)?.place ?? origin;
      const distance = haversineMeters(previous.coordinate, poi.place.coordinate);
      const estimate = state.estimatedMinutes + poi.stayMinutes + Math.ceil(distance / 70) + BUFFER_MINUTES;
      if (estimate > Math.min(240, availableMinutes + 30)) continue;
      const categoryNovelty = state.pois.some((item) => item.category === poi.category) ? 0 : strategy.varietyBonus;
      next.push({ pois: [...state.pois, poi], estimatedMinutes: estimate, score: state.score + rank(poi, origin, preferences, priority, strategy) - distance / 120 * strategy.legPenalty + categoryNovelty });
    }
    next.sort((a, b) => b.score - a.score);
    beam.splice(0, beam.length, ...next.slice(0, 48));
    output.push(...beam);
  }
  return output.sort((a, b) => b.score - a.score).map((item) => item.pois);
}

function routeSimilarity(left: Poi[], right: Poi[]): number {
  const leftIds = new Set(left.map((poi) => poi.id));
  const rightIds = new Set(right.map((poi) => poi.id));
  const overlap = [...leftIds].filter((id) => rightIds.has(id)).length;
  return overlap / Math.max(1, Math.min(leftIds.size, rightIds.size));
}

function searchRadiusMeters(preference: PreferenceDraft): number {
  const metersPerMinute: Record<RouteLeg['mode'], number> = { '步行': 75, '自行车': 220, '公共交通': 300, '打车': 420, '自驾': 450 };
  const fastest = Math.max(...preference.travelPreferences.map((mode) => metersPerMinute[mode]));
  // The radius is a discovery horizon, not a validity rule. Final route time is
  // verified using real route legs below.
  return Math.max(2_000, Math.min(40_000, Math.round(preference.availableMinutes * fastest * 0.55)));
}

function reason(title: string, pois: Poi[], mode: RouteLeg['mode']): string {
  const names = pois.map((poi) => poi.name).join('、');
  return `${title}串联${names}，按${mode}的路网时间安排停留与缓冲。营业和现场情况请在出发前确认。`;
}

export async function buildRoute(input: {
  origin: Place; city: string; preference: PreferenceDraft; pois: Poi[]; theme: TripRoute['theme']; title: string; map: MapProvider; mode?: RouteLeg['mode'];
}): Promise<TripRoute> {
  const { origin, city, preference, pois, map, theme, title } = input;
  if (!pois.length || new Set(pois.map((poi) => poi.id)).size !== pois.length) {
    throw new PlannerError('路线包含重复地点。', 'CONSTRAINT_VIOLATION');
  }
  const mode = input.mode ?? preference.travelPreferences[0]!;
  if (!preference.travelPreferences.includes(mode)) throw new PlannerError('出行方式不在用户偏好中。', 'CONSTRAINT_VIOLATION');
  const legs: RouteLeg[] = await Promise.all(pois.map(async (poi, index) => ({
    ...await map.leg(index ? pois[index - 1]!.place : origin, poi.place, mode, city),
    fromId: index ? pois[index - 1]!.id : 'origin', toId: poi.id,
  })));
  const totalDurationMinutes = legs.reduce((sum, leg) => sum + leg.durationMinutes, 0) + pois.reduce((sum, poi) => sum + poi.stayMinutes, 0) + BUFFER_MINUTES;
  const totalDistanceMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const plannedLimit = preference.timePolicy === 'flexible'
    ? Math.min(240, preference.availableMinutes + 30)
    : Math.min(preference.availableMinutes, 240);
  if (totalDurationMinutes > plannedLimit) {
    const excessMinutes = totalDurationMinutes - plannedLimit;
    throw new PlannerError(`路线超出可用时长 ${excessMinutes} 分钟，请减少停靠点。`, 'CONSTRAINT_VIOLATION', { totalDurationMinutes, totalDistanceMeters, excessMinutes });
  }
  let elapsed = 0;
  const scheduledStops = pois.map((poi, index) => {
    elapsed += legs[index]!.durationMinutes;
    const arrivalMinuteOffset = elapsed;
    elapsed += poi.stayMinutes;
    return { poiId: poi.id, arrivalMinuteOffset, departureMinuteOffset: elapsed };
  });
  const exceededPreferredTime = totalDurationMinutes > preference.availableMinutes;
  const remainingMinutes = Math.max(0, preference.availableMinutes - totalDurationMinutes);
  const route = {
    id: randomUUID(), theme, title, pois, legs, scheduledStops, totalDurationMinutes, totalDistanceMeters, bufferMinutes: remainingMinutes, remainingMinutes,
    walkingIntensity: (mode !== '步行' || totalDistanceMeters < 1800 ? 'low' : totalDistanceMeters < 4000 ? 'medium' : 'high') as TripRoute['walkingIntensity'],
    constraintStatus: 'valid' as const, recommendationReason: reason(title, pois, mode),
    risks: [
      'OPENING_HOURS_UNCERTAIN' as const,
      ...(pois.some((poi) => poi.place.address === '地址待确认') ? ['POI_DATA_PARTIAL' as const] : []),
      ...(remainingMinutes < 20 ? ['ROUTE_TIME_TIGHT' as const] : []),
      ...(exceededPreferredTime ? ['PREFERENCE_RELAXED' as const] : []),
    ],
  };
  return RouteSchema.parse(route);
}

export async function generateItinerary(preference: PreferenceDraft, map: MapProvider, previousSignatures: string[] = []): Promise<{ itinerary: Itinerary; candidates: Poi[]; city: string }> {
  const { place: origin, city } = await map.resolve(preference.originLabel);
  const interests = [...new Set([...preference.playPreferences, ...(preference.customPreferences ?? []), ...(preference.mustHave ?? []), ...(preference.niceToHave ?? [])])];
  const raw = await map.nearby(origin, interests, { radiusMeters: searchRadiusMeters(preference) });
  const avoid = preference.avoid ?? [];
  const candidates = raw.filter((poi) => {
    const searchable = `${poi.name} ${poi.category} ${poi.tags.join(' ')}`;
    return poi.stayMinutes >= 1 && !avoid.some((item) => searchable.includes(item));
  });
  if (!candidates.length) throw new PlannerError('附近没有足够的可用地点，请更换出发点或偏好。', 'POI_INSUFFICIENT');
  const routes: TripRoute[] = [];
  const signatures = new Set<string>();
  let providerFailure: MapProviderError | null = null;
  const focus = experienceFocus(preference);
  for (const [themeIndex, definition] of variants.entries()) {
    const priority = focus[themeIndex] ?? focus[0] ?? '';
    const sequences = candidateSequences(candidates, origin, interests, priority, preference.availableMinutes, definition);
    const alternatives = sequences.filter((pois) => !previousSignatures.includes(pois.map((poi) => poi.id).join('|')));
    const ordered = [...alternatives, ...sequences.filter((pois) => previousSignatures.includes(pois.map((poi) => poi.id).join('|')))];
    for (const pois of ordered.slice(0, 20)) {
      const signature = pois.map((poi) => poi.id).join('|');
      if (signatures.has(signature) || routes.some((route) => routeSimilarity(route.pois, pois) > 0.5)) continue;
      try {
        const route = await buildRoute({ origin, city, preference, pois, theme: definition.theme, title: definition.variant, map, mode: preference.travelPreferences[themeIndex % preference.travelPreferences.length] });
        routes.push(enrichExperienceRoute(route, preference, definition.variant)); signatures.add(signature); break;
      } catch (error) {
        if (error instanceof MapProviderError) {
          if (error.code === 'MAP_UNAVAILABLE' || error.code === 'MAP_NOT_CONFIGURED') { providerFailure = error; break; }
        } else if (!(error instanceof PlannerError)) throw error;
      }
    }
    if (providerFailure) break;
  }
  if (providerFailure) throw providerFailure;
  if (!routes.length) throw new PlannerError('暂时无法形成满足时间与路网约束的路线，请调整条件。', 'ROUTE_UNAVAILABLE');
  if (routes.length < 2) routes[0]!.risks.push('ROUTE_COUNT_LIMITED');
  const itinerary = ItinerarySchema.parse({
    id: randomUUID(), version: 1, preference, origin, routes, status: routes.length >= 2 ? 'complete' : 'degraded',
    generatedAt: new Date().toISOString(), policyVersion: POLICY_VERSION, savedVersion: null,
  });
  return { itinerary, candidates, city };
}
