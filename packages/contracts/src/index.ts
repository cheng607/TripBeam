import { z } from 'zod';

export const PLAY_PREFERENCE_OPTIONS = ['当地美食', '拍照散步', '文化展览', '自然放松', '逛街购物', '夜生活'] as const;
export const TRAVEL_PREFERENCE_OPTIONS = ['步行', '自行车', '公共交通', '打车', '自驾'] as const;

export const PreferenceDraftSchema = z.object({
  originLabel: z.string().trim().min(1, '请填写出发点').max(120),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '请选择开始时间'),
  availableMinutes: z.number().int().min(30).max(240),
  playPreferences: z.array(z.string().trim().min(1).max(20)).min(1, '请选择至少一个游玩偏好').max(3),
  travelPreferences: z.array(z.enum(TRAVEL_PREFERENCE_OPTIONS)).min(1, '请选择至少一种出行方式'),
  customPreferences: z.array(z.string().trim().min(1).max(30)).max(5).optional(),
  notes: z.string().trim().max(300).optional(),
}).strict();

export type PreferenceDraft = z.infer<typeof PreferenceDraftSchema>;

/**
 * Model-owned fields are deliberately limited to preference extraction. Routes,
 * duration totals, distances and constraint decisions are not part of this DTO.
 */
export const PreferenceExtractionSchema = z.object({
  originLabel: z.string().trim().min(1).max(120).optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  availableMinutes: z.number().int().min(30).max(240).optional(),
  playPreferences: z.array(z.string().trim().min(1).max(20)).max(3).optional(),
  travelPreferences: z.array(z.enum(TRAVEL_PREFERENCE_OPTIONS)).min(1).max(5).optional(),
  customPreferences: z.array(z.string().trim().min(1).max(30)).max(5).optional(),
  notes: z.string().trim().max(300).optional(),
}).strict();

export const ConversationMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(1000),
}).strict();

export const ClarificationResponseSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(['needs_user_input', 'ready_for_planner']),
  preference: PreferenceExtractionSchema,
  missingFields: z.array(z.enum(['originLabel', 'startTime', 'availableMinutes', 'playPreferences', 'travelPreferences'])),
  message: z.string().min(1).max(240),
  source: z.enum(['llm', 'fallback']),
}).strict();

export const PreferenceValidationResponseSchema = z.object({
  requestId: z.string().uuid(),
  accepted: z.literal(true),
  preference: PreferenceDraftSchema,
  plannerStatus: z.literal('not_started'),
}).strict();

export const ApiErrorSchema = z.object({
  requestId: z.string().uuid(),
  code: z.enum(['VALIDATION_ERROR', 'LLM_UNAVAILABLE', 'LLM_INVALID_RESPONSE', 'INTERNAL_ERROR', 'MAP_NOT_CONFIGURED', 'LOCATION_NOT_FOUND', 'MAP_UNAVAILABLE', 'ROUTE_UNAVAILABLE', 'POI_INSUFFICIENT', 'CONSTRAINT_VIOLATION', 'NOT_FOUND', 'VERSION_CONFLICT', 'NOT_SAVED']),
  message: z.string().min(1).max(240),
  details: z.array(z.object({ path: z.string(), message: z.string() }).strict()).max(20).optional(),
}).strict();

