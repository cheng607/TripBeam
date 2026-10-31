import { randomUUID } from 'node:crypto';
import type { Coordinate, Itinerary, Place, PlanningDiagnostics, Poi, PreferenceDraft, RouteLeg, TripRoute } from '@tripbeam/contracts';
import { ItinerarySchema, RouteSchema } from '@tripbeam/contracts';
import { MapProviderError, type MapProvider } from './maps.js';
import { enrichExperienceRoute, experienceFocus, type ExperienceVariant } from './experience.js';

export const POLICY_VERSION = 'experience-route-v3';
export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code: 'POI_INSUFFICIENT' | 'ROUTE_UNAVAILABLE' | 'CONSTRAINT_VIOLATION',
    public readonly details?: { totalDurationMinutes?: number; totalDistanceMeters?: number; excessMinutes?: number },
    public readonly diagnostics?: PlanningDiagnostics,
  ) { super(message); }
}

type PlannerRejectionReason = PlanningDiagnostics['rejections'][number]['reason'];
type PlannerFinalReason = PlanningDiagnostics['finalReason'];
const rejectionLabel: Record<PlannerRejectionReason, string> = {
  DUPLICATE_SEQUENCE: '候选地点重复',
  ROUTE_TOO_SIMILAR: '与已有路线过于相似',
  TIME_BUDGET_EXCEEDED: '包含返程后超出可用时长',
  ROUTE_LEG_UNAVAILABLE: '地图未返回可靠线路',
  ROUTE_CONSTRAINT_VIOLATION: '未通过路线约束',
  MAP_PROVIDER_UNAVAILABLE: '地图服务暂不可用',
};

class DiagnosticTracker {
  readonly plannerRunId = randomUUID();
  city: string | undefined;
  readonly counts = { rawPois: 0, concretePois: 0, candidateSequences: 0, routeAttempts: 0, validRoutes: 0 };
  private readonly rejections = new Map<PlannerRejectionReason, number>();

  reject(reason: PlannerRejectionReason) {
    this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
  }

