import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export interface ExecutionRequest {
  projectId: string;
  runId: string;
  workspace: string;
  evidenceDir: string;
  command: string;
  image?: string;
  workDir: string;
  seed: number;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExecutionResult {
  runner: string;
  status: 'succeeded' | 'failed' | 'timeout';
  command: string;
  image?: string;
  workDir: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutPath?: string;
  stderrPath?: string;
  env: Record<string, string>;
  gpu: boolean;
  provider?: string;
  remoteJobId?: string;
  offerId?: string;
}

export interface Runner {
  name(): string;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

const allowedCommand = /^\s*(python(?:3)?|pytest|rscript|bash|sh|go\s+test|node|uv\s+run|poetry\s+run|pip(?:3)?)\b/i;
const runIdPattern = /^[A-Za-z0-9_-]+$/;

export function validateExecutionCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('command is empty');
  if (/[\r\n]/.test(command)) throw new Error('command must be a single line');
  if (/&&|\|\||;|\||>|<|`|\$\(|\$\{/.test(command)) throw new Error('command contains unsupported shell composition');
  if (!allowedCommand.test(command)) throw new Error('command executable is not allowed');
  const args = splitCommandLine(command);
  if (args.length === 0) throw new Error('command is empty');
  return args;
}

export function splitCommandLine(command: string): string[] {
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
    } else if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('unterminated quote in command');
  if (current) args.push(current);
  return args;
}

export async function resolveWorkDir(workspace: string, workDir: string): Promise<{ hostPath: string; containerPath: string }> {
  const root = resolve(workspace);
  if (isAbsolute(workDir)) throw new Error('work_dir must be relative');
  const full = resolve(root, workDir || '.');
  const rel = relative(root, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('work_dir escapes workspace');
  const info = await stat(full).catch(() => null);
  if (!info?.isDirectory()) throw new Error('work_dir is not a directory');
  return { hostPath: full, containerPath: rel === '.' ? '/workspace' : `/workspace/${rel.split(sep).join('/')}` };
}

export function buildExecutionEnv(request: ExecutionRequest): Record<string, string> {
  const env: Record<string, string> = {};
  const keys = ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'USER', 'LOGNAME', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CUDA_VISIBLE_DEVICES', 'NVIDIA_VISIBLE_DEVICES', 'MPLBACKEND'];
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONHASHSEED = String(request.seed);
  env.REPROLENS_SEED = String(request.seed);
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!key.trim() || /[=\0]/.test(key) || value.includes('\0')) continue;
    env[key] = value;
  }
  return env;
}

export interface ProcessOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export function runProcess(binary: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; stdin?: string }): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (code: number, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1, options.timeoutMs));
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(-1, error));
    child.on('close', (code) => {
      if (aborted && !timedOut) {
        finish(code ?? -1);
        return;
      }
      finish(code ?? -1);
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}

export async function writeRunEvidence(request: ExecutionRequest, result: ExecutionResult): Promise<void> {
  if (!request.evidenceDir) throw new Error('evidence directory is empty');
  if (!runIdPattern.test(request.runId)) throw new Error(`invalid run id ${JSON.stringify(request.runId)}`);
  const dir = join(request.evidenceDir, 'runs', request.runId);
  await mkdir(dir, { recursive: true });
  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');
  await writeFile(stdoutPath, result.stdout, 'utf8');
  await writeFile(stderrPath, result.stderr, 'utf8');
  result.stdoutPath = stdoutPath;
  result.stderrPath = stderrPath;
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    run_id: request.runId,
    runner: result.runner,
    command: request.command,
    image: request.image,
    work_dir: request.workDir,
    status: result.status,
    exit_code: result.exitCode,
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    duration_ms: result.durationMs,
    env: result.env,
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    gpu: result.gpu,
    provider: result.provider,
    remote_job_id: result.remoteJobId,
    offer_id: result.offerId,
  }, null, 2), 'utf8');
}
