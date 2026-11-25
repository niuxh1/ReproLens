export const STATES = [
  'CREATED',
  'INITIALIZED',
  'INGESTED',
  'AWAITING_CLAIMS',
  'AWAITING_PLAN',
  'SANDBOX_READY',
  'EXECUTING',
  'AWAITING_PATCH',
  'RETRYING',
  'VERIFYING',
  'REPORTING',
  'COMPLETED',
  'FAILED',
  'STOPPED',
] as const;

export type State = (typeof STATES)[number];

export const ACTIONS = [
  'init',
  'ingest',
  'extract_claims',
  'select_claims',
  'confirm_plan',
  'start_execution',
  'run_succeeded',
  'run_failed',
  'approve_patch',
  'retry_start',
  'reject_patch',
  'next_plan',
  'verification_completed',
  'report_completed',
  'stop',
  'fail',
] as const;

export type Action = (typeof ACTIONS)[number];

const transitions: Partial<Record<State, Partial<Record<Action, State>>>> = {
  CREATED: { init: 'INITIALIZED' },
  INITIALIZED: { ingest: 'INGESTED' },
  INGESTED: { extract_claims: 'AWAITING_CLAIMS' },
  AWAITING_CLAIMS: { select_claims: 'AWAITING_PLAN' },
  AWAITING_PLAN: { confirm_plan: 'SANDBOX_READY' },
  SANDBOX_READY: { start_execution: 'EXECUTING' },
  EXECUTING: { run_succeeded: 'VERIFYING', run_failed: 'AWAITING_PATCH' },
  AWAITING_PATCH: { approve_patch: 'RETRYING', reject_patch: 'FAILED' },
  RETRYING: { retry_start: 'EXECUTING' },
  VERIFYING: { next_plan: 'EXECUTING', verification_completed: 'REPORTING' },
  REPORTING: { report_completed: 'COMPLETED' },
};

export function isTerminal(state: State): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'STOPPED';
}

export function canTransition(from: State, action: Action): State | null {
  if (isTerminal(from)) return null;
  if (action === 'stop') return 'STOPPED';
  if (action === 'fail') return 'FAILED';
  return transitions[from]?.[action] ?? null;
}

export function validateTransition(from: State, action: Action): State {
  const next = canTransition(from, action);
  if (!next) {
    throw new Error(`invalid transition: state ${from} cannot perform action ${action}`);
  }
  return next;
}

export function stateLabel(state: State): string {
  const labels: Record<State, string> = {
    CREATED: 'Created',
    INITIALIZED: 'Workspace initialized',
    INGESTED: 'Paper and repository ingested',
    AWAITING_CLAIMS: 'Awaiting claim selection',
    AWAITING_PLAN: 'Awaiting plan confirmation',
    SANDBOX_READY: 'Sandbox ready',
    EXECUTING: 'Executing experiment',
    AWAITING_PATCH: 'Awaiting patch approval',
    RETRYING: 'Applying approved patch',
    VERIFYING: 'Verifying observed value',
    REPORTING: 'Generating evidence report',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    STOPPED: 'Stopped',
  };
  return labels[state];
}