  snapshot(finalReason: PlannerFinalReason): PlanningDiagnostics {
    const rejections = [...this.rejections.entries()].map(([reason, count]) => ({ reason, count }));
    const primary = [...rejections].sort((a, b) => b.count - a.count)[0];
    let summary: string;
    if (finalReason === 'COMPLETED') summary = '已检索 ' + this.counts.concretePois + ' 个具体地点，尝试 ' + this.counts.routeAttempts + ' 条候选路线，生成 ' + this.counts.validRoutes + ' 条有效路线。';
    else if (finalReason === 'DEGRADED') summary = '已检索 ' + this.counts.concretePois + ' 个具体地点，尝试 ' + this.counts.routeAttempts + ' 条候选路线，生成 1 条可出发路线；其余候选未通过路网或时间校验。';
    else if (finalReason === 'POI_INSUFFICIENT') summary = '仅找到 ' + this.counts.concretePois + ' 个可用具体地点，少于生成对比路线所需数量。';
    else if (finalReason === 'MAP_PROVIDER_UNAVAILABLE') summary = '已尝试 ' + this.counts.routeAttempts + ' 条候选路线，但地图服务在算路阶段暂不可用。';
    else summary = '已检索 ' + this.counts.concretePois + ' 个具体地点，尝试 ' + this.counts.routeAttempts + ' 条候选路线，仅生成 ' + this.counts.validRoutes + ' 条有效路线' + (primary ? '；主要淘汰原因：' + rejectionLabel[primary.reason] + '（' + primary.count + ' 条）' : '') + '。';
    return { plannerRunId: this.plannerRunId, ...(this.city ? { city: this.city } : {}), finalReason, counts: { ...this.counts }, rejections, summary };
  }
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
const STANDARD_INTERESTS = new Set(['当地美食', '拍照散步', '文化展览', '自然放松', '逛街购物', '夜生活']);

function clockTime(startTime: string, offset: number): string {
  const [hours, minutes] = startTime.split(':').map(Number);
  const total = hours! * 60 + minutes! + offset;
  return `${total >= 1_440 ? '次日 ' : ''}${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function chinaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function departureAt(tripDate: string, startTime: string, offset: number): { date: string; time: string } {
  const [year, month, day] = tripDate.split('-').map(Number);
  const [hours, minutes] = startTime.split(':').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!, hours!, minutes! + offset));
  return { date: value.toISOString().slice(0, 10), time: value.toISOString().slice(11, 16) };
}

function hardConstraintsWithoutEvidence(preference: PreferenceDraft): string[] {
  const mobilityIsHard = preference.party === 'wheelchair' || preference.mobilityPolicy === 'hard';
  return [
    ...(mobilityIsHard ? ['无障碍/行动便利'] : []),
  ];
}

function poiMatchesMustHave(poi: Poi, constraint: string): boolean {
  if (STANDARD_INTERESTS.has(constraint)) return poi.tags.includes(constraint);
  const verifiedFields = [poi.metadata?.categoryPath, ...(poi.metadata?.cuisineTags ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
  return verifiedFields.includes(constraint.toLocaleLowerCase());
}

function hasUnverifiedPreference(preference: PreferenceDraft): boolean {
  return Boolean(
    preference.customPreferences?.length
    || preference.niceToHave?.some((item) => !STANDARD_INTERESTS.has(item))
    || preference.avoid?.length
    || preference.party === 'senior'
    || preference.party === 'family',
  );
}

function rank(poi: Poi, origin: Place, preferences: string[], priority: string, strategy: RouteStrategy): number {
  const preferenceScore = poi.tags.filter((tag) => preferences.includes(tag)).length * 28;
  const themeScore = priority && poi.tags.includes(priority) ? 34 * strategy.focusWeight : 0;
  const originCost = haversineMeters(origin.coordinate, poi.place.coordinate) / 160 * strategy.legPenalty;
  const areaPenalty = poi.placeKind === 'area' ? 60 : 0;
  // Prefer a provider-backed quality signal when it is available, without
  // inventing one for POIs whose provider detail does not include a rating.
  const providerQuality = poi.metadata?.rating === undefined ? 0 : Math.max(-8, (poi.metadata.rating - 3) * 8);
  return preferenceScore * strategy.focusWeight + themeScore + poi.stayMinutes * strategy.stayWeight + providerQuality - originCost - areaPenalty;
}

function minimumStayMinutes(poi: Poi): number {
  // Older stored POIs do not yet have a range. Keep them compatible while
  // allowing a short, meaningful visit instead of treating a recommendation
  // as a hard scheduling constraint.
  const fallback = Math.max(10, Math.ceil(poi.stayMinutes * 0.45));
  return Math.min(poi.stayMinutes, poi.minStayMinutes ?? fallback);
}

function recommendedStayMinutes(poi: Poi): number {
  return Math.max(minimumStayMinutes(poi), poi.stayMinutes);
}

function allocateStayMinutes(pois: Poi[], dwellBudget: number): number[] {
  const minimums = pois.map(minimumStayMinutes);
  const recommended = pois.map(recommendedStayMinutes);
  const availableExtra = Math.max(0, dwellBudget - minimums.reduce((sum, minutes) => sum + minutes, 0));
  const capacities = recommended.map((minutes, index) => minutes - minimums[index]!);
  const totalCapacity = capacities.reduce((sum, minutes) => sum + minutes, 0);
  if (!totalCapacity || !availableExtra) return minimums;
  const extraToAssign = Math.min(availableExtra, totalCapacity);
  const priority = pois.map((poi) => poi.visitRole === 'core' ? 2.5 : 1);
  const weightedCapacity = capacities.map((minutes, index) => minutes * priority[index]!);
  const totalWeightedCapacity = weightedCapacity.reduce((sum, minutes) => sum + minutes, 0);
  const assigned = minimums.map((minutes, index) => minutes + Math.min(capacities[index]!, Math.floor(extraToAssign * weightedCapacity[index]! / totalWeightedCapacity)));
  let remainder = extraToAssign - assigned.reduce((sum, minutes, index) => sum + minutes - minimums[index]!, 0);
  const assignmentOrder = pois.map((poi, index) => index).sort((left, right) => priority[right]! - priority[left]!);
  while (remainder > 0) for (const index of assignmentOrder) {
    if (assigned[index]! < recommended[index]!) { assigned[index]! += 1; remainder -= 1; }
    if (!remainder) break;
  }
  return assigned;
}

function locationCombinationScore(pois: Poi[], preferences: string[], priority: string, availableMinutes: number): number {
  const coveredPreferences = new Set(pois.flatMap((poi) => poi.tags.filter((tag) => preferences.includes(tag))));
  const primaryMatches = pois.filter((poi) => poi.tags.includes(priority)).length;
  const categoryVariety = new Set(pois.map((poi) => poi.category)).size;
  const quality = pois.reduce((sum, poi) => sum + (poi.metadata?.rating ?? 3) * 2, 0);
  const idealStopCount = availableMinutes <= 90 ? 1 : availableMinutes <= 180 ? 2 : 3;
  return coveredPreferences.size * 70 + primaryMatches * 40 + categoryVariety * 12 + quality - Math.abs(pois.length - idealStopCount) * 16;
}

function assignVisitRoles(pois: Poi[], preference: PreferenceDraft): Poi[] {
  const interests = [...preference.playPreferences, ...(preference.customPreferences ?? []), ...(preference.mustHave ?? [])];
  const scored = pois.map((poi, index) => ({
    index,
    score: poi.tags.filter((tag) => interests.includes(tag)).length * 20 + (poi.metadata?.rating ?? 3),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const coreCount = Math.min(pois.length, Math.max(1, Math.ceil(pois.length / 2)));
  const coreIds = new Set(scored.slice(0, coreCount).map(({ index }) => pois[index]!.id));
  return pois.map((poi) => ({ ...poi, visitRole: coreIds.has(poi.id) ? 'core' as const : 'supporting' as const }));
}

function candidateSequences(candidates: Poi[], origin: Place, preferences: string[], priority: string, strategy: RouteStrategy): Poi[][] {
  // Keep a broader candidate set so a highly ranked POI cannot monopolize every route.
  const ranked = [...candidates].sort((a, b) => rank(b, origin, preferences, priority, strategy) - rank(a, origin, preferences, priority, strategy)).slice(0, 36);
  const beam: Array<{ pois: Poi[]; score: number; estimatedMinutes: number }> = [{ pois: [], score: 0, estimatedMinutes: 0 }];
  const output: typeof beam = [];
  for (let depth = 0; depth < strategy.maxStops; depth++) {
    const next: typeof beam = [];
    for (const state of beam) for (const poi of ranked) {
      if (state.pois.some((item) => item.id === poi.id)) continue;
      // A neighbourhood-scale POI may provide route context, but must follow a
      // concrete venue/landmark and never be the only reason for a route.
      if (poi.placeKind === 'area' && (state.pois.length === 0 || state.pois.some((item) => item.placeKind === 'area'))) continue;
      const previous = state.pois.at(-1)?.place ?? origin;
      const distance = haversineMeters(previous.coordinate, poi.place.coordinate);
      // This stage selects coherent place combinations only. It deliberately
      // avoids using recommended dwell time as a routing constraint; the real
      // road-network and timetable checks happen after a combination is chosen.
      const estimate = state.estimatedMinutes + Math.ceil(distance / 70);
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
  // The selected places form the trip first. Their roles are then used only by
  // the timetable allocator, so a supporting stop gives way before a core one.
  const routePois = assignVisitRoles(pois, preference);
  const tripDate = preference.tripDate ?? chinaToday();
  const assumedTripDate = !preference.tripDate;
  const transitStrategy = preference.mobilityPolicy === 'hard' || preference.party === 'senior' || preference.party === 'wheelchair' ? 'least_walking' as const : 'fastest' as const;
  // Query the road network at each stop's shortest meaningful duration first.
  // A POI's recommended stay is a scheduling preference, not a hard reason to
  // discard a route before its real travel time has been checked.
  let minimumTimelineOffset = 0;
  const rawLegs: RouteLeg[] = [];
  for (const [index, poi] of routePois.entries()) {
    const from = index ? routePois[index - 1]!.place : origin;
    const requestedDeparture = departureAt(tripDate, preference.startTime, minimumTimelineOffset);
    const rawLeg = await map.leg(from, poi.place, mode, city, {
      departureDate: requestedDeparture.date, departureTime: requestedDeparture.time, departureMinuteOffset: minimumTimelineOffset,
      transitStrategy, includeNightService: requestedDeparture.time >= '20:00' || requestedDeparture.time < '06:00',
    });
    rawLegs.push(rawLeg);
    minimumTimelineOffset += rawLeg.durationMinutes + minimumStayMinutes(poi);
  }
  // The operational buffer is a real part of the timeline, before the return
  // journey, rather than an alias for the time left unused by the user.
  minimumTimelineOffset += BUFFER_MINUTES;
  const lastPoi = routePois.at(-1)!;
  const returnDeparture = departureAt(tripDate, preference.startTime, minimumTimelineOffset);
  const rawReturnLeg = await map.leg(lastPoi.place, origin, mode, city, {
    departureDate: returnDeparture.date, departureTime: returnDeparture.time, departureMinuteOffset: minimumTimelineOffset,
    transitStrategy, includeNightService: returnDeparture.time >= '20:00' || returnDeparture.time < '06:00',
  });
  const rawTravelMinutes = [...rawLegs, rawReturnLeg].reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const plannedLimit = preference.timePolicy === 'flexible'
    ? Math.min(240, preference.availableMinutes + 30)
    : Math.min(preference.availableMinutes, 240);
  const minimumStayTotal = routePois.reduce((sum, poi) => sum + minimumStayMinutes(poi), 0);
  const minimumTotalDuration = rawTravelMinutes + BUFFER_MINUTES + minimumStayTotal;
  if (minimumTotalDuration > plannedLimit) {
    const excessMinutes = minimumTotalDuration - plannedLimit;
    throw new PlannerError(`路线超出可用时长 ${excessMinutes} 分钟，请减少停靠点。`, 'CONSTRAINT_VIOLATION', { totalDurationMinutes: minimumTotalDuration, totalDistanceMeters: [...rawLegs, rawReturnLeg].reduce((sum, leg) => sum + leg.distanceMeters, 0), excessMinutes });
  }
  const plannedStayMinutes = allocateStayMinutes(routePois, plannedLimit - rawTravelMinutes - BUFFER_MINUTES);
  const scheduledPois = routePois.map((poi, index) => ({ ...poi, stayMinutes: plannedStayMinutes[index]! }));
  let elapsed = 0;
  const legs: RouteLeg[] = [];
  const scheduledStops: TripRoute['scheduledStops'] = [];
  for (const [index, poi] of scheduledPois.entries()) {
    const rawLeg = rawLegs[index]!;
    const departureMinuteOffset = elapsed;
    elapsed += rawLeg.durationMinutes;
    const arrivalMinuteOffset = elapsed;
    legs.push({ ...rawLeg, fromId: index ? scheduledPois[index - 1]!.id : 'origin', toId: poi.id, plannedDepartureMinuteOffset: departureMinuteOffset, plannedArrivalMinuteOffset: arrivalMinuteOffset });
    elapsed += poi.stayMinutes;
    scheduledStops.push({ poiId: poi.id, arrivalMinuteOffset, departureMinuteOffset: elapsed, arrivalTime: clockTime(preference.startTime, arrivalMinuteOffset), departureTime: clockTime(preference.startTime, elapsed) });
  }
  elapsed += BUFFER_MINUTES;
  const returnDepartureMinuteOffset = elapsed;
  elapsed += rawReturnLeg.durationMinutes;
  legs.push({ ...rawReturnLeg, fromId: scheduledPois.at(-1)!.id, toId: 'origin', plannedDepartureMinuteOffset: returnDepartureMinuteOffset, plannedArrivalMinuteOffset: elapsed });
  const totalDurationMinutes = elapsed;
  const totalDistanceMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const totalWalkingDistanceMeters = legs.reduce((sum, leg) => sum + (leg.walkingDistanceMeters ?? (leg.mode === '步行' ? leg.distanceMeters : 0)), 0);
  const exceededPreferredTime = totalDurationMinutes > preference.availableMinutes;
  const remainingMinutes = Math.max(0, preference.availableMinutes - totalDurationMinutes);
  const route = {
    id: randomUUID(), theme, title, pois: scheduledPois, legs, scheduledStops, totalDurationMinutes, totalDistanceMeters,
    endPlace: origin, returnsToOrigin: true, endArrivalMinuteOffset: elapsed, endArrivalTime: clockTime(preference.startTime, elapsed),
    bufferMinutes: BUFFER_MINUTES, remainingMinutes, totalWalkingDistanceMeters,
    walkingIntensity: (totalWalkingDistanceMeters < 1800 ? 'low' : totalWalkingDistanceMeters < 4000 ? 'medium' : 'high') as TripRoute['walkingIntensity'],
    constraintStatus: 'valid' as const, recommendationReason: reason(title, scheduledPois, mode),
    risks: [
      'OPENING_HOURS_UNCERTAIN' as const,
      // AMap's current adapter does not provide a departure-time traffic
      // guarantee. The schedule carries the requested time into the provider
      // boundary, but must remain explicit about this data limitation.
      'TRAFFIC_TIME_UNCERTAIN' as const,
      ...(assumedTripDate && legs.some((leg) => leg.mode === '公共交通') ? ['TRIP_DATE_ASSUMED' as const] : []),
      ...(hasUnverifiedPreference(preference) ? ['PREFERENCE_UNVERIFIED' as const] : []),
      ...(scheduledPois.some((poi) => poi.place.address === '地址待确认') ? ['POI_DATA_PARTIAL' as const] : []),
      ...(remainingMinutes < 20 ? ['ROUTE_TIME_TIGHT' as const] : []),
      ...(exceededPreferredTime ? ['PREFERENCE_RELAXED' as const] : []),
    ],
  };
  return RouteSchema.parse(route);
}

export async function generateItinerary(preference: PreferenceDraft, map: MapProvider, previousSignatures: string[] = []): Promise<{ itinerary: Itinerary; candidates: Poi[]; city: string; diagnostics: PlanningDiagnostics }> {
  const diagnostics = new DiagnosticTracker();
  const unsupportedConstraints = hardConstraintsWithoutEvidence(preference);
  if (unsupportedConstraints.length) {
    throw new PlannerError(`当前地点数据无法可靠验证以下硬约束：${unsupportedConstraints.join('、')}。请移除硬约束或等待具备可验证数据后再规划。`, 'CONSTRAINT_VIOLATION');
  }
  const { place: origin, city } = await map.resolve(preference.originLabel);
  diagnostics.city = city;
  // Weather is helpful travel context but is not allowed to block route
  // generation when the optional provider request is temporarily unavailable.
  let weather;
  try { weather = await map.weather?.(city); } catch { weather = undefined; }
  const interests = [...new Set([...preference.playPreferences, ...(preference.customPreferences ?? []), ...(preference.mustHave ?? []), ...(preference.niceToHave ?? [])])];
  const raw = await map.nearby(origin, interests, { radiusMeters: searchRadiusMeters(preference) });
  const avoid = preference.avoid ?? [];
  diagnostics.counts.rawPois = raw.length;
  const candidates = raw.filter((poi) => {
    const searchable = `${poi.name} ${poi.category} ${poi.metadata?.categoryPath ?? ''} ${(poi.metadata?.cuisineTags ?? []).join(' ')}`;
    return poi.stayMinutes >= 1 && !avoid.some((item) => searchable.includes(item));
  });
  const unverifiableMustHaves = (preference.mustHave ?? []).filter((constraint) => !candidates.some((poi) => poiMatchesMustHave(poi, constraint)));
  if (unverifiableMustHaves.length) {
    throw new PlannerError(`当前高德地点详情中没有可验证满足以下必选条件的地点：${unverifiableMustHaves.join('、')}。请调整条件或改用具备该数据字段的来源。`, 'CONSTRAINT_VIOLATION');
  }
  const concreteCandidates = candidates.filter((poi) => poi.placeKind !== 'area');
  diagnostics.counts.concretePois = concreteCandidates.length;
  if (concreteCandidates.length < 2) throw new PlannerError('附近缺少至少两个具体地点，无法生成可比较的路线；请调整出发点或偏好。', 'POI_INSUFFICIENT', undefined, diagnostics.snapshot('POI_INSUFFICIENT'));
  const routes: TripRoute[] = [];
  const signatures = new Set<string>();
  let providerFailure: MapProviderError | null = null;
  const focus = experienceFocus(preference);
  for (const [themeIndex, definition] of variants.entries()) {
    const priority = focus[themeIndex] ?? focus[0] ?? '';
    const sequences = candidateSequences(candidates, origin, interests, priority, definition)
      .sort((left, right) => locationCombinationScore(right, interests, priority, preference.availableMinutes) - locationCombinationScore(left, interests, priority, preference.availableMinutes));
    diagnostics.counts.candidateSequences += sequences.length;
    const alternatives = sequences.filter((pois) => !previousSignatures.includes(pois.map((poi) => poi.id).join('|')));
    const ordered = [...alternatives, ...sequences.filter((pois) => previousSignatures.includes(pois.map((poi) => poi.id).join('|')))];
    // Once a route exists, surface the least-overlapping candidates first.
    // This keeps the bounded provider-call budget from being consumed by many
    // near-identical high-score sequences.
    const diverseFirst = routes.length
      ? [...ordered].sort((left, right) => Math.max(...routes.map((route) => routeSimilarity(route.pois, left))) - Math.max(...routes.map((route) => routeSimilarity(route.pois, right))))
      : ordered;
    for (const pois of diverseFirst.slice(0, 20)) {
      const signature = pois.map((poi) => poi.id).join('|');
      if (signatures.has(signature)) { diagnostics.reject('DUPLICATE_SEQUENCE'); continue; }
      if (routes.some((route) => routeSimilarity(route.pois, pois) > 0.5)) { diagnostics.reject('ROUTE_TOO_SIMILAR'); continue; }
      if ((preference.mustHave ?? []).some((item) => !pois.some((poi) => poiMatchesMustHave(poi, item)))) continue;
      try {
        diagnostics.counts.routeAttempts += 1;
        const route = await buildRoute({ origin, city, preference, pois, theme: definition.theme, title: definition.variant, map, mode: preference.travelPreferences[themeIndex % preference.travelPreferences.length] });
        routes.push(enrichExperienceRoute(route, preference, definition.variant)); signatures.add(signature); diagnostics.counts.validRoutes += 1; break;
      } catch (error) {
        if (error instanceof MapProviderError) {
          if (error.code === 'MAP_UNAVAILABLE' || error.code === 'MAP_NOT_CONFIGURED') {
            diagnostics.reject('MAP_PROVIDER_UNAVAILABLE');
            error.diagnostics = diagnostics.snapshot('MAP_PROVIDER_UNAVAILABLE');
            providerFailure = error; break;
          }
          diagnostics.reject('ROUTE_LEG_UNAVAILABLE');
        } else if (error instanceof PlannerError) {
          diagnostics.reject(error.details?.excessMinutes !== undefined ? 'TIME_BUDGET_EXCEEDED' : 'ROUTE_CONSTRAINT_VIOLATION');
        } else throw error;
      }
    }
    if (providerFailure) break;
  }
  if (providerFailure) throw providerFailure;
  if (!routes.length) throw new PlannerError('暂时无法生成满足时间和路网约束的路线；请调整出发点、时间或偏好。', 'ROUTE_UNAVAILABLE', undefined, diagnostics.snapshot('INSUFFICIENT_DISTINCT_VALID_ROUTES'));
  const status = routes.length < 2 ? 'degraded' : 'complete';
  const itinerary = ItinerarySchema.parse({
    id: randomUUID(), version: 1, preference, origin, routes, status, weather,
    generatedAt: new Date().toISOString(), policyVersion: POLICY_VERSION, savedVersion: null,
  });
  return { itinerary, candidates, city, diagnostics: diagnostics.snapshot(status === 'degraded' ? 'DEGRADED' : 'COMPLETED') };
}