export type PreferenceExtraction = z.infer<typeof PreferenceExtractionSchema>;
export type ConversationMessageRequest = z.infer<typeof ConversationMessageRequestSchema>;
export type ClarificationResponse = z.infer<typeof ClarificationResponseSchema>;
export type PreferenceValidationResponse = z.infer<typeof PreferenceValidationResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const CoordinateSchema = z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict();
export const PlaceSchema = z.object({ label: z.string().min(1).max(160), address: z.string().max(240), coordinate: CoordinateSchema }).strict();
export const PoiSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(160), category: z.string().min(1).max(40),
  tags: z.array(z.string().min(1).max(30)).max(8), place: PlaceSchema,
  stayMinutes: z.number().int().min(10).max(180),
}).strict();
export const RouteLegSchema = z.object({
  fromId: z.string().min(1), toId: z.string().min(1), mode: z.enum(TRAVEL_PREFERENCE_OPTIONS),
  durationMinutes: z.number().int().min(1).max(120), distanceMeters: z.number().int().min(0).max(20000),
  geometry: z.array(CoordinateSchema).min(2).max(3000),
}).strict();
export const ScheduledStopSchema = z.object({
  poiId: z.string().min(1), arrivalMinuteOffset: z.number().int().min(0).max(240),
  departureMinuteOffset: z.number().int().min(0).max(240),
}).strict();
export const RiskCodeSchema = z.enum(['OPENING_HOURS_UNCERTAIN', 'MAP_UNAVAILABLE', 'POI_DATA_PARTIAL', 'ROUTE_TIME_TIGHT', 'PREFERENCE_RELAXED', 'ROUTE_COUNT_LIMITED']);
export const RouteSchema = z.object({
  id: z.string().uuid(), theme: z.enum(['food_first', 'photo_first', 'easy_walk', 'balanced']),
  title: z.string().min(1).max(80), pois: z.array(PoiSchema).min(1).max(8), legs: z.array(RouteLegSchema).min(1).max(8),
  scheduledStops: z.array(ScheduledStopSchema).min(1).max(8),
  totalDurationMinutes: z.number().int().min(1).max(240), totalDistanceMeters: z.number().int().min(0).max(50000),
  bufferMinutes: z.number().int().min(0).max(240), walkingIntensity: z.enum(['low', 'medium', 'high']),
  remainingMinutes: z.number().int().min(0).max(240).optional(),
  constraintStatus: z.literal('valid'), recommendationReason: z.string().min(1).max(500),
  risks: z.array(RiskCodeSchema).max(8),
}).strict();
export const InvalidDraftSchema = z.object({
  routeId: z.string().uuid(), pois: z.array(PoiSchema).min(1).max(8),
  violations: z.array(z.object({ code: z.string(), message: z.string(), excessMinutes: z.number().nonnegative().optional(), poiId: z.string().optional() }).strict()).min(1),
  totalDurationMinutes: z.number().nonnegative().optional(),
  totalDistanceMeters: z.number().nonnegative().optional(),
}).strict();
export const ItinerarySchema = z.object({
  id: z.string().uuid(), version: z.number().int().min(1), preference: PreferenceDraftSchema,
  origin: PlaceSchema, routes: z.array(RouteSchema).min(1).max(3), status: z.enum(['complete', 'degraded']),
  generatedAt: z.string().datetime(), policyVersion: z.string().min(1), savedVersion: z.number().int().min(1).nullable(),
  invalidDraft: InvalidDraftSchema.optional(),
}).strict();
export const GenerateResponseSchema = z.object({ requestId: z.string().uuid(), itinerary: ItinerarySchema }).strict();
export const EditCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('remove'), baseVersion: z.number().int().min(1), poiId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('reorder'), baseVersion: z.number().int().min(1), poiIds: z.array(z.string().min(1)).min(1).max(8) }).strict(),
  z.object({ operation: z.literal('add'), baseVersion: z.number().int().min(1), poiId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('replace'), baseVersion: z.number().int().min(1), poiId: z.string().min(1), replacementPoiId: z.string().min(1) }).strict(),
]);
export const ShareSnapshotSchema = z.object({ token: z.string().min(24).max(128), itineraryId: z.string().uuid(), version: z.number().int().min(1), route: RouteSchema, origin: PlaceSchema, preference: PreferenceDraftSchema, createdAt: z.string().datetime() }).strict();

export type Coordinate = z.infer<typeof CoordinateSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type Poi = z.infer<typeof PoiSchema>;
export type RouteLeg = z.infer<typeof RouteLegSchema>;
export type TripRoute = z.infer<typeof RouteSchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
export type InvalidDraft = z.infer<typeof InvalidDraftSchema>;
export type EditCommand = z.infer<typeof EditCommandSchema>;
export type ShareSnapshot = z.infer<typeof ShareSnapshotSchema>;

// Agent suggestions carry intent and explicit preferences, never route facts.
export const AgentIntentSchema = z.enum(['collect_preference', 'edit_route', 'explain_route', 'regenerate', 'unknown']);
export const NaturalEditSchema = z.object({
  operation: z.enum(['remove', 'replace', 'add', 'reorder']),
  target: z.string().max(160).optional(), replacement: z.string().max(160).optional(),
  order: z.array(z.string().max(160)).min(1).max(8).optional(),
}).strict();
export const AgentDecisionSchema = z.object({
  intent: AgentIntentSchema, patch: PreferenceExtractionSchema,
  edit: NaturalEditSchema.optional(),
}).strict();
export const TurnRequestSchema = z.object({
  turnId: z.string().uuid(), text: z.string().trim().max(1000),
  action: z.enum(['message', 'confirm_preferences', 'regenerate', 'explain_route']).default('message'),
  preferencePatch: PreferenceExtractionSchema.optional(),
  itineraryId: z.string().uuid().optional(), routeId: z.string().uuid().optional(),
  baseVersion: z.number().int().positive().optional(),
}).strict();
export const SessionSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative(), preference: PreferenceExtractionSchema,
  phase: z.enum(['collecting', 'needs_user_input', 'ready_for_planner', 'complete', 'degraded', 'invalid_draft', 'no_route', 'error']),
  itineraryIds: z.array(z.string().uuid()), itineraryId: z.string().uuid().optional(), routeId: z.string().uuid().optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.string() }).strict()),
}).strict();
export const TurnResultSchema = z.object({
  requestId: z.string().uuid(), session: SessionSchema,
  intent: AgentIntentSchema, source: z.enum(['dify', 'native', 'fallback', 'form']),
  message: z.string(), missingFields: z.array(z.string()), fieldsToAsk: z.array(z.string()).max(3),
  warnings: z.array(z.string()), steps: z.array(z.string()),
  itinerary: ItinerarySchema.optional(),
  actions: z.array(z.enum(['confirm_preferences', 'adjust_preferences', 'retry', 'restore', 'auto_trim', 'edit', 'compare'])),
}).strict();
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type NaturalEdit = z.infer<typeof NaturalEditSchema>;
export type AgentSession = z.infer<typeof SessionSchema>;
export type TurnRequest = z.infer<typeof TurnRequestSchema>;
export type TurnResult = z.infer<typeof TurnResultSchema>;
