import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const projectIDPattern = /^[A-Za-z0-9_-]+$/;
const assetRoot = fileURLToPath(new URL('../assets/demo/', import.meta.url));

export async function materializeDemo(dataDir: string, projectId: string): Promise<{ paperPath: string; repoPath: string }> {
  if (!projectIDPattern.test(projectId)) throw new Error(`invalid project id ${JSON.stringify(projectId)}`);
  const base = resolve(dataDir, 'demo-materialized', projectId);
  const repoPath = join(base, 'repo');
  const paperPath = join(base, 'paper.md');
  await mkdir(repoPath, { recursive: true });
  await cp(join(assetRoot, 'paper.md'), paperPath, { force: true });
  await cp(join(assetRoot, 'repo'), repoPath, { recursive: true, force: true });
  return { paperPath, repoPath };
}
