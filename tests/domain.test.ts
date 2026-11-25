import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isTerminal,
  validateTransition,
  type Action,
  type State,
} from '../src/domain/state.js';
import { budgetWithDefaults } from '../src/domain/types.js';

describe('domain state machine', () => {
  it('moves an approved patch into retry then execution', () => {
    expect(canTransition('AWAITING_PATCH', 'approve_patch')).toBe('RETRYING');
    expect(canTransition('RETRYING', 'retry_start')).toBe('EXECUTING');
  });

  it('rejects transitions from terminal states', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(canTransition('COMPLETED', 'stop')).toBeNull();
    expect(() => validateTransition('COMPLETED' as State, 'stop' as Action)).toThrow();
  });

  it('supports the failure, stop, and verification paths', () => {
    expect(canTransition('EXECUTING', 'run_failed')).toBe('AWAITING_PATCH');
    expect(canTransition('AWAITING_PATCH', 'reject_patch')).toBe('FAILED');
    expect(canTransition('EXECUTING', 'stop')).toBe('STOPPED');
    expect(canTransition('VERIFYING', 'verification_completed')).toBe('REPORTING');
    expect(canTransition('REPORTING', 'report_completed')).toBe('COMPLETED');
  });

  it('fills budget defaults without mutating the input', () => {
    const input = { max_runs: 0, max_seconds: 0, max_patches: 0 };
    expect(budgetWithDefaults(input)).toEqual({ max_runs: 3, max_seconds: 120, max_patches: 2 });
    expect(input).toEqual({ max_runs: 0, max_seconds: 0, max_patches: 0 });
  });
});
