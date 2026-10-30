import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { SessionSchema, TurnResultSchema, type AgentSession, type TurnResult } from '@tripbeam/contracts';

export type SessionRecord = { session: AgentSession; tokenHash: string; turns: Record<string, { fingerprint: string; result: TurnResult }>; createdAt: string; updatedAt: string };
export interface SessionStore {
  get(id: string): Promise<SessionRecord | null>;
  put(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  deleteExpired(cutoff: string): Promise<string[]>;
  healthCheck?(): Promise<void>;
  close?(): Promise<void>;
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function authorized(record: SessionRecord | null, token: string) {
  return Boolean(record && token && timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(tokenHash(token), 'hex')));
}
export function newSession() {
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const record: SessionRecord = { tokenHash: tokenHash(token), turns: {}, createdAt: now, updatedAt: now, session: { id: randomUUID(), revision: 0, preference: {}, phase: 'collecting', messages: [], itineraryIds: [] } };
  return { token, record };
}
function parse(value: SessionRecord): SessionRecord {
  const fallback = value.session.messages.at(-1)?.createdAt ?? value.createdAt ?? new Date().toISOString();
  return { tokenHash: value.tokenHash, session: SessionSchema.parse(value.session), turns: Object.fromEntries(Object.entries(value.turns ?? {}).map(([id, turn]) => [id, { fingerprint: turn.fingerprint, result: TurnResultSchema.parse(turn.result) }])), createdAt: value.createdAt ?? fallback, updatedAt: value.updatedAt ?? fallback };
}
export class MemorySessionStore implements SessionStore {
  protected records = new Map<string, SessionRecord>();
  async get(id: string) { return structuredClone(this.records.get(id) ?? null); }
  async put(record: SessionRecord) { this.records.set(record.session.id, structuredClone(parse({ ...record, updatedAt: new Date().toISOString() }))); }
  async delete(id: string) { this.records.delete(id); }
  async deleteExpired(cutoff: string) {
    const expired: string[] = [];
    for (const [id, record] of this.records) if (record.updatedAt < cutoff) { this.records.delete(id); expired.push(id); }
    return expired;
  }
}
export class FileSessionStore extends MemorySessionStore {
  private ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private path: string) { super(); this.ready = this.load(); }
  private async load() {
    try { const values = JSON.parse(await readFile(this.path, 'utf8')) as SessionRecord[]; for (const value of values) { const record = parse(value); this.records.set(record.session.id, record); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  override async get(id: string) { await this.ready; await this.chain; return super.get(id); }
  override async put(record: SessionRecord) {
    await this.ready;
    const job = this.chain.then(async () => {
      const next = new Map(this.records); next.set(record.session.id, structuredClone(parse({ ...record, updatedAt: new Date().toISOString() })));
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...next.values()]), { mode: 0o600 });
      await rename(temporary, this.path); this.records = next;
    });
    this.chain = job.catch(() => undefined); await job;
  }
  override async delete(id: string) {
    await this.ready;
    const job = this.chain.then(async () => {
      const next = new Map(this.records); next.delete(id);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...next.values()]), { mode: 0o600 });
      await rename(temporary, this.path); this.records = next;
    });
    this.chain = job.catch(() => undefined); await job;
  }
  override async deleteExpired(cutoff: string) {
    await this.ready;
    const expired: string[] = [];
    const job = this.chain.then(async () => {
      const next = new Map(this.records);
      for (const [id, record] of next) if (record.updatedAt < cutoff) { next.delete(id); expired.push(id); }
      if (expired.length) {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify([...next.values()]), { mode: 0o600 });
        await rename(temporary, this.path); this.records = next;
      }
    });
    this.chain = job.catch(() => undefined); await job; return expired;
  }
}
export class PgSessionStore implements SessionStore {
  private pool: Pool; private ready: Promise<unknown>;
  constructor(url: string) {
    const ssl = process.env.DATABASE_SSL === 'true' ? {
      rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
      ca: process.env.DATABASE_CA_CERT_PATH ? readFileSync(process.env.DATABASE_CA_CERT_PATH, 'utf8') : undefined,
    } : undefined;
    this.pool = new Pool({ connectionString: url, ssl, max: Number(process.env.DATABASE_POOL_MAX ?? 10), connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
    this.ready = this.pool.query('CREATE TABLE IF NOT EXISTS tripbeam_sessions (id uuid PRIMARY KEY, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  }
  async healthCheck() { await this.ready; await this.pool.query('SELECT 1'); }
  async get(id: string) { await this.ready; const result = await this.pool.query('SELECT payload FROM tripbeam_sessions WHERE id=$1', [id]); return result.rows[0] ? parse(result.rows[0].payload) : null; }
  async put(record: SessionRecord) { await this.ready; const value = parse({ ...record, updatedAt: new Date().toISOString() }); await this.pool.query('INSERT INTO tripbeam_sessions(id,payload,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at', [record.session.id, JSON.stringify(value), value.updatedAt]); }
  async delete(id: string) { await this.ready; await this.pool.query('DELETE FROM tripbeam_sessions WHERE id=$1', [id]); }
  async deleteExpired(cutoff: string) {
    await this.ready;
    const result = await this.pool.query<{ id: string }>(`DELETE FROM tripbeam_sessions WHERE updated_at < $1 RETURNING id`, [cutoff]);
    return result.rows.map((row) => row.id);
  }
  async close() { await this.pool.end(); }
}
