import { randomUUID } from 'node:crypto';
import type { Coordinate, Itinerary, Place, Poi, PreferenceDraft, RouteLeg, TripRoute } from '@tripbeam/contracts';
import { ItinerarySchema, RouteSchema } from '@tripbeam/contracts';
import { MapProviderError, type MapProvider } from './maps.js';
import { enrichExperienceRoute, experienceFocus, type ExperienceVariant } from './experience.js';

export const POLICY_VERSION = 'short-trip-v1';
export class PlannerError extends Error {
  constructor(message: string, public readonly code: 'POI_INSUFFICIENT' | 'ROUTE_UNAVAILABLE' | 'CONSTRAINT_VIOLATION', public readonly details?: { totalDurationMinutes?: number; totalDistanceMeters?: number; excessMinutes?: number }) { super(message); }
}

export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

const variants: Array<{ variant: ExperienceVariant; theme: TripRoute['theme']; title: string }> = [
  { variant: 'deep', theme: 'balanced', title: '深度体验' },
  { variant: 'wander', theme: 'balanced', title: '街区漫游' },
  { variant: 'easy', theme: 'easy_walk', title: '轻松留白' },
];
const BUFFER_MINUTES = 10;

function rank(poi: Poi, origin: Place, preferences: string[], priority: string): number {
  const preferenceScore = poi.tags.filter((tag) => preferences.includes(tag)).length * 28;
  const themeScore = priority && poi.tags.includes(priority) ? 34 : 0;
  return preferenceScore + themeScore - haversineMeters(origin.coordinate, poi.place.coordinate) / 160;
}

function candidateSequences(candidates: Poi[], origin: Place, preferences: string[], priority: string, availableMinutes: number): Poi[][] {
  const ranked = [...candidates].sort((a, b) => rank(b, origin, preferences, priority) - rank(a, origin, preferences, priority)).slice(0, 12);
  const beam: Array<{ pois: Poi[]; score: number; estimatedMinutes: number }> = [{ pois: [], score: 0, estimatedMinutes: 0 }];
  const output: typeof beam = [];
  for (let depth = 0; depth < 3; depth++) {
    const next: typeof beam = [];
    for (const state of beam) for (const poi of ranked) {
      if (state.pois.some((item) => item.id === poi.id)) continue;
      const previous = state.pois.at(-1)?.place ?? origin;
      const distance = haversineMeters(previous.coordinate, poi.place.coordinate);
      const estimate = state.estimatedMinutes + poi.stayMinutes + Math.ceil(distance / 70) + BUFFER_MINUTES;
      if (estimate > availableMinutes + 25) continue;
      next.push({ pois: [...state.pois, poi], estimatedMinutes: estimate, score: state.score + rank(poi, origin, preferences, priority) - distance / 120 });
    }
    next.sort((a, b) => b.score - a.score);
    beam.splice(0, beam.length, ...next.slice(0, 24));
    output.push(...beam);
  }
  return output.sort((a, b) => b.score - a.score).map((item) => item.pois);
}

function reason(title: string, pois: Poi[], mode: RouteLeg['mode']): string {
  const names = pois.map((poi) => poi.name).join('、');
  return `${title}串联${names}，按${mode}的路网时间安排停留与缓冲。营业和现场情况请在出发前确认。`;
}

export async function buildRoute(input: {
  origin: Place; city: string; preference: PreferenceDraft; pois: Poi[]; theme: TripRoute['theme']; title: string; map: MapProvider; mode?: RouteLeg['mode'];
}): Promise<TripRoute> {
  const { origin, city, preference, pois, map, theme, title } = input;
  if (!pois.length || new Set(pois.map((poi) => poi.id)).size !== pois.length || pois.some((poi) => haversineMeters(origin.coordinate, poi.place.coordinate) > 8_000)) {
    throw new PlannerError('路线包含重复或超出 8km 范围的地点。', 'CONSTRAINT_VIOLATION');
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
  const raw = await map.nearby(origin, interests);
  const avoid = preference.avoid ?? [];
  const candidates = raw.filter((poi) => {
    const searchable = `${poi.name} ${poi.category} ${poi.tags.join(' ')}`;
    return haversineMeters(origin.coordinate, poi.place.coordinate) <= 8_000
      && poi.stayMinutes >= 10
      && !avoid.some((item) => searchable.includes(item));
  });
  if (!candidates.length) throw new PlannerError('附近没有足够的可用地点，请更换出发点或偏好。', 'POI_INSUFFICIENT');
  const routes: TripRoute[] = [];
  const signatures = new Set<string>();
  let providerFailure: MapProviderError | null = null;
  const focus = experienceFocus(preference);
  for (const [themeIndex, definition] of variants.entries()) {
    const priority = focus[themeIndex] ?? focus[0] ?? '';
    const sequences = candidateSequences(candidates, origin, interests, priority, preference.availableMinutes);
    const alternatives = sequences.filter((pois) => !previousSignatures.includes(pois.map((poi) => poi.id).join('|')));
    const ordered = [...alternatives, ...sequences.filter((pois) => previousSignatures.includes(pois.map((poi) => poi.id).join('|')))];
    for (const pois of ordered.filter((pois) => definition.variant !== 'easy' || pois.length <= 2).slice(0, 6)) {
      const signature = pois.map((poi) => poi.id).join('|');
      if (signatures.has(signature) || (definition.variant === 'easy' && pois.length > 2)) continue;
      try {
        const route = await buildRoute({ origin, city, preference, pois, theme: definition.theme, title: definition.title, map, mode: preference.travelPreferences[themeIndex % preference.travelPreferences.length] });
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
