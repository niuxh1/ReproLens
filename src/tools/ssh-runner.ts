import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createWorkspaceArchive } from './archive.js';
import { buildExecutionEnv, runProcess, validateExecutionCommand, writeRunEvidence, type ExecutionRequest, type ExecutionResult, type Runner } from './runner.js';

export interface SSHConfig {
  host: string;
  port?: number;
  identity?: string;
  baseDir?: string;
  sshBinary?: string;
  scpBinary?: string;
  enableGPU?: boolean;
}

export class SSHRunner implements Runner {
  private readonly host: string;
  private readonly port: number;
  private readonly identity: string;
  private readonly baseDir: string;
  private readonly sshBinary: string;
  private readonly scpBinary: string;
  readonly enableGPU: boolean;

  constructor(config: SSHConfig) {
    this.host = config.host;
    this.port = config.port ?? 22;
    this.identity = config.identity ?? '';
    this.baseDir = config.baseDir ?? '/tmp/reprolens';
    this.sshBinary = config.sshBinary ?? 'ssh';
    this.scpBinary = config.scpBinary ?? 'scp';
    this.enableGPU = config.enableGPU ?? false;
  }

  name(): string { return 'ssh (remote host)'; }

  buildSSHArgs(remoteCommand: string): string[] {
    const args = ['-p', String(this.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10'];
    if (this.identity) args.push('-i', this.identity);
    return [...args, this.host, remoteCommand];
  }

  buildSCPArgs(source: string, destination: string): string[] {
    const args = ['-O', '-P', String(this.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10'];
    if (this.identity) args.push('-i', this.identity);
    return [...args, source, `${this.host}:${destination}`];
  }

  buildRunScript(request: ExecutionRequest, remoteDir: string): string {
    const lines = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'export PATH="$PATH:/usr/lib/wsl/lib"',
      `cd ${shellQuote(remoteDir)}`,
      `tar -xzf ${shellQuote(posix.join(remoteDir, 'workspace.tar.gz'))}`,
      `rm -f ${shellQuote(posix.join(remoteDir, 'workspace.tar.gz'))}`,
      `export REPROLENS_SEED=${request.seed}`,
      `export PYTHONHASHSEED=${request.seed}`,
      'export PYTHONUNBUFFERED=1',
      'export PYTHONIOENCODING=utf-8',
      'export MPLBACKEND=Agg',
    ];
    if (this.enableGPU) {
      lines.push('export CUDA_VISIBLE_DEVICES=0', 'export NVIDIA_VISIBLE_DEVICES=all');
    }
    for (const key of Object.keys(request.env ?? {}).sort()) {
      if (!key || /[=;\n]/.test(key)) continue;
      lines.push(`export ${key}=${shellQuote(request.env![key]!)}`);
    }
    lines.push(request.command);
    return `${lines.join('\n')}\n`;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!this.host || /[\s]/.test(this.host)) throw new Error('invalid SSH host');
    if (!/^[A-Za-z0-9_-]+$/.test(request.projectId) || !/^[A-Za-z0-9_-]+$/.test(request.runId)) throw new Error('invalid project or run id');
    validateExecutionCommand(request.command);
    if (!this.baseDir.startsWith('/')) throw new Error('SSH base dir must be an absolute POSIX path');
    const remoteDir = posix.join(this.baseDir, 'reprolens', request.projectId, request.runId);
    const remoteEvidence = join(request.evidenceDir, 'remote', request.runId);
    await mkdir(remoteEvidence, { recursive: true });
    const archivePath = join(remoteEvidence, 'workspace.tar.gz');
    await createWorkspaceArchive(request.workspace, archivePath);
    const script = this.buildRunScript(request, remoteDir);
    const scriptPath = join(remoteEvidence, 'run.sh');
    await writeFile(scriptPath, script, 'utf8');
    const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : 10 * 60_000;
    await this.infrastructure(this.sshBinary, this.buildSSHArgs(`mkdir -p ${shellQuote(remoteDir)}`), timeoutMs);
    await this.infrastructure(this.scpBinary, this.buildSCPArgs(archivePath, posix.join(remoteDir, 'workspace.tar.gz')), timeoutMs);
    await this.infrastructure(this.scpBinary, this.buildSCPArgs(scriptPath, posix.join(remoteDir, 'run.sh')), timeoutMs);
    const outcome = await runProcess(this.sshBinary, this.buildSSHArgs(`bash ${shellQuote(posix.join(remoteDir, 'run.sh'))}`), {
      timeoutMs,
      signal: request.signal,
      env: process.env,
    });
    const result: ExecutionResult = {
      runner: this.name(),
      status: outcome.timedOut ? 'timeout' : outcome.code === 0 ? 'succeeded' : 'failed',
      command: request.command,
      workDir: request.workDir,
      exitCode: outcome.timedOut ? -1 : outcome.code,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      env: buildExecutionEnv(request),
      gpu: this.enableGPU,
      provider: 'ssh',
      remoteJobId: request.runId,
    };
    await writeRunEvidence(request, result);
    return result;
  }

  private async infrastructure(binary: string, args: string[], timeoutMs: number): Promise<void> {
    const outcome = await runProcess(binary, args, { timeoutMs, env: process.env });
    if (outcome.code !== 0) throw new Error(`${binary} failed: ${outcome.stderr || outcome.stdout}`);
  }
}

function shellQuote(value: string): string {
  const escaped = value.replace(/'/g, "'\"'\"'");
  return `'${escaped}'`;
}
