import type { Claim, Diagnosis, ExperimentPlan, Paper, Run } from '../domain/types.js';

export interface CodeAgentTask {
  projectId: string;
  claimId: string;
  workspace: string;
  evidenceDir: string;
  acceptanceCommand: string;
  paper: Paper;
  claim: Claim;
  plan: ExperimentPlan;
  run: Run;
  diagnosis: Diagnosis;
}

export interface CodeAgentResult {
  agent: string;
  version: string;
  diff: string;
  files: string[];
  summary: string;
  stdout: string;
  stderr: string;
  logPath: string;
  durationMs: number;
}

export interface CodeAgent {
  name(): string;
  propose(task: CodeAgentTask): Promise<CodeAgentResult>;
}
