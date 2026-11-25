import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { RepoSummary } from '../domain/types.js';

const commandPattern = /^\s*(?:\$ )?(python(?:3)?|pytest|rscript|bash|sh|go\s+test|node|uv\s+run|poetry\s+run|pip(?:3)?)\b.+$/i;
const skipped = new Set(['.git', '.hg', '.svn', '.reprolens', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode', 'dist', 'build']);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export async function scanRepo(root: string): Promise<RepoSummary> {
  const absolute = join(root);
  const info = await lstat(absolute);
  if (!info.isDirectory()) throw new Error('repository is not a directory');
  const summary: RepoSummary = {
    root: absolute,
    files: [],
    command_candidates: [],
    scanned_at: new Date().toISOString(),
  };
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(absolute, full).split('\\').join('/');
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name.toLowerCase())) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      if (count <= 2000) summary.files.push(rel);
      const lower = rel.toLowerCase();
      if (['readme.md', 'readme.rst', 'readme.txt'].includes(basename(lower))) {
        const fileInfo = await lstat(full);
        if (fileInfo.size <= 2 * 1024 * 1024) summary.readme = await readFile(full, 'utf8');
      } else if (basename(lower) === 'requirements.txt' || (lower.startsWith('requirements/') && lower.endsWith('.txt'))) {
        const fileInfo = await lstat(full);
        if (fileInfo.size <= 2 * 1024 * 1024) {
          const lines = (await readFile(full, 'utf8')).split(/\r?\n/).map((line) => line.trim());
          summary.requirements = [...(summary.requirements ?? []), ...lines.filter((line) => line && !line.startsWith('#') && !line.startsWith('-'))];
        }
      } else if (basename(lower).startsWith('license') || basename(lower).startsWith('copying')) {
        const fileInfo = await lstat(full);
        if (fileInfo.size <= 2 * 1024 * 1024) summary.license = truncate(await readFile(full, 'utf8'), 2000);
      }
    }
  };
  await walk(absolute);
  const seen = new Set<string>();
  for (const raw of (summary.readme ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^`+|`+$/g, '').replace(/^\$ /, '');
    if (commandPattern.test(line) && !seen.has(line)) {
      seen.add(line);
      summary.command_candidates.push(line);
      if (summary.command_candidates.length >= 20) break;
    }
  }
  return summary;
}
