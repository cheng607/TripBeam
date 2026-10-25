import { describe, expect, it } from 'vitest';
import { heuristicPatch, NativeAgentOrchestrator } from '../src/agent.js';

describe('explicit fallback preference extraction', () => {
  it.each([
    ['想散步，2小时', 120], ['三个小时', 180], ['两个小时', 120], ['一个半小时', 90],
    ['一小时半', 90], ['半小时', 30], ['九十分钟', 90], ['45分钟', 45],
  ])('reads duration without inventing a departure time: %s', (text, minutes) => {
    expect(heuristicPatch(text)).toMatchObject({ availableMinutes: minutes, startTime: undefined });
  });

  it.each([
    ['下午三点半', '15:30'], ['晚上8点', '20:00'], ['上午九点十五分', '09:15'],
    ['14:45，两个小时', '14:45'], ['凌晨十二点', '00:00'],
  ])('normalizes an explicitly stated departure time: %s', (text, startTime) => {
    expect(heuristicPatch(text).startTime).toBe(startTime);
  });

  it.each(['5小时', '10分钟', '25:90', '3.5点', '从3号地铁站出发'])('does not fail or fabricate an invalid value: %s', (text) => {
    expect(() => heuristicPatch(text)).not.toThrow();
    expect(heuristicPatch(text).startTime).toBeUndefined();
    expect(heuristicPatch(text).availableMinutes).toBeUndefined();
  });

  it('removes the departure verb and respects explicitly rejected transport', () => {
    expect(heuristicPatch('从武汉光谷广场出发，下午三点，不想打车，只想步行')).toMatchObject({
      originLabel: '武汉光谷广场', startTime: '15:00', travelPreferences: ['步行'],
    });
  });

  it('continues with explicit preferences and readable questions when the model is unavailable', async () => {
    const agent = new NativeAgentOrchestrator({ parsePreference: async () => { throw new Error('offline'); } }, { writeClarification: async () => { throw new Error('offline'); } });
    const decision = await agent.decide({ text: '两个小时，改成步行', preference: {}, phase: 'collecting' });
    expect(decision.intent).toBe('collect_preference');
    expect(decision.usedFallback).toBe(true);
    expect(decision.patch).toMatchObject({ availableMinutes: 120, travelPreferences: ['步行'] });
    expect(await agent.clarify(['originLabel', 'startTime', 'availableMinutes', 'travelPreferences'])).toBe('再告诉我出发地点、出发时间、可用时长（30 分钟至 4 小时），就能继续规划。');
  });
});
