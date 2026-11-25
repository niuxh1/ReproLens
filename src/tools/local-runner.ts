import { buildExecutionEnv, resolveWorkDir, runProcess, validateExecutionCommand, writeRunEvidence, type ExecutionRequest, type ExecutionResult, type Runner } from './runner.js';

export class LocalRunner implements Runner {
  constructor(private readonly enableGPU = false) {}

  name(): string { return 'local (unsafe)'; }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const args = validateExecutionCommand(request.command);
    const { hostPath } = await resolveWorkDir(request.workspace, request.workDir);
    const env = buildExecutionEnv(request);
    if (this.enableGPU) {
      env.CUDA_VISIBLE_DEVICES = '0';
      env.NVIDIA_VISIBLE_DEVICES = 'all';
    }
    const outcome = await runProcess(args[0]!, args.slice(1), {
      cwd: hostPath,
      env: { ...process.env, ...env },
      timeoutMs: request.timeoutMs > 0 ? request.timeoutMs : 120_000,
      signal: request.signal,
      onOutput: request.onOutput,
    });
    const result: ExecutionResult = {
      runner: this.name(),
      status: outcome.timedOut ? 'timeout' : outcome.code === 0 ? 'succeeded' : 'failed',
      command: request.command,
      ...(request.image ? { image: request.image } : {}),
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
