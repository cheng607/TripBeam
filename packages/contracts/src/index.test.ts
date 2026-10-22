import { describe, expect, it } from 'vitest';
import { EditCommandSchema, PreferenceDraftSchema, RouteSchema } from './index.js';

describe('public API contracts', () => {
  it('rejects model-owned route fields in user preferences', () => {
    const preference = {
      originLabel: '春熙路', startTime: '14:00', availableMinutes: 120,
      playPreferences: ['当地美食'], travelPreferences: ['步行'], totalDistanceMeters: 100,
    };
    expect(PreferenceDraftSchema.safeParse(preference).success).toBe(false);
  });

  it('requires a version for every edit command', () => {
    expect(EditCommandSchema.safeParse({ operation: 'remove', poiId: 'a' }).success).toBe(false);
    expect(EditCommandSchema.safeParse({ operation: 'remove', poiId: 'a', baseVersion: 2 }).success).toBe(true);
  });

  it('requires a server-produced stop schedule on every route', () => {
    expect(RouteSchema.safeParse({ id: crypto.randomUUID(), pois: [], legs: [] }).success).toBe(false);
  });
});
