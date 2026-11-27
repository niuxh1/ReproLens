import { describe, expect, it } from 'vitest';
import { extractRunMetadata } from '../src/tools/run-metadata.js';

describe('run metadata', () => {
  it('records effective seed and CUDA device from actual output', () => {
    const metadata = extractRunMetadata('python train.py --seed 0', 'device=cuda\ngpu=NVIDIA GeForce RTX 4060 Laptop GPU\nseed=0\n', 42);
    expect(metadata.requested_seed).toBe(42);
    expect(metadata.effective_seed).toBe(0);
    expect(metadata.seed_source).toBe('command');
    expect(metadata.gpu_detected).toBe(true);
    expect(metadata.gpu_device).toContain('RTX 4060');
  });

  it('falls back to the requested seed when no actual seed is present', () => {
    const metadata = extractRunMetadata('python train.py', 'accuracy=0.9\n', 42);
    expect(metadata.effective_seed).toBe(42);
    expect(metadata.seed_source).toBe('environment');
    expect(metadata.gpu_detected).toBe(false);
  });
});