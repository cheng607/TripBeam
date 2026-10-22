import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('TripBeam API', () => {
  it('accepts a complete preference but does not start the planner', async () => {
    const app = createApp();
    const response = await app.inject({ method: 'POST', url: '/v1/preferences/validate', payload: {
      originLabel: '成都春熙路', startTime: '14:00', availableMinutes: 120,
      playPreferences: ['当地美食'], travelPreferences: ['步行'],
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, plannerStatus: 'not_started' });
    expect(response.json().requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await app.close();
  });

  it('uses only a validated LLM extraction and returns missing fields', async () => {
    const app = createApp({ intentParser: { parsePreference: async () => ({ playPreferences: ['拍照散步'] }) } });
    const response = await app.inject({ method: 'POST', url: '/v1/conversations/test/messages', payload: { text: '下午想拍照' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: 'llm', status: 'needs_user_input', missingFields: expect.arrayContaining(['originLabel', 'travelPreferences']) });
    await app.close();
  });
});
