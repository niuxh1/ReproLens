export type Timestamp = string;

export interface Tolerance {
  abs: number;
  rel: number;
}

export interface ClaimSource {
  path: string;
  line: number;
  quote?: string;
  page_number?: number;
  table?: string;
  figure?: string;
  provenance?: 'verified' | 'unverified' | 'mismatch';
  provenance_reason?: string;
}

export interface Claim {
  claim_id: string;
  text: string;
  metric: string;
  expected_value: number;
  tolerance: Tolerance;
  source: ClaimSource;
  selected: boolean;
}

export interface PaperPage {
  page_number: number;
  text: string;
  image_path?: string;
  width?: number;
  height?: number;
  caption_candidates: string[];
}

export interface PaperVisual {
  kind: 'page_render' | 'figure' | 'table' | 'embedded_image';
  page_number: number;
  path: string;
  width?: number;
  height?: number;
  caption?: string;
}

export interface Paper {
  title: string;
  text: string;
  source_path: string;
  sha256: string;
  claims: Claim[];
  parsed_at: Timestamp;
  pages?: PaperPage[];
  visuals?: PaperVisual[];
  visual_analysis?: VisualAnalysis[];
}

export interface VisualAnalysis {
  page_number: number;
  summary: string;
  figures: string[];
  tables: string[];
  source: 'model' | 'text' | 'manual';
}

export interface RepoSummary {
  root: string;
  readme?: string;
  files: string[];
  command_candidates: string[];
  requirements?: string[];
  license?: string;
  scanned_at: Timestamp;
}

export interface MetricSource {
  kind: string;
  path?: string;
  pattern?: string;
  key?: string;
}

export type VerificationOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';

export interface VerificationCriterion {
  id: string;
  metric: string;
  operator: VerificationOperator;
  expected?: number;
  lower?: number;
  upper?: number;
  tolerance: Tolerance;
  metric_source: MetricSource;
}

export interface CriterionResult {
  criterion_id: string;
  metric: string;
  operator: VerificationOperator;
  expected?: number;
  lower?: number;
  upper?: number;
  observed?: number;
  verdict: Verdict;
  rule: string;
}
export interface ExperimentPlan {
  id: string;
  claim_id: string;
  command: string;
  image: string;
  work_dir: string;
  seed: number;
  expected_metric: string;
  expected_value: number;
  tolerance: Tolerance;
  metric_source: MetricSource;
  criteria?: VerificationCriterion[];
  aggregation?: 'all' | 'any';
  notes?: string;
  confirmed: boolean;
}

export interface Metric {
  name: string;
  value: number;
  raw?: string;
}

export interface Run {
  run_id: string;
  claim_id?: string;
  plan_id?: string;
  attempt: number;
  runner: string;
  command: string;
  image?: string;
  work_dir: string;
  status: string;
  exit_code: number;
  started_at: Timestamp;
  finished_at: Timestamp;
  duration_ms: number;
  stdout_path?: string;
  stderr_path?: string;
  stdout?: string;
  stderr?: string;
  stdout_sha256?: string;
  stderr_sha256?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  env?: Record<string, string>;
  artifact_paths?: string[];
  metric?: Metric;
  failure_class?: string;
  failure_summary?: string;
  gpu?: boolean;
  requested_seed?: number;
  effective_seed?: number;
  seed_source?: 'command' | 'stdout' | 'environment';
  gpu_detected?: boolean;
  gpu_device?: string;
  provider?: string;
  remote_job_id?: string;
}

export interface Diagnosis {
  failure_class: string;
  root_cause: string;
  confidence: string;
  patch_diff?: string;
  explanation?: string;
  needs_code_agent?: boolean;
}

export interface PatchProposal {
  patch_id: string;
  run_id: string;
  claim_id: string;
  diagnosis: Diagnosis;
  diff: string;
  files: string[];
  status: string;
  created_at: Timestamp;
  applied_at?: Timestamp;
  approved_by?: string;
  code_agent?: string;
  code_agent_version?: string;
  code_agent_log_path?: string;
  code_agent_summary?: string;
}

export type Verdict = 'PASS' | 'DIFFERENT' | 'INSUFFICIENT_EVIDENCE' | 'FAILED';

export interface Verification {
  verification_id: string;
  claim_id: string;
  metric: string;
  expected: number;
  observed: number;
  tolerance: Tolerance;
  verdict: Verdict;
  rule: string;
  evidence?: string[];
  criteria_results?: CriterionResult[];
  rule_version?: number;
  note?: string;
  verified_at: Timestamp;
}

export type ReproducibilityGrade = 'A' | 'B' | 'C' | 'D';

export interface ReproducibilityFactor {
  id: string;
  label: string;
  score: number;
  max: number;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface ReproducibilityAssessment {
  score: number;
  grade: ReproducibilityGrade;
  verdict?: Verdict;
  factors: ReproducibilityFactor[];
  caps: string[];
  generated_at: Timestamp;
  policy_version: number;
}

export interface EvidenceRef {
  kind: string;
  path: string;
  sha256?: string;
  size?: number;
}

export interface AgentReportSummary {
  markdown: string;
  model: string;
  generated_at: Timestamp;
  source: 'model' | 'heuristic';
  verdict?: Verdict;
}

export interface Report {
  report_id: string;
  generated_at: Timestamp;
  summary: string;
  markdown: string;
  agent_summary?: AgentReportSummary;
  assessment?: ReproducibilityAssessment;
  aggregate_verdict?: Verdict;
  aggregate_rule?: string;
  verifications?: Verification[];
  package_path?: string;
  evidence?: EvidenceRef[];
}

export interface Budget {
  max_runs: number;
  max_seconds: number;
  max_patches: number;
}

export function budgetWithDefaults(budget: Partial<Budget> | undefined): Budget {
  return {
    max_runs: budget?.max_runs && budget.max_runs > 0 ? budget.max_runs : 3,
    max_seconds: budget?.max_seconds && budget.max_seconds > 0 ? budget.max_seconds : 120,
    max_patches: budget?.max_patches && budget.max_patches > 0 ? budget.max_patches : 2,
  };
}

export type OperationKind =
  | 'start'
  | 'select_claims'
  | 'confirm_plan'
  | 'approve_patch'
  | 'reject_patch'
  | 'stop'
  | 'regenerate_report';

export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'abandoned';

export interface Operation {
  id: string;
  project_id: string;
  kind: OperationKind;
  status: OperationStatus;
  idempotency_key?: string;
  request_hash?: string;
  lease_owner?: string;
  lease_expires_at?: Timestamp;
  heartbeat_at?: Timestamp;
  result_revision?: number;
  error?: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  finished_at?: Timestamp;
}
export interface Project {
  id: string;
  revision?: number;
  name: string;
  state: import('./state.js').State;
  paper_path: string;
  repo_path: string;
  data_path?: string;
  workspace_path: string;
  evidence_dir: string;
  budget: Budget;
  paper: Paper;
  repo: RepoSummary;
  claims?: Claim[];
  selected_claim_ids?: string[];
  plans?: ExperimentPlan[];
  runs?: Run[];
  patch?: PatchProposal;
  verification?: Verification;
  verifications?: Verification[];
  current_plan_index?: number;
  patch_attempts?: number;
  report?: Report;
  stop_requested?: boolean;
  error?: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Event {
  id: number;
  project_id: string;
  seq: number;
  type: string;
  message: string;
  data?: Record<string, unknown>;
  created_at: Timestamp;
}
