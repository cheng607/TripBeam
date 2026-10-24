import type { Poi, PoiInsight, PreferenceDraft, TripRoute } from '@tripbeam/contracts';

export type ExperienceVariant = 'deep' | 'wander' | 'easy';

const unique = (items: Array<string | undefined>) => [...new Set(items.filter((item): item is string => Boolean(item?.trim())).map((item) => item.trim()))];

export function experienceFocus(preference: PreferenceDraft): string[] {
  return unique([...(preference.mustHave ?? []), ...(preference.niceToHave ?? []), ...(preference.customPreferences ?? []), ...preference.playPreferences]).slice(0, 5);
}

export function experienceStory(preference: PreferenceDraft): string {
  const focus = experienceFocus(preference);
  return focus.length ? `${focus.slice(0, 2).join('与')}的城市微旅行` : '围绕当下心情的城市微旅行';
}

function poiInsight(poi: Poi, focus: string[], preference: PreferenceDraft): PoiInsight {
  const matchedPreferences = focus.filter((item) => poi.tags.includes(item) || poi.name.includes(item) || poi.category.includes(item)).slice(0, 4);
  const evidence = ['地点坐标已由地图服务验证', ...(matchedPreferences.length ? [`匹配你的偏好：${matchedPreferences.join('、')}`] : [])];
  const risks = [
    ...(preference.party === 'wheelchair' ? ['无障碍设施请在出发前确认'] : []),
    ...(preference.party === 'senior' ? ['建议确认座位与步行条件'] : []),
  ];
  return { poiId: poi.id, matchedPreferences, evidence, risks, confidence: matchedPreferences.length ? 'medium' : 'low' };
}

const tradeoffFor: Record<ExperienceVariant, string> = {
  deep: '减少停靠点，换取在核心地点更充分的停留。',
  wander: '保留街区串联，优先体验连贯性而非赶更多地点。',
  easy: '优先更短的移动与更多余量，必要时可跳过弹性节点。',
};

export function enrichExperienceRoute(route: TripRoute, preference: PreferenceDraft, variant: ExperienceVariant): TripRoute {
  const focus = experienceFocus(preference);
  const story = experienceStory(preference);
  const title = `${story} · ${{ deep: '深度体验', wander: '街区漫游', easy: '轻松留白' }[variant]}`;
  return {
    ...route,
    title,
    experienceStory: story,
    matchedPreferences: focus,
    tradeoff: tradeoffFor[variant],
    poiInsights: route.pois.map((poi) => poiInsight(poi, focus, preference)),
    recommendationReason: `${story}：串联${route.pois.map((poi) => poi.name).join('、')}。${tradeoffFor[variant]}现场营业、排队与无障碍信息请出发前确认。`,
  };
}
