import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Event, Project } from '../domain/types.js';
import { StoreNotFoundError, type Store } from './store.js';

interface ProjectRow {
  payload: string;
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
  }

  async createProject(project: Project): Promise<void> {
    const now = project.created_at || new Date().toISOString();
    const updated = project.updated_at || now;
    const payload = JSON.stringify({ ...project, created_at: now, updated_at: updated });
    try {
      this.db.prepare('INSERT INTO projects(id, state, payload, updated_at) VALUES(?, ?, ?, ?)')
        .run(project.id, project.state, payload, updated);
    } catch (error) {
      throw new Error(`insert project: ${(error as Error).message}`);
    }
  }

  async getProject(id: string): Promise<Project> {
    const row = this.db.prepare('SELECT payload FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new StoreNotFoundError();
    try {
      return JSON.parse(row.payload) as Project;
    } catch (error) {
      throw new Error(`unmarshal project: ${(error as Error).message}`);
    }
  }

  async saveProject(project: Project): Promise<void> {
    const updated = project.updated_at || new Date().toISOString();
    const payload = JSON.stringify({ ...project, updated_at: updated });
    const result = this.db.prepare('UPDATE projects SET state = ?, payload = ?, updated_at = ? WHERE id = ?')
      .run(project.state, payload, updated, project.id);
    if (result.changes === 0) throw new StoreNotFoundError();
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.db.prepare('SELECT payload FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    return rows.map((row) => JSON.parse(row.payload) as Project);
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

  async listEvents(projectId: string, after = 0): Promise<Event[]> {
    const rows = this.db.prepare(
      `SELECT id, project_id, seq, type, message, COALESCE(data_json, '{}') AS data_json, created_at
       FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC`,
    ).all(projectId, after) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      seq: row.seq,
      type: row.type,
      message: row.message,
      data: JSON.parse(row.data_json || '{}') as Record<string, unknown>,
      created_at: row.created_at,
    }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
