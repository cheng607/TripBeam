import type { EditCommand, NaturalEdit, Poi, TripRoute, InvalidDraft } from '@tripbeam/contracts';
import { buildRoute, PlannerError } from './planner.js';
import type { MapProvider } from './maps.js';
import type { PlanStore, StoredPlan } from './store.js';

export class WorkflowError extends Error {
  constructor(message: string, public readonly status = 422) { super(message); }
}

export function selectPois(plan: StoredPlan, routeId: string, command: EditCommand): Poi[] {
  const route = plan.itinerary.routes.find((r) => r.id === routeId);
  if (!route) throw new WorkflowError('路线不存在。', 404);
  if (plan.itinerary.invalidDraft && plan.itinerary.invalidDraft.routeId !== routeId) throw new WorkflowError('请先处理当前未通过校验的草稿。');
  const original = plan.itinerary.invalidDraft?.pois ?? route.pois;
  const byId = new Map([...plan.candidates, ...original].map((p) => [p.id, p]));
  const ids = original.map((p) => p.id);
  let next = [...ids];
  const stayUpdate = command.operation === 'stay' ? { poiId: command.poiId, stayMinutes: command.stayMinutes } : undefined;
  if (stayUpdate && !ids.includes(stayUpdate.poiId)) throw new WorkflowError('只能调整当前路线中的停留时间。');
  if (command.operation === 'remove') { if (!ids.includes(command.poiId)) throw new WorkflowError('删除地点不在当前路线中。'); next = ids.filter((id) => id !== command.poiId); }
  if (command.operation === 'add') next.push(command.poiId);
  if (command.operation === 'replace') { if (!ids.includes(command.poiId)) throw new WorkflowError('替换地点不在当前路线中。'); next = ids.map((id) => id === command.poiId ? command.replacementPoiId : id); }
  if (command.operation === 'reorder') {
    if (command.poiIds.length !== ids.length || command.poiIds.some((id) => !ids.includes(id))) throw new WorkflowError('排序必须包含当前全部地点。');
    next = command.poiIds;
  }
  if (!next.length || next.length > 8 || new Set(next).size !== next.length || next.some((id) => !byId.has(id))) throw new WorkflowError('编辑后需有 1–8 个不重复的已知地点。');
  return next.map((id) => {
    const poi = byId.get(id)!;
    return stayUpdate?.poiId === id ? { ...poi, stayMinutes: stayUpdate.stayMinutes } : poi;
  });
}

export async function editRoute(store: PlanStore, map: MapProvider, id: string, routeId: string, command: EditCommand) {
  const plan = await store.getPlan(id);
  if (!plan) throw new WorkflowError('行程不存在。', 404);
  if (plan.itinerary.version !== command.baseVersion) throw new WorkflowError('行程已更新，请刷新后重试。', 409);
  const pois = selectPois(plan, routeId, command);
  const old = plan.itinerary.routes.find((r) => r.id === routeId)!;
  let route: TripRoute | undefined;
  let invalidDraft: InvalidDraft | undefined;
  try {
    route = await buildRoute({ origin: plan.itinerary.origin, city: plan.city, preference: plan.itinerary.preference, pois, theme: old.theme, title: old.title, mode: old.legs[0]!.mode, map });
    route.id = old.id;
  } catch (error) {
    if (!(error instanceof PlannerError) || error.code !== 'CONSTRAINT_VIOLATION') throw error;
    invalidDraft = { routeId, pois, violations: [{ code: error.code, message: error.message, excessMinutes: error.details?.excessMinutes }], totalDurationMinutes: error.details?.totalDurationMinutes, totalDistanceMeters: error.details?.totalDistanceMeters };
  }
  const result = await store.updatePlan(id, command.baseVersion, (current) => ({ ...current, itinerary: {
    ...current.itinerary, version: current.itinerary.version + 1, savedVersion: null, invalidDraft,
    routes: current.itinerary.routes.map((r) => r.id === routeId && route ? route : r),
  } }));
  if (!result || result === 'conflict') throw new WorkflowError('版本已更新，请刷新后重试。', 409);
  return result;
}

export async function restoreRoute(store: PlanStore, id: string, baseVersion: number, routeId?: string) {
  const existing = await store.getPlan(id);
  if (!existing) throw new WorkflowError('行程不存在。', 404);
  if (existing.itinerary.version !== baseVersion) throw new WorkflowError('行程已更新，请刷新后重试。', 409);
  if (routeId && !existing.itinerary.routes.some((route) => route.id === routeId)) throw new WorkflowError('路线不存在。', 404);
  if (!existing.itinerary.invalidDraft || (routeId && existing.itinerary.invalidDraft.routeId !== routeId)) throw new WorkflowError('当前路线没有需要恢复的草稿。');
  const result = await store.updatePlan(id, baseVersion, (plan) => ({ ...plan, itinerary: { ...plan.itinerary, version: baseVersion + 1, savedVersion: null, invalidDraft: undefined } }));
  if (!result || result === 'conflict') throw new WorkflowError('版本已更新，请刷新后重试。', 409);
  return result;
}

// Ambiguous names are never silently resolved to the first candidate.
export function resolveNaturalEdit(plan: StoredPlan, routeId: string, edit: NaturalEdit): EditCommand {
  const route = plan.itinerary.routes.find((r) => r.id === routeId);
  if (!route) throw new WorkflowError('请先选择要编辑的路线。');
  const current = plan.itinerary.invalidDraft?.routeId === routeId ? plan.itinerary.invalidDraft.pois : route.pois;
  const resolve = (name: string | undefined, choices: Poi[], allowPosition = false) => {
    if (!name) throw new WorkflowError('请明确要操作的地点名称。');
    if (allowPosition) {
      const ordinal = name.match(/^第([1-8一二两三四五六七八])站$/);
      const ordinalNumbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };
      const position = name === '最后一站' ? choices.length : ordinal ? ordinalNumbers[ordinal[1]!] ?? Number(ordinal[1]) : undefined;
      if (position !== undefined) {
        const poi = choices[position - 1];
        if (!poi) throw new WorkflowError(`当前路线只有 ${choices.length} 站，请确认要操作的站点。`);
        return poi.id;
      }
    }
    const exact = choices.filter((p) => p.id === name || p.name === name);
    const matches = exact.length ? exact : choices.filter((p) => p.name.includes(name));
    if (matches.length !== 1) throw new WorkflowError(matches.length ? `“${name}”匹配多个地点，请使用完整名称或在列表中选择。` : `没有找到“${name}”，请从候选地点中选择。`);
    return matches[0]!.id;
  };
  const baseVersion = plan.itinerary.version;
  switch (edit.operation) {
    case 'remove': return { operation: 'remove', baseVersion, poiId: resolve(edit.target, current, true) };
    case 'add': return { operation: 'add', baseVersion, poiId: resolve(edit.replacement ?? edit.target, plan.candidates) };
    case 'replace': return { operation: 'replace', baseVersion, poiId: resolve(edit.target, current, true), replacementPoiId: resolve(edit.replacement, plan.candidates) };
    case 'reorder': return { operation: 'reorder', baseVersion, poiIds: (edit.order ?? []).map((name) => resolve(name, current, true)) };
  }
}
