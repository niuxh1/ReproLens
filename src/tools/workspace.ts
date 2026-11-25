import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const projectIDPattern = /^[A-Za-z0-9_-]+$/;
const skippedDirs = new Set([
  '.git', '.hg', '.svn', '.reprolens', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode', 'dist', 'build',
]);

export class Workspace {
  private constructor(
    public readonly projectRoot: string,
    public readonly root: string,
    public readonly evidenceDir: string,
    public readonly artifactDir: string,
  ) {}

  static async create(dataDir: string, projectId: string): Promise<Workspace> {
    if (!projectIDPattern.test(projectId)) throw new Error(`invalid project id ${JSON.stringify(projectId)}`);
    const projectRoot = resolve(dataDir, 'projects', projectId);
    const workspace = new Workspace(projectRoot, join(projectRoot, 'workspace'), join(projectRoot, 'evidence'), join(projectRoot, 'artifacts'));
    await Promise.all([workspace.root, workspace.evidenceDir, workspace.artifactDir].map((dir) => mkdir(dir, { recursive: true })));
    return workspace;
  }

  resolvePath(relativePath: string): string {
    if (isAbsolute(relativePath)) throw new Error(`absolute path not allowed: ${relativePath}`);
    const root = resolve(this.root);
    const full = resolve(root, relativePath);
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${relativePath}`);
    }
    return full;
  }

  async evidencePath(name: string): Promise<string> {
    if (isAbsolute(name)) throw new Error('absolute evidence path not allowed');
    const full = resolve(this.evidenceDir, name);
    const rel = relative(resolve(this.evidenceDir), full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('evidence path escapes directory');
    await mkdir(dirname(full), { recursive: true });
    return full;
  }

  async copyRepo(source: string): Promise<void> {
    const sourceAbs = resolve(source);
    const info = await lstat(sourceAbs);
    if (!info.isDirectory()) throw new Error(`repository is not a directory: ${sourceAbs}`);
    let count = 0;
    let total = 0;
    const copy = async (from: string, to: string): Promise<void> => {
      const entries = await readdir(from, { withFileTypes: true });
      for (const entry of entries) {
        const sourcePath = join(from, entry.name);
        const targetPath = join(to, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`symlink not allowed in repository: ${relative(sourceAbs, sourcePath)}`);
        if (entry.isDirectory()) {
          if (skippedDirs.has(entry.name.toLowerCase())) continue;
          await mkdir(targetPath, { recursive: true });
          await copy(sourcePath, targetPath);
          continue;
        }
        if (!entry.isFile()) continue;
        count += 1;
        if (count > 20_000) throw new Error('repository exceeds 20000 files');
        const fileInfo = await lstat(sourcePath);
        total += fileInfo.size;
        if (total > 2 * 1024 * 1024 * 1024) throw new Error('repository exceeds size limit');
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, await readFile(sourcePath));
      }
    };
    await copy(sourceAbs, this.root);
  }
}
