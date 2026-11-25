import type { AgentReportSummary, Claim, Diagnosis, Event, ExperimentPlan, Paper, Project, RepoSummary, Run } from '../domain/types.js';

export interface Analyzer {
  extractClaims(paper: Paper, repo: RepoSummary): Promise<Claim[]>;
  buildPlan(claim: Claim, paper: Paper, repo: RepoSummary): Promise<ExperimentPlan>;
  diagnose(run: Run, repo: RepoSummary, workspace: string): Promise<Diagnosis>;
  summarizeReport?(project: Project, events: Event[]): Promise<AgentReportSummary>;
}