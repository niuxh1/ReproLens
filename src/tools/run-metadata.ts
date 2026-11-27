export interface RunMetadata {
  requested_seed: number;
  effective_seed: number;
  seed_source: 'command' | 'stdout' | 'environment';
  gpu_detected: boolean;
  gpu_device?: string;
}

export function extractRunMetadata(command: string, stdout: string, requestedSeed: number): RunMetadata {
  const commandSeed = /--seed(?:=|\s+)(\d+)/i.exec(command);
  const stdoutSeed = /\bseed\s*[:=]\s*(\d+)/i.exec(stdout);
  const effectiveSeed = commandSeed ? Number(commandSeed[1]) : stdoutSeed ? Number(stdoutSeed[1]) : requestedSeed;
  const seedSource = commandSeed ? 'command' : stdoutSeed ? 'stdout' : 'environment';
  const gpuDevice = /\bgpu\s*[:=]\s*([^\r\n]+)/i.exec(stdout)?.[1]?.trim()
    || /(NVIDIA[^\r\n]+)/i.exec(stdout)?.[1]?.trim();
  const cudaDetected = /\bdevice\s*[:=]\s*cuda\b/i.test(stdout)
    || /torch\.cuda\.is_available\(\)\s*[:=]\s*true/i.test(stdout)
    || /\bcuda\s+available\s*[:=]\s*true/i.test(stdout);
  return {
    requested_seed: requestedSeed,
    effective_seed: Number.isFinite(effectiveSeed) ? effectiveSeed : requestedSeed,
    seed_source: seedSource,
    gpu_detected: Boolean(gpuDevice || cudaDetected),
    ...(gpuDevice ? { gpu_device: gpuDevice } : {}),
  };
}