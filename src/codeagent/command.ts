import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import type { CodeAgent, CodeAgentResult, CodeAgentTask } from './code-agent.js';

const execFileAsync = promisify(execFile);

export interface CommandAgentConfig {
  command: string;
  appendPrompt?: boolean;
  runAcceptance?: boolean;
  timeoutMs?: number;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandInspection {
  command: string;
  executable: string;
  available: boolean;
  path?: string;
  version?: string;
}

export async function inspectCommand(command: string): Promise<CommandInspection> {
  const args = splitCommandLine(command.trim());
  const executable = args[0] ?? '';
  if (!executable) return { command, executable: '', available: false };
  if (executable.includes('/') || executable.includes('\\')) {
    try {
      await access(executable, constants.X_OK);
      return { command, executable, available: true, path: executable };
    } catch {
      return { command, executable, available: false };
    }
  }
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = await execFileAsync(locator, [executable], { timeout: 5000, windowsHide: true });
    const path = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    const version = path ? await inspectVersion(path) : undefined;
    return { command, executable, available: Boolean(path), ...(path ? { path } : {}), ...(version ? { version } : {}) };
  } catch {
    return { command, executable, available: false };
  }
}

export class CommandAgent implements CodeAgent {
  private readonly command: string;
  private readonly appendPrompt: boolean;
  private readonly runAcceptance: boolean;
  private readonly timeoutMs: number;

  constructor(config: CommandAgentConfig) {
    this.command = config.command.trim();
    this.appendPrompt = config.appendPrompt ?? true;
    this.runAcceptance = config.runAcceptance ?? false;
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 10 * 60_000;
  }

  name(): string { return 'command-code-agent'; }

  async propose(task: CodeAgentTask): Promise<CodeAgentResult> {
    if (!this.command) throw new Error('code agent command is empty');
    if (!task.workspace || !task.evidenceDir) throw new Error('workspace and evidence directory are required');
    const runId = task.run.run_id || `run_${Date.now()}`;
    const safeRunId = runId.replace(/[^A-Za-z0-9_-]/g, '_');
    const evidenceDir = join(task.evidenceDir, 'codeagent', safeRunId);
    const workDir = join(evidenceDir, `workspace_${Date.now()}`);
    await mkdir(evidenceDir, { recursive: true });
    await copyDir(task.workspace, workDir);
    await initGitBaseline(workDir);
    const prompt = buildPrompt(task);
    const promptPath = join(evidenceDir, 'prompt.txt');
    await writeFile(promptPath, prompt, 'utf8');
    const args = splitCommandLine(this.command);
    if (args.length === 0) throw new Error('code agent command is empty');
    if (this.appendPrompt) args.push(prompt);
    const started = Date.now();
    const result = await runProcess(args[0]!, args.slice(1), {
      cwd: workDir,
      timeoutMs: this.timeoutMs,
      stdin: this.appendPrompt ? undefined : prompt,
      env: {
        ...process.env,
        REPROLENS_CODE_PROMPT_FILE: promptPath,
        REPROLENS_CODE_WORKSPACE: workDir,
      },
      ...(task.onOutput ? { onOutput: task.onOutput } : {}),
    });
    const durationMs = Date.now() - started;
    const logPath = join(evidenceDir, 'agent.log');
    await writeFile(logPath, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`, 'utf8');
    if (result.code !== 0) throw new Error(`code agent failed with exit code ${result.code} (log: ${logPath})`);
    if (this.runAcceptance && task.acceptanceCommand.trim()) {
      const acceptance = await runShell(workDir, task.acceptanceCommand, this.timeoutMs);
      await writeFile(join(evidenceDir, 'acceptance.log'), `STDOUT:\n${acceptance.stdout}\nSTDERR:\n${acceptance.stderr}`, 'utf8');
      if (acceptance.code !== 0) throw new Error(`code agent acceptance command failed with exit code ${acceptance.code}`);
    }
    await git(workDir, ['add', '-N', '.']);
    const diff = (await git(workDir, ['diff', '--binary', 'HEAD', '--', '.'])).stdout;
    if (!diff.trim()) throw new Error('code agent produced no file changes');
    const nameList = (await git(workDir, ['diff', '--name-only', 'HEAD', '--', '.'])).stdout;
    const files = nameList.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (files.length === 0) throw new Error('code agent diff has no files');
    const diffPath = join(evidenceDir, 'diff.patch');
    await writeFile(diffPath, diff, 'utf8');
    return {
      agent: 'command',
      version: this.command,
      diff,
      files,
      summary: `Delegated implementation produced by ${this.command}.`,
      stdout: result.stdout,
      stderr: result.stderr,
      logPath,
      durationMs,
    };
  }
}

async function copyDir(source: string, destination: string): Promise<void> {
  const skip = new Set(['.git', '.reprolens', '__pycache__', 'node_modules', '.venv', 'venv', 'dist', 'build']);
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink not allowed in code agent workspace: ${relative(source, from)}`);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, await readFile(from));
    }
  }
}

