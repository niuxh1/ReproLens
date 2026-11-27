import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory-store.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { StoreBusyError, StoreConflictError, StoreNotFoundError, type Store } from '../src/store/store.js';
import type { Operation, Project } from '../src/domain/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sampleProject(id: string): Project {
  const now = '2026-11-25T10:00:00.000Z';
  return {
    id,
    name: 'accuracy demo',
    state: 'CREATED',
    paper_path: 'paper.md',
    repo_path: 'repo',
    workspace_path: 'workspace',
    evidence_dir: 'evidence',
    budget: { max_runs: 3, max_seconds: 120, max_patches: 2 },
    paper: {
      title: 'demo', text: 'accuracy 0.81', source_path: 'paper.md', sha256: 'abc', claims: [], parsed_at: now,
    },
    repo: { root: 'repo', files: [], command_candidates: [], scanned_at: now },
    claims: [{ claim_id: 'C1', text: 'accuracy 0.81', metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, source: { path: 'paper.md', line: 4 }, selected: false }],
    created_at: now,
    updated_at: now,
  };
}

async function stores(): Promise<Record<string, Store>> {
  const dir = await mkdtemp(join(tmpdir(), 'reprolens-store-'));
  dirs.push(dir);
  const sqlite = new SqliteStore(join(dir, 'reprolens.db'));
  return { memory: new MemoryStore(), sqlite };
}

describe('stores', () => {
  it('round-trips and saves projects', async () => {
    const all = await stores();
    for (const [name, store] of Object.entries(all)) {
      await store.createProject(sampleProject('p1'));
      const got = await store.getProject('p1');
      expect(got.name).toBe('accuracy demo');
      expect(got.claims?.[0]?.expected_value).toBe(0.81);
      got.state = 'AWAITING_CLAIMS';
      got.error = 'none';
      got.updated_at = '2026-11-25T10:01:00.000Z';
      await store.saveProject(got);
      const again = await store.getProject('p1');
      expect(again.state).toBe('AWAITING_CLAIMS');
      expect(again.error).toBe('none');
      await store.close();
      expect(name).toBeTruthy();
    }
  });

  it('assigns sequential event sequence numbers and filters by after', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await store.createProject(sampleProject('p2'));
      const first = await store.appendEvent('p2', 'state', 'created', { state: 'CREATED' });
      const second = await store.appendEvent('p2', 'run', 'started', { attempt: 1 });
      const third = await store.appendEvent('p2', 'plain', 'no payload');
      expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
      expect(third.data).toBeUndefined();
      expect((await store.listEvents('p2', 2))[0]?.data).toBeUndefined();
      const events = await store.listEvents('p2', 1);
      expect(events.map((event) => event.seq)).toEqual([2, 3]);
      expect(events[0]?.type).toBe('run');
      expect(events[0]?.type).toBe('run');
      expect(events[0]?.data?.attempt).toBe(1);
      await store.close();
    }
  });

  it('throws a typed not-found error', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await expect(store.getProject('missing')).rejects.toBeInstanceOf(StoreNotFoundError);
      await store.close();
    }
  });

  it('rejects stale project revisions', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await store.createProject(sampleProject('p3'));
      const first = await store.getProject('p3');
      const stale = await store.getProject('p3');
      first.state = 'AWAITING_CLAIMS';
      const saved = await store.saveProject(first);
      expect(saved.revision).toBe(2);
      stale.state = 'FAILED';
      await expect(store.saveProject(stale)).rejects.toBeInstanceOf(StoreConflictError);
      expect((await store.getProject('p3')).state).toBe('AWAITING_CLAIMS');
      await store.close();
    }
  });

  it('persists operations and finds them by idempotency key', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await store.createProject(sampleProject('p4'));
      const now = new Date().toISOString();
      const operation: Operation = {
        id: 'op_1', project_id: 'p4', kind: 'start', status: 'running',
        idempotency_key: 'idem-1', lease_owner: 'test-owner',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        heartbeat_at: now, created_at: now, updated_at: now,
      };
      await store.createOperation(operation);
      const found = await store.findOperationByIdempotencyKey('idem-1');
      expect(found).toMatchObject({ id: 'op_1', kind: 'start', status: 'running' });
      const finished = await store.saveOperation({ ...found!, status: 'succeeded', finished_at: now });
      expect(finished.status).toBe('succeeded');
      expect((await store.getOperation('op_1')).finished_at).toBe(now);
      expect(await store.listOperations('p4')).toHaveLength(1);
      await store.close();
    }
  });

  it('limits event pages without changing sequence numbers', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await store.createProject(sampleProject('p5'));
      for (let index = 0; index < 5; index += 1) {
        await store.appendEvent('p5', 'test', `event ${index}`);
      }
      const page = await store.listEvents('p5', 1, 2);
      expect(page.map((event) => event.seq)).toEqual([2, 3]);
      await store.close();
    }
  });
  it('allows only one exclusive running operation per project', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await store.createProject(sampleProject('p6'));
      const now = new Date().toISOString();
      const base = {
        project_id: 'p6', status: 'running' as const, lease_owner: 'owner', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        heartbeat_at: now, created_at: now, updated_at: now,
      };
      await store.createOperation({ ...base, id: 'op_running', kind: 'start' });
      await expect(store.createOperation({ ...base, id: 'op_second', kind: 'select_claims' })).rejects.toBeInstanceOf(StoreBusyError);
      await expect(store.createOperation({ ...base, id: 'op_stop', kind: 'stop' })).resolves.toBeUndefined();
      await store.close();
    }
  });

  it('uses owner-checked lease renewal and expires only overdue operations', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await store.createProject(sampleProject('p7'));
      const now = new Date().toISOString();
      await store.createOperation({
        id: 'op_lease', project_id: 'p7', kind: 'start', status: 'running', lease_owner: 'owner-a',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(), heartbeat_at: now, created_at: now, updated_at: now,
      });
      expect(await store.renewOperationLease('op_lease', 'owner-b', now, new Date(Date.now() + 60_000).toISOString())).toBe(false);
      expect(await store.renewOperationLease('op_lease', 'owner-a', now, new Date(Date.now() + 60_000).toISOString())).toBe(true);
      expect(await store.abandonExpiredOperations(now, 'expired')).toBe(0);
      expect(await store.finishOperation('op_lease', 'owner-b', 'succeeded', now)).toBe(false);
      expect(await store.finishOperation('op_lease', 'owner-a', 'succeeded', now)).toBe(true);
      expect((await store.getOperation('op_lease')).status).toBe('succeeded');
      await store.close();
    }
  });
  it('persists a project revision and its state event together', async () => {
    const all = await stores();
    for (const store of Object.values(all)) {
      await store.createProject(sampleProject('p8'));
      const project = await store.getProject('p8');
      project.state = 'AWAITING_CLAIMS';
      const result = await store.saveProjectAndEvent(project, 'state_changed', 'state changed', { from: 'CREATED', to: 'AWAITING_CLAIMS' });
      expect(result.project.revision).toBe(2);
      expect(result.event.seq).toBe(1);
      expect(result.event.type).toBe('state_changed');
      const events = await store.listEvents('p8');
      expect(events).toHaveLength(1);
      expect(events[0]?.data?.to).toBe('AWAITING_CLAIMS');
      await store.close();
    }
  });});
