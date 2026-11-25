import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as tar from 'tar';

const skipped = new Set(['.git', '.hg', '.svn', '.reprolens', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode', 'dist', 'build']);

export async function createWorkspaceArchive(workspace: string, destination: string): Promise<void> {
  const root = resolve(workspace);
  await mkdir(dirname(destination), { recursive: true });
  await tar.create({
    cwd: root,
    file: destination,
    gzip: true,
    portable: true,
    filter: (path) => {
      const first = path?.split('/')[0] ?? '';
      return first === '.' || !skipped.has(first);
    },
  }, ['.']);
}
