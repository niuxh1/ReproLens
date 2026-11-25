import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory-store.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { StoreNotFoundError, type Store } from '../src/store/store.js';
import type { Project } from '../src/domain/types.js';

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
      expect([first.seq, second.seq]).toEqual([1, 2]);
      const events = await store.listEvents('p2', 1);
      expect(events).toHaveLength(1);
      expect(events[0]?.seq).toBe(2);
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
});
