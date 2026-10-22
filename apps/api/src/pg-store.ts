import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { ItinerarySchema, ShareSnapshotSchema, type ShareSnapshot } from '@tripbeam/contracts';
import type { PlanStore, StoredPlan } from './store.js';

/** PostgreSQL is the production source of truth; JSONB preserves the versioned API DTO. */
export class PostgresPlanStore implements PlanStore {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(connectionString: string) {
    const ssl = process.env.DATABASE_SSL === 'true' ? {
      rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
      ca: process.env.DATABASE_CA_CERT_PATH ? readFileSync(process.env.DATABASE_CA_CERT_PATH, 'utf8') : undefined,
    } : undefined;
    this.pool = new Pool({ connectionString, ssl, max: Number(process.env.DATABASE_POOL_MAX ?? 10), connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
    this.ready = this.initialize();
  }

  private async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tripbeam_plans (
        id uuid PRIMARY KEY, version integer NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS tripbeam_shares (
        token text PRIMARY KEY, itinerary_id uuid NOT NULL REFERENCES tripbeam_plans(id),
        version integer NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS tripbeam_shares_itinerary_idx ON tripbeam_shares(itinerary_id);
    `);
  }

  async healthCheck() { await this.ready; await this.pool.query('SELECT 1'); }

  private parsePlan(value: unknown): StoredPlan {
    const source = value as StoredPlan;
    return { ...source, itinerary: ItinerarySchema.parse(source.itinerary) };
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async putPlan(plan: StoredPlan) {
    await this.ready;
    const parsed = this.parsePlan(plan);
    await this.pool.query('INSERT INTO tripbeam_plans(id, version, payload) VALUES ($1, $2, $3::jsonb)', [parsed.itinerary.id, parsed.itinerary.version, JSON.stringify(parsed)]);
  }

  async getPlan(id: string): Promise<StoredPlan | null> {
    await this.ready;
    const result = await this.pool.query<{ payload: StoredPlan }>('SELECT payload FROM tripbeam_plans WHERE id = $1', [id]);
    return result.rows[0] ? this.parsePlan(result.rows[0].payload) : null;
  }

  async updatePlan(id: string, baseVersion: number, change: (plan: StoredPlan) => StoredPlan): Promise<StoredPlan | 'conflict' | null> {
    return this.transaction(async (client) => {
      const found = await client.query<{ version: number; payload: StoredPlan }>('SELECT version, payload FROM tripbeam_plans WHERE id = $1 FOR UPDATE', [id]);
      const row = found.rows[0];
      if (!row) return null;
      if (row.version !== baseVersion) return 'conflict';
      const updated = this.parsePlan(change(this.parsePlan(row.payload)));
      if (updated.itinerary.version !== baseVersion + 1) throw new Error('Version must increment exactly once');
      await client.query('UPDATE tripbeam_plans SET version = $2, payload = $3::jsonb, updated_at = now() WHERE id = $1', [id, updated.itinerary.version, JSON.stringify(updated)]);
      return updated;
    });
  }

  async save(id: string, baseVersion: number): Promise<StoredPlan | 'conflict' | null> {
    return this.transaction(async (client) => {
      const found = await client.query<{ version: number; payload: StoredPlan }>('SELECT version, payload FROM tripbeam_plans WHERE id = $1 FOR UPDATE', [id]);
      const row = found.rows[0];
      if (!row) return null;
      if (row.version !== baseVersion) return 'conflict';
      const plan = this.parsePlan(row.payload);
      if (plan.itinerary.invalidDraft || plan.itinerary.routes.some((route) => route.constraintStatus !== 'valid')) return 'conflict';
      plan.itinerary.savedVersion = baseVersion;
      await client.query('UPDATE tripbeam_plans SET payload = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(plan)]);
      return plan;
    });
  }

  async share(id: string, routeId: string): Promise<ShareSnapshot | null> {
    return this.transaction(async (client) => {
      const found = await client.query<{ version: number; payload: StoredPlan }>('SELECT version, payload FROM tripbeam_plans WHERE id = $1 FOR UPDATE', [id]);
      const row = found.rows[0];
      if (!row) return null;
      const plan = this.parsePlan(row.payload).itinerary;
      if (plan.invalidDraft || plan.savedVersion !== row.version) return null;
      const route = plan.routes.find((item) => item.id === routeId);
      if (!route || route.constraintStatus !== 'valid') return null;
      const snapshot = ShareSnapshotSchema.parse({
        token: randomBytes(24).toString('base64url'), itineraryId: id, version: row.version,
        route, origin: plan.origin, preference: plan.preference, createdAt: new Date().toISOString(),
      });
      await client.query('INSERT INTO tripbeam_shares(token, itinerary_id, version, payload) VALUES ($1, $2, $3, $4::jsonb)', [snapshot.token, id, row.version, JSON.stringify(snapshot)]);
      return snapshot;
    });
  }

  async getShare(token: string): Promise<ShareSnapshot | null> {
    await this.ready;
    const found = await this.pool.query<{ payload: ShareSnapshot }>('SELECT payload FROM tripbeam_shares WHERE token = $1', [token]);
    return found.rows[0] ? ShareSnapshotSchema.parse(found.rows[0].payload) : null;
  }

  async close() { await this.pool.end(); }
}
