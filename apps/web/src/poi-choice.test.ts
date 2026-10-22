import { describe, expect, it } from 'vitest';
import type { Poi } from '@tripbeam/contracts';
import { filterPoiChoices } from './poi-choice';

const choices = [
  { id: 'a', name: '小象餐厅', category: '餐饮', place: { address: '民族大道' } },
  { id: 'b', name: '光谷步行街', category: '景点', place: { address: '珞喻路' } },
  { id: 'c', name: '城市书店', category: '文化', place: { address: '民族大道' } },
] as Poi[];

describe('filterPoiChoices', () => {
  it('matches name, category, and address without changing source order', () => {
    expect(filterPoiChoices(choices, '小象').map((poi) => poi.id)).toEqual(['a']);
    expect(filterPoiChoices(choices, '文化').map((poi) => poi.id)).toEqual(['c']);
    expect(filterPoiChoices(choices, '民族大道').map((poi) => poi.id)).toEqual(['a', 'c']);
  });

  it('trims keywords and returns all choices for an empty search', () => {
    expect(filterPoiChoices(choices, '  光谷  ').map((poi) => poi.id)).toEqual(['b']);
    expect(filterPoiChoices(choices, ' ')).toEqual(choices);
  });
});