async function initGitBaseline(dir: string): Promise<void> {
  await git(dir, ['init', '-q']);
  await mkdir(join(dir, '.git', 'info'), { recursive: true });
  await writeFile(join(dir, '.git', 'info', 'exclude'), '.reprolens/\n__pycache__/\n*.pyc\n.pytest_cache/\n', 'utf8');
  await git(dir, ['config', 'user.email', 'reprolens@local']);
  await git(dir, ['config', 'user.name', 'ReproLens CodeAgent']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'baseline']);
}

async function git(dir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', ['-C', dir, ...args], { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')}: ${err.stderr || err.stdout || err.message || 'failed'}`);
  }
}

async function runShell(dir: string, command: string, timeoutMs: number): Promise<ProcessResult> {
  if (process.platform === 'win32') {
    return runProcess('cmd.exe', ['/d', '/s', '/c', command], { cwd: dir, timeoutMs });
  }
  return runProcess('sh', ['-c', command], { cwd: dir, timeoutMs });
}

function runProcess(binary: string, args: string[], options: {
  cwd: string; timeoutMs: number; stdin?: string; env?: NodeJS.ProcessEnv;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout += text; options.onOutput?.('stdout', text); });
    child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderr += text; options.onOutput?.('stderr', text); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`code agent timed out after ${options.timeoutMs}ms`));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

async function inspectVersion(executable: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(executable, ['--version'], { timeout: 5000, windowsHide: true });
    return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}
function buildPrompt(task: CodeAgentTask): string {
  const visuals = (task.paper.pages ?? []).map((page) => `page ${page.page_number}: ${page.image_path ?? 'text only'}; captions=${page.caption_candidates.join(' | ') || 'none'}`).join('\n');
  return [
    'You are a professional code implementation agent working inside a disposable copy of a research repository.',
    'Implement or repair the missing experiment code needed to reproduce the selected paper claim.',
    '',
    'Hard constraints:',
    '- Modify only files inside the current working directory.',
    "- Do not change the paper's expected value, tolerance, data split, metric definition, or claim.",
    '- Keep changes minimal and preserve existing public behavior where possible.',
    '- Do not commit changes.',
    '- Run relevant tests if possible and report the commands and results in your final response.',
    '',
    `Project: ${task.projectId}`,
    `Claim: ${task.claim.claim_id}`,
    `Metric: ${task.claim.metric}`,
    `Expected: ${task.claim.expected_value}`,
    `Tolerance: abs=${task.claim.tolerance.abs} rel=${task.claim.tolerance.rel}`,
    `Plan command: ${task.plan.command}`,
    `Acceptance command: ${task.acceptanceCommand}`,
    '',
    'Diagnosis:',
    `class=${task.diagnosis.failure_class}`,
    `root_cause=${task.diagnosis.root_cause}`,
    `explanation=${task.diagnosis.explanation ?? ''}`,
    `needs_code_agent=${task.diagnosis.needs_code_agent ?? false}`,
    '',
    'Failed run stdout:',
    truncate(task.run.stdout ?? '', 8000),
    'Failed run stderr:',
    truncate(task.run.stderr ?? '', 8000),
    '',
    'Paper visual evidence:',
    visuals || 'No page images were supplied.',
    '',
    'Paper excerpt:',
    truncate(task.paper.text, 12000),
    '',
    'When finished, provide a concise summary of files changed, tests run, and remaining risks.',
  ].join('\n');
}

function splitCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('unterminated quote in code agent command');
  if (current) args.push(current);
  return args;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}
