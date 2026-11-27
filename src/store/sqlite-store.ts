import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Event, Operation, OperationKind, OperationStatus, Project } from '../domain/types.js';
import { StoreBusyError, StoreConflictError, StoreDuplicateError, StoreNotFoundError, type Store } from './store.js';

interface ProjectRow {
  payload: string;
  revision: number;
}

interface EventRow {
  id: number;
  project_id: string;
  seq: number;
  type: string;
  message: string;
  data_json: string | null;
  created_at: string;
}

interface OperationRow {
  id: string;
  project_id: string;
  kind: string;
  status: string;
  idempotency_key: string | null;
  request_hash: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  result_revision: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(private readonly path: string) {
    if (!path) throw new Error('sqlite path is empty');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    this.applyMigration(1, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          message TEXT NOT NULL,
          data_json TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(project_id, seq),
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, seq);
      `);
    });
    this.applyMigration(2, () => {
      const columns = this.db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'revision')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          idempotency_key TEXT UNIQUE,
          request_hash TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          heartbeat_at TEXT,
          result_revision INTEGER,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_operations_project_created ON operations(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_operations_status_lease ON operations(status, lease_expires_at);
      `);
    });
    this.applyMigration(3, () => {
      this.db.exec(`
        UPDATE operations
        SET status = 'abandoned', error = 'superseded during exclusive-operation migration',
            updated_at = datetime('now'), finished_at = datetime('now')
        WHERE status = 'running' AND kind <> 'stop'
          AND id NOT IN (
            SELECT MAX(id) FROM operations
            WHERE status = 'running' AND kind <> 'stop'
            GROUP BY project_id
          );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_operations_one_exclusive_running
        ON operations(project_id)
        WHERE status = 'running' AND kind <> 'stop';
      `);
    });
  }

  private applyMigration(version: number, migrate: () => void): void {
    const exists = this.db.prepare('SELECT 1 AS present FROM schema_migrations WHERE version = ?').get(version) as { present: number } | undefined;
    if (exists) return;
    const transaction = this.db.transaction(() => {
      migrate();
      this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(version, new Date().toISOString());
    });
    transaction();
  }

  async createProject(project: Project): Promise<void> {
    const now = project.created_at || new Date().toISOString();
    const updated = project.updated_at || now;
    const revision = project.revision ?? 1;
    const payload = JSON.stringify({ ...project, revision, created_at: now, updated_at: updated });
    try {
      this.db.prepare('INSERT INTO projects(id, state, payload, updated_at, revision) VALUES(?, ?, ?, ?, ?)')
        .run(project.id, project.state, payload, updated, revision);
    } catch (error) {
      if (isConstraint(error)) throw new StoreDuplicateError();
      throw new Error(`insert project: ${(error as Error).message}`);
    }
  }

  async getProject(id: string): Promise<Project> {
    const row = this.db.prepare('SELECT payload, revision FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new StoreNotFoundError();
    try {
      const project = JSON.parse(row.payload) as Project;
      return { ...project, revision: project.revision ?? row.revision ?? 1 };
    } catch (error) {
      throw new Error(`unmarshal project: ${(error as Error).message}`);
    }
  }

  async saveProject(project: Project, expectedRevision?: number): Promise<Project> {
    const existing = this.db.prepare('SELECT revision FROM projects WHERE id = ?').get(project.id) as { revision: number } | undefined;
    if (!existing) throw new StoreNotFoundError();
    const currentRevision = existing.revision ?? 1;
    const expected = expectedRevision ?? project.revision ?? currentRevision;
    if (expected !== currentRevision) throw new StoreConflictError();
    const nextRevision = currentRevision + 1;
    const updated = project.updated_at || new Date().toISOString();
    const next = { ...project, revision: nextRevision, updated_at: updated };
    const result = this.db.prepare('UPDATE projects SET state = ?, payload = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?')
      .run(next.state, JSON.stringify(next), updated, nextRevision, project.id, currentRevision);
    if (result.changes === 0) throw new StoreConflictError();
    Object.assign(project, next);
    return structuredClone(next);
  }

  async saveProjectAndEvent(project: Project, type: string, message: string, data?: Record<string, unknown>): Promise<{ project: Project; event: Event }> {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT revision FROM projects WHERE id = ?').get(project.id) as { revision: number } | undefined;
      if (!existing) throw new StoreNotFoundError();
      const currentRevision = existing.revision ?? 1;
      const expected = project.revision ?? currentRevision;
      if (expected !== currentRevision) throw new StoreConflictError();
      const now = new Date().toISOString();
      const next = { ...project, revision: currentRevision + 1, updated_at: now };
      const update = this.db.prepare('UPDATE projects SET state = ?, payload = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?')
        .run(next.state, JSON.stringify(next), now, next.revision, project.id, currentRevision);
      if (update.changes === 0) throw new StoreConflictError();
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE project_id = ?')
        .get(project.id) as { seq: number };
      const dataJSON = data === undefined ? null : JSON.stringify(data);
      const inserted = this.db.prepare(
        'INSERT INTO events(project_id, seq, type, message, data_json, created_at) VALUES(?, ?, ?, ?, ?, ?)',
      ).run(project.id, row.seq, type, message, dataJSON, now);
      const event: Event = {
        id: Number(inserted.lastInsertRowid), project_id: project.id, seq: row.seq, type, message,
        ...(data === undefined ? {} : { data }), created_at: now,
      };
      Object.assign(project, next);
      return { project: structuredClone(next), event };
    });
    return transaction();
  }
  async listProjects(): Promise<Project[]> {
    const rows = this.db.prepare('SELECT payload, revision FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    return rows.map((row) => {
      const project = JSON.parse(row.payload) as Project;
      return { ...project, revision: project.revision ?? row.revision ?? 1 };
    });
  }

  async appendEvent(projectId: string, type: string, message: string, data?: Record<string, unknown>): Promise<Event> {
    const transaction = this.db.transaction(() => {
      const exists = this.db.prepare('SELECT 1 AS present FROM projects WHERE id = ?').get(projectId) as { present: number } | undefined;
      if (!exists) throw new StoreNotFoundError();
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE project_id = ?')
        .get(projectId) as { seq: number };
      const createdAt = new Date().toISOString();
      const dataJSON = data === undefined ? null : JSON.stringify(data);
      const result = this.db.prepare(
        'INSERT INTO events(project_id, seq, type, message, data_json, created_at) VALUES(?, ?, ?, ?, ?, ?)',
      ).run(projectId, row.seq, type, message, dataJSON, createdAt);
      return {
        id: Number(result.lastInsertRowid),
        project_id: projectId,
        seq: row.seq,
        type,
        message,
        ...(data === undefined ? {} : { data }),
        created_at: createdAt,
      } satisfies Event;
    });
    return transaction();
  }

  async listEvents(projectId: string, after = 0, limit = 10_000): Promise<Event[]> {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT id, project_id, seq, type, message, data_json, created_at
       FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    ).all(projectId, after, boundedLimit) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      seq: row.seq,
      type: row.type,
      message: row.message,
      ...(row.data_json ? { data: JSON.parse(row.data_json) as Record<string, unknown> } : {}),
      created_at: row.created_at,
    }));
  }

  async createOperation(operation: Operation): Promise<void> {
    const exists = this.db.prepare('SELECT 1 AS present FROM projects WHERE id = ?').get(operation.project_id) as { present: number } | undefined;
    if (!exists) throw new StoreNotFoundError();
    if (operation.status === 'running' && operation.kind !== 'stop') {
      const busy = this.db.prepare(
        "SELECT 1 AS present FROM operations WHERE project_id = ? AND status = 'running' AND kind <> 'stop'",
      ).get(operation.project_id) as { present: number } | undefined;
      if (busy) throw new StoreBusyError();
    }
    try {
      this.db.prepare(`
        INSERT INTO operations(
          id, project_id, kind, status, idempotency_key, request_hash, lease_owner, lease_expires_at,
          heartbeat_at, result_revision, error, created_at, updated_at, finished_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.id, operation.project_id, operation.kind, operation.status, operation.idempotency_key ?? null,
        operation.request_hash ?? null, operation.lease_owner ?? null, operation.lease_expires_at ?? null,
        operation.heartbeat_at ?? null, operation.result_revision ?? null, operation.error ?? null,
        operation.created_at, operation.updated_at, operation.finished_at ?? null,
      );
    } catch (error) {
      if (isConstraint(error)) {
        const busy = this.db.prepare(
          "SELECT 1 AS present FROM operations WHERE project_id = ? AND status = 'running' AND kind <> 'stop'",
        ).get(operation.project_id) as { present: number } | undefined;
        if (busy && operation.kind !== 'stop') throw new StoreBusyError();
        throw new StoreDuplicateError('operation or idempotency key already exists');
      }
      throw error;
    }
  }

  async getOperation(id: string): Promise<Operation> {
    const row = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined;
    if (!row) throw new StoreNotFoundError('operation not found');
    return operationFromRow(row);
  }

  async saveOperation(operation: Operation): Promise<Operation> {
    const next = { ...operation, updated_at: operation.updated_at || new Date().toISOString() };
    const result = this.db.prepare(`
      UPDATE operations SET
        status = ?, idempotency_key = ?, request_hash = ?, lease_owner = ?, lease_expires_at = ?,
        heartbeat_at = ?, result_revision = ?, error = ?, updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      next.status, next.idempotency_key ?? null, next.request_hash ?? null, next.lease_owner ?? null,
      next.lease_expires_at ?? null, next.heartbeat_at ?? null, next.result_revision ?? null, next.error ?? null,
      next.updated_at, next.finished_at ?? null, next.id,
    );
    if (result.changes === 0) throw new StoreNotFoundError('operation not found');
    return next;
  }

  async findOperationByIdempotencyKey(key: string): Promise<Operation | null> {
    const row = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(key) as OperationRow | undefined;
    return row ? operationFromRow(row) : null;
  }

  async listOperations(projectId?: string): Promise<Operation[]> {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM operations WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as OperationRow[]
      : this.db.prepare('SELECT * FROM operations ORDER BY created_at DESC').all() as OperationRow[];
    return rows.map(operationFromRow);
  }

  async renewOperationLease(id: string, owner: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE operations SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(heartbeatAt, leaseExpiresAt, heartbeatAt, id, owner);
    return result.changes > 0;
  }

  async finishOperation(id: string, owner: string, status: 'succeeded' | 'failed', finishedAt: string, resultRevision?: number, error?: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE operations SET status = ?, result_revision = ?, error = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(status, resultRevision ?? null, error ?? null, finishedAt, finishedAt, id, owner);
    return result.changes > 0;
  }

  async abandonExpiredOperations(now: string, reason: string): Promise<number> {
    const result = this.db.prepare(`
      UPDATE operations SET status = 'abandoned', error = ?, updated_at = ?, finished_at = ?
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(reason, now, now, now);
    return result.changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function operationFromRow(row: OperationRow): Operation {
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind as OperationKind,
    status: row.status as OperationStatus,
    ...(row.idempotency_key ? { idempotency_key: row.idempotency_key } : {}),
    ...(row.request_hash ? { request_hash: row.request_hash } : {}),
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
    ...(row.heartbeat_at ? { heartbeat_at: row.heartbeat_at } : {}),
    ...(row.result_revision !== null ? { result_revision: row.result_revision } : {}),
    ...(row.error ? { error: row.error } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.finished_at ? { finished_at: row.finished_at } : {}),
  };
}

function isConstraint(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? '';
  return code.startsWith('SQLITE_CONSTRAINT');
}
