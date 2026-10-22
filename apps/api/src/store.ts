import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Itinerary, Poi, ShareSnapshot } from '@tripbeam/contracts';
import { ItinerarySchema, ShareSnapshotSchema } from '@tripbeam/contracts';

export type StoredPlan = { itinerary: Itinerary; candidates: Poi[]; city: string; ownerSessionId?: string };
type FileData = { plans: Record<string, StoredPlan>; shares: Record<string, ShareSnapshot> };
const clone = <T>(value: T): T => structuredClone(value);

export interface PlanStore {
  putPlan(plan: StoredPlan): Promise<void>;
  getPlan(id: string): Promise<StoredPlan | null>;
  updatePlan(id: string, baseVersion: number, change: (plan: StoredPlan) => StoredPlan): Promise<StoredPlan | 'conflict' | null>;
  save(id: string, baseVersion: number): Promise<StoredPlan | 'conflict' | null>;
  share(id: string, routeId: string): Promise<ShareSnapshot | null>;
  getShare(token: string): Promise<ShareSnapshot | null>;
  healthCheck?(): Promise<void>;
}

export class FilePlanStore implements PlanStore {
  private readonly data: FileData = { plans: {}, shares: {} };
  private ready: Promise<void>;
  private writeChain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {
    this.ready = this.load();
  }

  private async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as FileData;
      for (const [id, plan] of Object.entries(data.plans ?? {})) {
        const parsed = ItinerarySchema.safeParse(plan.itinerary);
        if (parsed.success) this.data.plans[id] = { ...plan, itinerary: parsed.data };
      }
      for (const [token, snapshot] of Object.entries(data.shares ?? {})) {
        const parsed = ShareSnapshotSchema.safeParse(snapshot);
        if (parsed.success) this.data.shares[token] = parsed.data;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async mutate<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.ready;
    const task = this.writeChain.then(async () => { const result = await fn(); await this.persist(); return result; });
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  async putPlan(plan: StoredPlan) {
    await this.mutate(() => { this.data.plans[plan.itinerary.id] = clone(plan); });
  }
  async getPlan(id: string) { await this.ready; await this.writeChain; return this.data.plans[id] ? clone(this.data.plans[id]) : null; }
  async updatePlan(id: string, baseVersion: number, change: (plan: StoredPlan) => StoredPlan) {
    return this.mutate(() => {
      const current = this.data.plans[id];
      if (!current) return null;
      if (current.itinerary.version !== baseVersion) return 'conflict' as const;
      const updated = change(clone(current));
      updated.itinerary = ItinerarySchema.parse(updated.itinerary);
      this.data.plans[id] = clone(updated);
      return clone(updated);
    });
  }
  async save(id: string, baseVersion: number) {
    return this.mutate(() => {
      const current = this.data.plans[id];
      if (!current) return null;
      if (current.itinerary.version !== baseVersion) return 'conflict' as const;
      if (current.itinerary.invalidDraft || current.itinerary.routes.some((route) => route.constraintStatus !== 'valid')) return 'conflict' as const;
      current.itinerary.savedVersion = current.itinerary.version;
      return clone(current);
    });
  }
  async share(id: string, routeId: string) {
    return this.mutate(() => {
      const plan = this.data.plans[id]?.itinerary;
      if (!plan || plan.invalidDraft || plan.savedVersion !== plan.version) return null;
      const route = plan.routes.find((item) => item.id === routeId);
      if (!route || route.constraintStatus !== 'valid') return null;
      const snapshot = ShareSnapshotSchema.parse({
        token: randomBytes(24).toString('base64url'), itineraryId: id, version: plan.version,
        route: clone(route), origin: clone(plan.origin), preference: clone(plan.preference), createdAt: new Date().toISOString(),
      });
      this.data.shares[snapshot.token] = snapshot;
      return clone(snapshot);
    });
  }
  async getShare(token: string) { await this.ready; await this.writeChain; return this.data.shares[token] ? clone(this.data.shares[token]) : null; }
}
