import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { PreferenceDraftSchema } from '@tripbeam/contracts';

const fixturePath = fileURLToPath(new URL('../../../test/route-evaluation/cases.json', import.meta.url));
const CaseSchema = z.object({
  id: z.string().regex(/^C\d{2}-[a-z0-9-]+$/),
  input: PreferenceDraftSchema,
  reviewFocus: z.string().min(12).max(200),
}).strict();

describe('route evaluation fixture set', () => {
  it('contains 20 valid and uniquely identified route-comparison cases', async () => {
    const cases = z.array(CaseSchema).length(20).parse(JSON.parse(await readFile(fixturePath, 'utf8')));
    expect(new Set(cases.map((item) => item.id)).size).toBe(20);
    expect(new Set(cases.map((item) => item.input.originLabel)).size).toBe(20);
    expect(cases.some((item) => item.input.customPreferences?.includes('带老人'))).toBe(true);
    expect(cases.some((item) => item.input.customPreferences?.includes('轮椅同行'))).toBe(true);
    expect(cases.some((item) => item.input.availableMinutes <= 90)).toBe(true);
  });
});
