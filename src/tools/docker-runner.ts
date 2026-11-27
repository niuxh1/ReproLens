import { buildExecutionEnv, resolveWorkDir, runProcess, validateExecutionCommand, writeRunEvidence, type ExecutionRequest, type ExecutionResult, type Runner } from './runner.js';

export interface DockerRunnerOptions {
  dockerBinary?: string;
  network?: string;
  memory?: string;
  cpus?: string;
  pids?: number;
  enableGPU?: boolean;
}

export class DockerRunner implements Runner {
  private readonly dockerBinary: string;
  private readonly network: string;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pids: number;
  readonly enableGPU: boolean;

  constructor(options: DockerRunnerOptions = {}) {
    this.dockerBinary = options.dockerBinary ?? 'docker';
    this.network = options.network ?? 'none';
    this.memory = options.memory ?? '2g';
    this.cpus = options.cpus ?? '2';
    this.pids = options.pids && options.pids > 0 ? options.pids : 256;
    this.enableGPU = options.enableGPU ?? false;
  }

  name(): string { return 'docker (isolated)'; }

  buildArgs(request: ExecutionRequest, containerWorkDir = '/workspace'): string[] {
    const args = validateExecutionCommand(request.command);
    const image = request.image || 'python:3.11-slim';
    return [
      'run', '--rm', '--network', this.network, '--memory', this.memory, '--cpus', this.cpus,
      '--pids-limit', String(this.pids), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '-v', `${request.workspace}:/workspace`, '-w', containerWorkDir, '--init',
      '-e', `REPROLENS_SEED=${request.seed}`, '-e', `PYTHONHASHSEED=${request.seed}`, '-e', 'PYTHONUNBUFFERED=1',
      ...(this.enableGPU ? ['--gpus', 'all', '-e', 'NVIDIA_VISIBLE_DEVICES=all', '-e', 'CUDA_VISIBLE_DEVICES=0'] : []),
      ...Object.entries(request.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      image,
      ...args,
    ];
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const { containerPath } = await resolveWorkDir(request.workspace, request.workDir);
    const args = this.buildArgs(request, containerPath);
    const env = buildExecutionEnv(request);
    const outcome = await runProcess(this.dockerBinary, args, {
      cwd: request.workspace,
      env: { ...process.env, ...env },
      timeoutMs: request.timeoutMs > 0 ? request.timeoutMs : 120_000,
      signal: request.signal,
      onOutput: request.onOutput,
    });
    const result: ExecutionResult = {
      runner: this.name(),
      status: outcome.timedOut ? 'timeout' : outcome.code === 0 ? 'succeeded' : 'failed',
      command: request.command,
      image: request.image || 'python:3.11-slim',
      workDir: request.workDir,
      exitCode: outcome.timedOut ? -1 : outcome.code,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      env,
      gpu: this.enableGPU,
    };
    await writeRunEvidence(request, result);
    return result;
  }
}
