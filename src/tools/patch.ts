import { copyFile, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';

interface BackupFile {
  path: string;
  mode: number;
  existed: boolean;
}

interface BackupManifest {
  files: BackupFile[];
}

interface ParsedFile {
  path: string;
  newFile: boolean;
  hunks: Hunk[];
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

const forbidden = ['deleted file mode', 'rename from', 'rename to', 'git binary patch', 'binary files'];

export class PatchManager {
  constructor(public readonly workspace: string) {}

  async validate(diff: string): Promise<string[]> {
    if (!diff.trim()) throw new Error('patch diff is empty');
    if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw new Error('patch diff is too large');
    const lower = diff.toLowerCase();
    for (const marker of forbidden) {
      if (lower.includes(marker)) throw new Error(`unsupported patch operation: ${marker}`);
    }
    const files = parseDiff(diff);
    for (const file of files) {
      const full = this.resolve(file.path);
      const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) {
        if (!file.newFile) throw new Error(`patch target does not exist: ${file.path}`);
      } else {
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`patch target must be a regular file: ${file.path}`);
        if (file.newFile) throw new Error(`new file already exists: ${file.path}`);
      }
    }
    return files.map((file) => file.path);
  }

  async apply(diff: string): Promise<string[]> {
    const files = await this.validate(diff);
    const backupDir = await this.backup(files);
    try {
      const parsed = parseDiff(diff);
      for (const file of parsed) {
        const full = this.resolve(file.path);
        const original = file.newFile ? '' : await readFile(full, 'utf8');
        const updated = applyHunks(original, file.hunks);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, updated, 'utf8');
      }
      const patchDir = join(this.workspace, '.reprolens');
      await mkdir(patchDir, { recursive: true });
      await writeFile(join(patchDir, `patch-${Date.now()}.diff`), diff, 'utf8');
      return files;
    } catch (error) {
      await this.restore(backupDir);
      throw error;
    }
  }

  async backup(files: string[]): Promise<string> {
    const dir = join(this.workspace, '.reprolens', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(dir, { recursive: true });
    const manifest: BackupManifest = { files: [] };
    for (const relativePath of files) {
      const full = this.resolve(relativePath);
      const info = await stat(full).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) {
        manifest.files.push({ path: relativePath, mode: 0o644, existed: false });
        continue;
      }
      const backupPath = join(dir, 'files', ...relativePath.split('/'));
      await mkdir(dirname(backupPath), { recursive: true });
      await copyFile(full, backupPath);
      manifest.files.push({ path: relativePath, mode: info.mode & 0o777, existed: true });
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return dir;
  }

  async restore(backupDir: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest;
    for (const file of manifest.files) {
      const target = this.resolve(file.path);
      if (!file.existed) {
        await rm(target, { force: true });
        continue;
      }
      const source = join(backupDir, 'files', ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }

  private resolve(relativePath: string): string {
    if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\')) {
      throw new Error(`invalid patch path ${JSON.stringify(relativePath)}`);
    }
    const clean = posix.normalize(relativePath);
    if (clean === '.' || clean.startsWith('/') || clean === '..' || clean.startsWith('../') || /^[A-Za-z]:/.test(clean)) {
      throw new Error(`patch path escapes workspace: ${JSON.stringify(relativePath)}`);
    }
    if (clean === '.git' || clean.startsWith('.git/') || clean === '.reprolens' || clean.startsWith('.reprolens/')) {
      throw new Error(`patch cannot modify internal workspace metadata: ${relativePath}`);
    }
    const root = resolve(this.workspace);
    const full = resolve(root, ...clean.split('/'));
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`patch path escapes workspace: ${JSON.stringify(relativePath)}`);
    }
    return full;
  }
}

function parseDiff(diff: string): ParsedFile[] {
  const lines = diff.split(/\r?\n/);
  const files: ParsedFile[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.startsWith('--- ')) continue;
    if (index + 1 >= lines.length || !lines[index + 1]!.startsWith('+++ ')) throw new Error('malformed patch headers');
    const oldHeader = parseHeader(lines[index]!.slice(4));
    const newHeader = parseHeader(lines[index + 1]!.slice(4));
    let path: string;
    let newFile = false;
    if (oldHeader.nullPath && newHeader.nullPath) throw new Error('patch cannot create and delete the same file');
    if (oldHeader.nullPath) {
      path = newHeader.path;
      newFile = true;
    } else if (newHeader.nullPath) {
      throw new Error('file deletion is not supported');
    } else {
      if (oldHeader.path !== newHeader.path) throw new Error('renames are not supported');
      path = newHeader.path;
    }
    index += 1;
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
        index -= 1;
        break;
      }
      if (line.startsWith('@@ ')) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!match) throw new Error(`malformed hunk header: ${line}`);
        current = {
          oldStart: Number(match[1]),
          oldCount: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newCount: match[4] === undefined ? 1 : Number(match[4]),
          lines: [],
        };
        hunks.push(current);
        continue;
      }
      if (!current) continue;
      if (line.startsWith('\\')) continue;
      current.lines.push(line);
    }
    if (hunks.length === 0) throw new Error('patch contains no hunks');
    files.push({ path, newFile, hunks });
  }
  if (files.length === 0) throw new Error('patch contains no file headers');
  return files;
}

function parseHeader(value: string): { path: string; nullPath: boolean } {
  let header = value.trim();
  if (header === '/dev/null') return { path: '', nullPath: true };
  const tab = header.indexOf('\t');
  if (tab >= 0) header = header.slice(0, tab);
  if (header.startsWith('a/') || header.startsWith('b/')) header = header.slice(2);
  if (!header || header.includes('\\')) throw new Error(`invalid patch path ${JSON.stringify(header)}`);
  return { path: header, nullPath: false };
}

function applyHunks(original: string, hunks: Hunk[]): string {
  const sourceLines = original.length === 0 ? [] : original.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start > sourceLines.length || start < cursor) throw new Error('patch hunk is outside file bounds');
    while (cursor < start) output.push(sourceLines[cursor++]!);
    for (const line of hunk.lines) {
      const marker = line[0];
      const body = line.slice(1);
      if (marker === ' ') {
        if (sourceLines[cursor] !== body) throw new Error(`patch context mismatch at line ${cursor + 1}`);
        output.push(sourceLines[cursor++]!);
      } else if (marker === '-') {
        if (sourceLines[cursor] !== body) throw new Error(`patch deletion mismatch at line ${cursor + 1}`);
        cursor += 1;
      } else if (marker === '+') {
        output.push(body);
      } else if (line !== '') {
        throw new Error(`unsupported patch line marker ${JSON.stringify(marker)}`);
      }
    }
  }
  while (cursor < sourceLines.length) output.push(sourceLines[cursor++]!);
  return output.length > 0 ? `${output.join('\n')}\n` : '';
}
