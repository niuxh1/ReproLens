export type Timestamp = string;

export interface Tolerance {
  abs: number;
  rel: number;
}

export interface ClaimSource {
  path: string;
  line: number;
  quote?: string;
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
  env?: Record<string, string>;
  artifact_paths?: string[];
  metric?: Metric;
  failure_class?: string;
  failure_summary?: string;
  gpu?: boolean;
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
  note?: string;
  verified_at: Timestamp;
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

export interface Project {
  id: string;
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
