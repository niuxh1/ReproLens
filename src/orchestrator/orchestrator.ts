import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Analyzer } from '../agent/analyzer.js';
import { HeuristicAnalyzer } from '../agent/heuristic.js';
import type { AgentReportSummary } from '../domain/types.js';
import type { CodeAgent, CodeAgentResult } from '../codeagent/code-agent.js';
import type { Budget, Claim, Diagnosis, Event, ExperimentPlan, Operation, OperationKind, Paper, Project, RepoSummary, Run } from '../domain/types.js';
import { canTransition, isTerminal, validateTransition, type Action } from '../domain/state.js';
import { budgetWithDefaults } from '../domain/types.js';
import type { Store } from '../store/store.js';
import { StoreBusyError, StoreDuplicateError, StoreNotFoundError } from '../store/store.js';
import { PatchManager } from '../tools/patch.js';
import { parsePaper } from '../tools/paper.js';
import { scanRepo } from '../tools/repo.js';
import { Workspace } from '../tools/workspace.js';
import { verifyRun } from '../tools/verify.js';
import { extractRunMetadata } from '../tools/run-metadata.js';
import { annotateClaimProvenance } from '../tools/provenance.js';
import { buildReport, exportPackage } from '../tools/report.js';
import type { Runner, ExecutionResult } from '../tools/runner.js';

export class ProjectBusyError extends Error {
  constructor() { super('project already has a running job'); this.name = 'ProjectBusyError'; }
}

export class InvalidStateError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidStateError'; }
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'idempotency key was reused with a different request') { super(message); this.name = 'IdempotencyConflictError'; }
}
export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

export interface OperationAcceptance {
  operation: Operation;
  project: Project;
  replayed: boolean;
}
export interface CreateProjectInput {
  name?: string;
  paperPath: string;
  repoPath: string;
  dataPath?: string;
  budget?: Partial<Budget>;
}

interface JobHandle {
  controller: AbortController;
  done: () => void;
}

export class Orchestrator {
  private readonly jobs = new Map<string, JobHandle>();
  private readonly operationOwner = `orch_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  private codeAgent: CodeAgent | null = null;

  constructor(
    private readonly store: Store,
    private analyzer: Analyzer,
    private runner: Runner,
    private readonly dataDir: string,
  ) {}

  setCodeAgent(agent: CodeAgent | null): void { this.codeAgent = agent; }

  setAnalyzer(analyzer: Analyzer): void { this.analyzer = analyzer; }

  setRunner(runner: Runner): void { this.runner = runner; }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const paperPath = await existingPath(input.paperPath, 'file', 'paper path');
    const repoPath = await existingPath(input.repoPath, 'directory', 'repository path');
    const dataPath = input.dataPath?.trim() ? await existingPath(input.dataPath, 'path', 'data path') : '';
    const id = newId('proj');
    const workspace = await Workspace.create(this.dataDir, id);
    const now = new Date().toISOString();
    const project: Project = {
      id,
      revision: 1,
      name: input.name?.trim() || basename(repoPath),
      state: 'CREATED',
      paper_path: paperPath,
      repo_path: repoPath,
      ...(dataPath ? { data_path: dataPath } : {}),
      workspace_path: workspace.root,
      evidence_dir: workspace.evidenceDir,
      budget: budgetWithDefaults(input.budget),
      paper: emptyPaper(),
      repo: emptyRepo(),
      created_at: now,
      updated_at: now,
    };
    await this.store.createProject(project);
    await this.appendEvent(project.id, 'project_created', 'project created', { paper: paperPath, repo: repoPath });
    return project;
  }

  async start(projectId: string, idempotencyKey?: string, requestHash?: string): Promise<Project> {
    return this.runOperation(projectId, 'start', idempotencyKey, () => this.startInternal(projectId), requestHash);
  }

  private async startInternal(projectId: string): Promise<Project> {
    const job = this.beginJob(projectId);
    try {
      let project = await this.getProject(projectId);
      if (project.state !== 'CREATED') throw new InvalidStateError(`start requires CREATED state, got ${project.state}`);
      await this.transition(project, 'init', 'initializing isolated workspace');
      const workspace = await Workspace.create(this.dataDir, project.id);
      await workspace.copyRepo(project.repo_path);
      await this.appendEvent(project.id, 'repository_copied', 'repository copied into isolated workspace', { workspace: workspace.root });
      if (project.data_path) {
        const dataInfo = await stat(project.data_path);
        const dataTarget = resolve(workspace.root, 'inputs', 'data');
        if (dataInfo.isDirectory()) await cp(project.data_path, dataTarget, { recursive: true });
        else {
          await mkdir(dataTarget, { recursive: true });
          await cp(project.data_path, resolve(dataTarget, basename(project.data_path)));
        }
        await this.appendEvent(project.id, 'data_staged', 'dataset staged into isolated workspace', {
          source: project.data_path, target: dataTarget, kind: dataInfo.isDirectory() ? 'directory' : 'file',
        });
      }
      const paper = await parsePaper(project.paper_path, { visualDir: resolve(project.evidence_dir, 'paper') });
      const repo = await scanRepo(workspace.root);
      project.paper = paper;
      project.repo = repo;
      await this.save(project);
      await this.transition(project, 'ingest', 'paper and repository ingested');
      const claims = annotateClaimProvenance(await this.analyzer.extractClaims(paper, repo), paper);
      project.claims = claims.map((claim) => ({ ...claim, selected: false }));
      await this.transition(project, 'extract_claims', 'candidate claims extracted');
      await this.save(project);
      const provenance = claims.reduce((counts, claim) => {
        const status = claim.source.provenance ?? 'unverified';
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {} as Record<string, number>);
      await this.appendEvent(project.id, 'claims_extracted', `${claims.length} measurable claims found`, { count: claims.length, provenance });
      await this.appendEvent(project.id, 'claim_provenance_checked', 'claim quotes checked against extracted paper pages', provenance);
      return project;
    } catch (error) {
      return this.handleFailure(projectId, error);
    } finally {
      job.done();
    }
  }


  async updateClaim(projectId: string, claimId: string, patch: { text?: string; metric?: string; expected_value?: number; tolerance_abs?: number }): Promise<Project> {
    const job = this.beginJob(projectId);
    try {
      const project = await this.getProject(projectId);
      if (project.state !== 'AWAITING_CLAIMS') throw new InvalidStateError(`claim editing requires AWAITING_CLAIMS state, got ${project.state}`);
      const claim = project.claims?.find((item) => item.claim_id.toUpperCase() === claimId.toUpperCase());
      if (!claim) throw new ValidationError(`claim not found: ${claimId}`);
      if (patch.text !== undefined) claim.text = patch.text.trim();
      if (patch.metric !== undefined) claim.metric = patch.metric.trim().toLowerCase();
      if (patch.expected_value !== undefined) {
        if (!Number.isFinite(patch.expected_value)) throw new ValidationError('expected_value must be finite');
        claim.expected_value = patch.expected_value;
      }
      if (patch.tolerance_abs !== undefined) {
        if (!Number.isFinite(patch.tolerance_abs) || patch.tolerance_abs < 0) throw new ValidationError('tolerance must be non-negative');
        claim.tolerance = { ...claim.tolerance, abs: patch.tolerance_abs };
      }
      await this.save(project);
      await this.appendEvent(project.id, 'claim_updated', `researcher confirmed claim ${claim.claim_id}`, {
        claim_id: claim.claim_id, expected_value: claim.expected_value, tolerance_abs: claim.tolerance.abs, metric: claim.metric,
      });
      return project;
    } finally {
      job.done();
    }
  }
  async selectClaims(projectId: string, claimIds: string[], idempotencyKey?: string, requestHash?: string): Promise<Project> {
    return this.runOperation(projectId, 'select_claims', idempotencyKey, () => this.selectClaimsInternal(projectId, claimIds), requestHash);
  }

  private async selectClaimsInternal(projectId: string, claimIds: string[]): Promise<Project> {
    const job = this.beginJob(projectId);
    try {
      const project = await this.getProject(projectId);
      if (project.state !== 'AWAITING_CLAIMS') throw new InvalidStateError(`claim selection requires AWAITING_CLAIMS state, got ${project.state}`);
      if (claimIds.length === 0) throw new ValidationError('select at least one claim');
      const wanted = new Set(claimIds.map((id) => id.trim().toUpperCase()));
      const mismatched = (project.claims ?? []).filter((claim) => wanted.has(claim.claim_id.toUpperCase()) && claim.source.provenance === 'mismatch');
      if (mismatched.length) throw new ValidationError(`claim provenance verification failed: ${mismatched.map((claim) => `${claim.claim_id} (${claim.source.provenance_reason ?? 'quote mismatch'})`).join('; ')}`);
      const selected: string[] = [];
      for (const claim of project.claims ?? []) {
        claim.selected = wanted.has(claim.claim_id.toUpperCase());
        if (claim.selected) selected.push(claim.claim_id);
      }
      if (selected.length === 0) throw new ValidationError('selected claim ids do not match any extracted claim');
      project.selected_claim_ids = selected;
      await this.transition(project, 'select_claims', 'claims selected; building experiment plans');
      const selectedSet = new Set(selected);
      project.plans = [];
      for (const claim of project.claims ?? []) {
        if (!selectedSet.has(claim.claim_id)) continue;
        const plan = await this.analyzer.buildPlan(claim, project.paper, project.repo);
        project.plans.push({ ...plan, id: plan.id || `plan_${claim.claim_id.toLowerCase()}`, claim_id: claim.claim_id, confirmed: false });
      }
      project.current_plan_index = 0;
      await this.save(project);
      await this.appendEvent(project.id, 'plans_ready', `${project.plans.length} experiment plan(s) generated`, { plans: project.plans.length });
      return project;
    } catch (error) {
      return this.handleFailure(projectId, error);
    } finally {
      job.done();
    }
  }

  async preflight(projectId: string, action: 'confirm_plan' | 'approve_patch'): Promise<void> {
    const project = await this.getProject(projectId);
    if (this.jobs.has(projectId)) throw new ProjectBusyError();
    if (action === 'confirm_plan' && project.state !== 'AWAITING_PLAN') {
      throw new InvalidStateError(`plan confirmation requires AWAITING_PLAN state, got ${project.state}`);
    }
    if (action === 'approve_patch') {
      if (project.state !== 'AWAITING_PATCH') throw new InvalidStateError(`patch approval requires AWAITING_PATCH state, got ${project.state}`);
      if (!project.patch || project.patch.status !== 'proposed') throw new ValidationError('no proposed patch is available');
    }
  }

  async acceptConfirmPlan(projectId: string, idempotencyKey?: string, requestHash?: string): Promise<OperationAcceptance> {
    const existing = idempotencyKey ? await this.operationByKey(idempotencyKey) : null;
    if (!existing) await this.preflight(projectId, 'confirm_plan');
    return this.acceptOperation(projectId, 'confirm_plan', idempotencyKey, () => this.confirmPlanInternal(projectId), requestHash);
  }
  async confirmPlan(projectId: string, idempotencyKey?: string, requestHash?: string): Promise<Project> {
    return this.runOperation(projectId, 'confirm_plan', idempotencyKey, () => this.confirmPlanInternal(projectId), requestHash);
  }

  private async confirmPlanInternal(projectId: string): Promise<Project> {
    const job = this.beginJob(projectId);
    try {
      const project = await this.getProject(projectId);
      if (project.state !== 'AWAITING_PLAN') throw new InvalidStateError(`plan confirmation requires AWAITING_PLAN state, got ${project.state}`);
      if (!project.plans?.length) throw new ValidationError('no experiment plans to confirm');
      for (const plan of project.plans) plan.confirmed = true;
      project.current_plan_index = 0;
      await this.transition(project, 'confirm_plan', 'experiment plan confirmed by user');
      if (!(await stat(project.workspace_path).catch(() => null))?.isDirectory()) throw new Error('workspace unavailable');
      await this.appendEvent(project.id, 'sandbox_ready', 'execution workspace prepared', { runner: this.runner.name() });
      await this.transition(project, 'start_execution', 'starting controlled execution');
      return await this.executePlans(project, job.controller.signal);
    } catch (error) {
      return this.handleFailure(projectId, error);
    } finally {
      job.done();
    }
  }

  async acceptApprovePatch(projectId: string, approvedBy = 'local-user', idempotencyKey?: string, requestHash?: string): Promise<OperationAcceptance> {
    const existing = idempotencyKey ? await this.operationByKey(idempotencyKey) : null;
    if (!existing) await this.preflight(projectId, 'approve_patch');
    return this.acceptOperation(projectId, 'approve_patch', idempotencyKey, () => this.approvePatchInternal(projectId, approvedBy), requestHash);
  }
  async approvePatch(projectId: string, approvedBy = 'local-user', idempotencyKey?: string, requestHash?: string): Promise<Project> {
    return this.runOperation(projectId, 'approve_patch', idempotencyKey, () => this.approvePatchInternal(projectId, approvedBy), requestHash);
  }

  private async approvePatchInternal(projectId: string, approvedBy: string): Promise<Project> {
    const job = this.beginJob(projectId);
    try {
      const project = await this.getProject(projectId);
      if (project.state !== 'AWAITING_PATCH') throw new InvalidStateError(`patch approval requires AWAITING_PATCH state, got ${project.state}`);
      if (!project.patch || project.patch.status !== 'proposed') throw new ValidationError('no proposed patch is available');
      project.patch.approved_by = approvedBy.trim() || 'local-user';
      project.patch.status = 'approved';
      await this.save(project);
      await this.appendEvent(project.id, 'patch_approved', 'human approved patch application', {
        patch_id: project.patch.patch_id, claim_id: project.patch.claim_id, approved_by: project.patch.approved_by,
        diff_sha256: hashString(project.patch.diff),
      });
      await this.transition(project, 'approve_patch', 'applying approved patch');
      if (job.controller.signal.aborted) return this.stopProject(projectId);
      const manager = new PatchManager(project.workspace_path);
      const files = await manager.apply(project.patch.diff);
      project.patch.status = 'applied';
      project.patch.applied_at = new Date().toISOString();
      project.patch.files = files;
      await this.save(project);
      await this.appendEvent(project.id, 'patch_applied', 'approved patch applied', { patch_id: project.patch.patch_id, files });
      await this.transition(project, 'retry_start', 'retrying experiment after approved patch');
      return await this.executePlans(project, job.controller.signal);
    } catch (error) {
      return this.handleFailure(projectId, error);
    } finally {
      job.done();
    }
  }

  async rejectPatch(projectId: string, reason = 'patch rejected by user', idempotencyKey?: string, requestHash?: string): Promise<Project> {
    return this.runOperation(projectId, 'reject_patch', idempotencyKey, () => this.rejectPatchInternal(projectId, reason), requestHash);
  }

  private async rejectPatchInternal(projectId: string, reason: string): Promise<Project> {
    const job = this.beginJob(projectId);
    try {
      const project = await this.getProject(projectId);
      if (project.state !== 'AWAITING_PATCH') throw new InvalidStateError(`patch rejection requires AWAITING_PATCH state, got ${project.state}`);
      if (!project.patch) throw new ValidationError('no patch proposal is available');
      project.patch.status = 'rejected';
      project.error = reason;
      await this.save(project);
      await this.appendEvent(project.id, 'patch_rejected', reason, { patch_id: project.patch.patch_id });
      await this.transition(project, 'reject_patch', 'patch rejected; run stopped');
      return project;
    } catch (error) {
      return this.handleFailure(projectId, error);
    } finally {
      job.done();
    }
  }

  async stop(projectId: string, idempotencyKey?: string, requestHash?: string): Promise<Project> {
    return this.runOperation(projectId, 'stop', idempotencyKey, () => this.stopInternal(projectId), requestHash);
  }

  private async stopInternal(projectId: string): Promise<Project> {
    let project = await this.getProject(projectId);
    if (isTerminal(project.state)) return project;
    project.stop_requested = true;
    await this.save(project);
    await this.appendEvent(project.id, 'stop_requested', 'stop requested by user');
    const job = this.jobs.get(projectId);
    if (job) {
      job.controller.abort();
      return project;
    }
    return this.stopProject(projectId);
  }

  async getProject(projectId: string): Promise<Project> {
    return this.store.getProject(projectId);
  }

  async listProjects(): Promise<Project[]> { return this.store.listProjects(); }

  async operations(projectId?: string): Promise<Operation[]> { return this.store.listOperations(projectId); }

  async operationByKey(key: string): Promise<Operation | null> { return this.store.findOperationByIdempotencyKey(key.trim()); }

  async recoverInterruptedProjects(): Promise<Project[]> {
    await this.store.abandonExpiredOperations(new Date().toISOString(), 'operation lease expired during server recovery');
    const active = new Set(['EXECUTING', 'RETRYING', 'VERIFYING', 'REPORTING']);
    const recovered: Project[] = [];
    for (const project of await this.store.listProjects()) {
      if (!active.has(project.state)) continue;
      const previous = project.state;
      project.error = `workflow interrupted while ${previous.toLowerCase()} (server restarted)`;
      const next = canTransition(project.state, 'fail');
      if (next) project.state = next;
      project.updated_at = new Date().toISOString();
      await this.store.saveProject(project);
      await this.appendEvent(project.id, 'workflow_interrupted', project.error, { from: previous, to: project.state });
      recovered.push(project);
    }
    return recovered;
  }

  async readiness(): Promise<{ status: 'ready' | 'not_ready'; database: 'ok' | 'error'; data_dir: 'ok' | 'error'; error?: string }> {
    let database: 'ok' | 'error' = 'ok';
    let dataDir: 'ok' | 'error' = 'ok';
    let error: string | undefined;
    try {
      await this.store.listProjects();
    } catch (cause) {
      database = 'error';
      error = (cause as Error).message;
    }
    try {
      await access(this.dataDir, constants.W_OK);
    } catch (cause) {
      dataDir = 'error';
      error = error ?? (cause as Error).message;
    }
    return {
      status: database === 'ok' && dataDir === 'ok' ? 'ready' : 'not_ready',
      database,
      data_dir: dataDir,
      ...(error ? { error } : {}),
    };
  }

  async events(projectId: string, after = 0, limit = 10_000): Promise<Event[]> {
    return this.store.listEvents(projectId, after, limit);
  }

  async allEvents(projectId: string, pageSize = 1000): Promise<Event[]> {
    const all: Event[] = [];
    let after = 0;
    const size = Math.max(1, Math.min(10_000, Math.trunc(pageSize)));
    while (true) {
      const page = await this.store.listEvents(projectId, after, size);
      all.push(...page);
      if (page.length < size) return all;
      after = page[page.length - 1]!.seq;
    }
  }

  async regenerateReportSummary(projectId: string, idempotencyKey?: string, requestHash?: string): Promise<Project> {
    return this.runOperation(projectId, 'regenerate_report', idempotencyKey, () => this.regenerateReportSummaryInternal(projectId), requestHash);
  }

  private async regenerateReportSummaryInternal(projectId: string): Promise<Project> {
    const job = this.beginJob(projectId);
    try {
      const project = await this.getProject(projectId);
      if (!project.report) throw new ValidationError('report is not ready');
      const events = await this.allEvents(project.id);
      await this.appendEvent(project.id, 'report_summary_started', 'main agent is summarizing the evidence report');
      const agentSummary = await this.generateAgentSummary(project, events);
      const report = await buildReport(project, events, agentSummary);
      report.package_path = await exportPackage(project, report, events);
      project.report = report;
      await this.save(project);
      await this.appendEvent(project.id, 'report_summary_generated', 'main agent report summary generated', {
        model: agentSummary.model, source: agentSummary.source, verdict: agentSummary.verdict ?? null,
      });
      return project;
    } finally {
      job.done();
    }
  }

  private async executePlans(project: Project, signal: AbortSignal): Promise<Project> {
    while ((project.current_plan_index ?? 0) < (project.plans?.length ?? 0)) {
      if (signal.aborted || project.stop_requested) return this.stopProject(project.id);
      const plan = project.plans![project.current_plan_index ?? 0]!;
      let run: Run;
      let diagnosis: Diagnosis | null = null;
      try {
        ({ run, diagnosis } = await this.runPlan(project, plan, signal));
      } catch (error) {
        if (signal.aborted || project.stop_requested) return this.stopProject(project.id);
        return this.failProject(project.id, error);
      }
      if (signal.aborted || project.stop_requested) return this.stopProject(project.id);
      if (run.status !== 'succeeded') {
        if (!diagnosis) return this.failProject(project.id, new Error('experiment failed and no diagnosis was produced'));
        let delegated: CodeAgentResult | null = null;
        if (!diagnosis.patch_diff && diagnosis.needs_code_agent && this.codeAgent) {
          if ((project.patch_attempts ?? 0) >= project.budget.max_patches) {
            return this.failProject(project.id, new Error(`patch budget exhausted before code agent delegation after ${project.patch_attempts ?? 0} proposal(s)`));
          }
          const claim = claimByID(project, plan.claim_id);
          await this.appendEvent(project.id, 'code_agent_started', 'delegating implementation to a professional code agent', {
            run_id: run.run_id, claim_id: plan.claim_id, agent: this.codeAgent.name(),
          });
          try {
            delegated = await this.codeAgent.propose({
              projectId: project.id, claimId: plan.claim_id, workspace: project.workspace_path, evidenceDir: project.evidence_dir,
              acceptanceCommand: plan.command, paper: project.paper, claim, plan, run, diagnosis,
              onOutput: (stream, text) => {
                if (!text.trim()) return;
                void this.appendEvent(project.id, 'code_agent_output', text, { run_id: run.run_id, stream }).catch(() => undefined);
              },
            });
            await this.appendEvent(project.id, 'code_agent_finished', 'code agent completed its implementation pass', {
              run_id: run.run_id, agent: delegated.agent, version: delegated.version, files: delegated.files,
              duration_ms: delegated.durationMs, log_path: delegated.logPath,
            });
          } catch (error) {
            await this.appendEvent(project.id, 'code_agent_failed', 'code agent delegation failed', {
              run_id: run.run_id, error: (error as Error).message,
            }).catch(() => undefined);
            return this.failProject(project.id, new Error(`code agent delegation failed: ${(error as Error).message}`));
          }
          if (!delegated?.diff.trim()) return this.failProject(project.id, new Error('code agent returned no implementation diff'));
          diagnosis.patch_diff = delegated.diff;
          diagnosis.explanation = `${diagnosis.explanation ?? ''} Delegated implementation produced by ${delegated.agent}.`.trim();
          await this.appendEvent(project.id, 'code_agent_proposed', 'code agent produced an implementation diff', {
            agent: delegated.agent, version: delegated.version, files: delegated.files, log_path: delegated.logPath, duration_ms: delegated.durationMs,
          });
        }
        if (!diagnosis.patch_diff?.trim()) {
          return this.failProject(project.id, new Error(diagnosis.root_cause || 'experiment failed and no safe patch was proposed'));
        }
        if ((project.patch_attempts ?? 0) >= project.budget.max_patches) {
          return this.failProject(project.id, new Error(`patch budget exhausted after ${project.patch_attempts ?? 0} proposal(s)`));
        }
        const manager = new PatchManager(project.workspace_path);
        let files: string[];
        try {
          files = await manager.validate(diagnosis.patch_diff);
        } catch (error) {
          return this.failProject(project.id, new Error(`proposed patch failed safety validation: ${(error as Error).message}`));
        }
        project.patch = {
          patch_id: newId('patch'), run_id: run.run_id, claim_id: plan.claim_id, diagnosis, diff: diagnosis.patch_diff,
          files, status: 'proposed', created_at: new Date().toISOString(),
          ...(delegated ? { code_agent: delegated.agent, code_agent_version: delegated.version, code_agent_log_path: delegated.logPath, code_agent_summary: delegated.summary } : {}),
        };
        project.patch_attempts = (project.patch_attempts ?? 0) + 1;
        project.error = '';
        await this.save(project);
        await this.appendEvent(project.id, 'patch_proposed', 'minimal patch proposed; waiting for human approval', {
          patch_id: project.patch.patch_id, run_id: run.run_id, failure_class: diagnosis.failure_class, files, diff_sha256: hashString(diagnosis.patch_diff),
        });
        await this.transition(project, 'run_failed', 'experiment failed; patch approval required');
        return project;
      }
      await this.transition(project, 'run_succeeded', 'experiment succeeded; verifying metric');
      const verification = verifyRun(plan, run);
      project.verifications = [...(project.verifications ?? []), verification];
      project.verification = verification;
      project.current_plan_index = (project.current_plan_index ?? 0) + 1;
      await this.save(project);
      await this.appendEvent(project.id, 'metric_verified', `rule-based verdict ${verification.verdict}`, {
        claim_id: verification.claim_id, verdict: verification.verdict, expected: verification.expected, observed: verification.observed,
      });
      if ((project.current_plan_index ?? 0) < (project.plans?.length ?? 0)) {
        await this.transition(project, 'next_plan', 'continuing with next confirmed plan');
        continue;
      }
      await this.transition(project, 'verification_completed', 'all selected claims verified; generating report');
      return this.finishReport(project);
    }
    return this.failProject(project.id, new Error('no experiment plan was executed'));
  }

  private async runPlan(project: Project, plan: ExperimentPlan, signal: AbortSignal): Promise<{ run: Run; diagnosis: Diagnosis | null }> {
    if ((project.runs?.length ?? 0) >= project.budget.max_runs) throw new Error(`run budget exhausted after ${project.runs?.length ?? 0} attempt(s)`);
    const runId = newId('run');
    const attempt = (project.runs?.length ?? 0) + 1;
    await this.appendEvent(project.id, 'run_started', `starting experiment attempt ${attempt}`, {
      run_id: runId, attempt, command: plan.command, runner: this.runner.name(), seed: plan.seed,
    });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let flushTimer: NodeJS.Timeout | null = null;
    let flushChain: Promise<void> = Promise.resolve();
    const cleanOutput = (text: string): string => text.replace(/\r\n?/g, '\n').trimEnd();
    const flushOutput = (): Promise<void> => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
      const stdout = cleanOutput(stdoutBuffer);
      const stderr = cleanOutput(stderrBuffer);
      stdoutBuffer = '';
      stderrBuffer = '';
      if (stdout) chunks.push({ stream: 'stdout', text: stdout });
      if (stderr) chunks.push({ stream: 'stderr', text: stderr });
      flushChain = flushChain.then(async () => {
        for (const chunk of chunks) {
          await this.appendEvent(project.id, 'run_output', chunk.text, { run_id: runId, stream: chunk.stream });
        }
      });
      return flushChain;
    };
    const scheduleFlush = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; void flushOutput(); }, 200);
    };
    const result: ExecutionResult = await this.runner.execute({
      projectId: project.id, runId, workspace: project.workspace_path, evidenceDir: project.evidence_dir,
      command: plan.command, image: plan.image, workDir: plan.work_dir, seed: plan.seed,
      timeoutMs: project.budget.max_seconds * 1000, signal,
      onOutput: (stream, text) => {
        if (stream === 'stdout') stdoutBuffer += text;
        else stderrBuffer += text;
        if (stdoutBuffer.length + stderrBuffer.length > 8192) void flushOutput();
        else scheduleFlush();
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await flushOutput();
    const runMetadata = extractRunMetadata(result.command, result.stdout, plan.seed);
    const run: Run = {
      run_id: runId, claim_id: plan.claim_id, plan_id: plan.id, attempt: (project.runs?.length ?? 0) + 1, runner: result.runner, command: result.command,
      ...(result.image ? { image: result.image } : {}), work_dir: result.workDir, status: result.status, exit_code: result.exitCode,
      started_at: result.startedAt, finished_at: result.finishedAt, duration_ms: result.durationMs,
      ...(result.stdoutPath ? { stdout_path: result.stdoutPath } : {}), ...(result.stderrPath ? { stderr_path: result.stderrPath } : {}),
      stdout: result.stdout, stderr: result.stderr, stdout_sha256: hashString(result.stdout), stderr_sha256: hashString(result.stderr),
      stdout_truncated: result.stdoutTruncated, stderr_truncated: result.stderrTruncated, env: result.env,
      gpu: result.gpu || runMetadata.gpu_detected, requested_seed: runMetadata.requested_seed, effective_seed: runMetadata.effective_seed,
      seed_source: runMetadata.seed_source, gpu_detected: runMetadata.gpu_detected,
      ...(runMetadata.gpu_device ? { gpu_device: runMetadata.gpu_device } : {}),
      ...(result.provider ? { provider: result.provider } : {}), ...(result.remoteJobId ? { remote_job_id: result.remoteJobId } : {}),
    };
    if (result.status === 'succeeded') {
      try { run.metric = (await import('../tools/verify.js')).extractMetric(result.stdout, plan.metric_source); }
      catch (error) { await this.appendEvent(project.id, 'metric_unavailable', (error as Error).message, { run_id: runId }); }
    }
    project.runs = [...(project.runs ?? []), run];
    await this.save(project);
    await this.appendEvent(project.id, 'run_completed', `run ${run.attempt} finished with status ${run.status}`, {
      run_id: run.run_id, attempt: run.attempt, status: run.status, exit_code: run.exit_code, duration_ms: run.duration_ms,
      stdout_path: run.stdout_path, stderr_path: run.stderr_path,
    });
    if (result.status === 'succeeded') return { run, diagnosis: null };
    let diagnosis: Diagnosis;
    try {
      diagnosis = await this.analyzer.diagnose(run, project.repo, project.workspace_path);
    } catch (error) {
      diagnosis = { failure_class: 'unknown', root_cause: 'diagnosis failed', confidence: 'low', explanation: (error as Error).message };
    }
    run.failure_class = diagnosis.failure_class;
    run.failure_summary = diagnosis.root_cause;
    project.runs[project.runs.length - 1] = run;
    await this.save(project);
    await this.appendEvent(project.id, 'diagnosis_completed', `failure diagnosed as ${diagnosis.failure_class}`, { run_id: run.run_id, failure_class: diagnosis.failure_class, confidence: diagnosis.confidence });
    return { run, diagnosis };
  }

  private async finishReport(project: Project): Promise<Project> {
    const events = await this.allEvents(project.id);
    await this.appendEvent(project.id, 'report_summary_started', 'main agent is summarizing the evidence report');
    const agentSummary = await this.generateAgentSummary(project, events);
    const report = await buildReport(project, events, agentSummary);
    const packagePath = await exportPackage(project, report, events);
    report.package_path = packagePath;
    project.report = report;
    await this.save(project);
    await this.appendEvent(project.id, 'report_summary_generated', 'main agent report summary generated', {
      model: agentSummary.model, source: agentSummary.source, verdict: agentSummary.verdict ?? null,
    });
    await this.appendEvent(project.id, 'report_generated', 'evidence report and reproduction package generated', { report_id: report.report_id, package_path: packagePath });
    await this.transition(project, 'report_completed', 'workflow completed');
    return project;
  }

  private async generateAgentSummary(project: Project, events: Event[]): Promise<AgentReportSummary> {
    try {
      const summary = await this.analyzer.summarizeReport?.(project, events);
      if (!summary) throw new Error('analyzer does not support report summaries');
      return summary;
    } catch (error) {
      await this.appendEvent(project.id, 'report_summary_fallback', 'main model summary failed; using deterministic summary', { error: (error as Error).message });
      return new HeuristicAnalyzer().summarizeReport(project, events);
    }
  }

  private async transition(project: Project, action: Action, message: string): Promise<void> {
    const from = project.state;
    const next = validateTransition(from, action);
    project.state = next;
    project.updated_at = new Date().toISOString();
    const saved = await this.store.saveProjectAndEvent(project, 'state_changed', message, { from, to: next, action });
    this.emitEvent(saved.event);
  }

  private async save(project: Project): Promise<void> {
    project.updated_at = new Date().toISOString();
    await this.store.saveProject(project);
  }

  private readonly eventListeners = new Set<(event: Event) => void>();

  onEvent(listener: (event: Event) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private async appendEvent(projectId: string, type: string, message: string, data?: Record<string, unknown>): Promise<Event> {
    const event = await this.store.appendEvent(projectId, type, message, data);
    this.emitEvent(event);
    return event;
  }

  private emitEvent(event: Event): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private async handleFailure(projectId: string, error: unknown): Promise<Project> {
    if (error instanceof InvalidStateError || error instanceof ValidationError || error instanceof ProjectBusyError || error instanceof IdempotencyConflictError) throw error;
    return this.failProject(projectId, error);
  }

  private async failProject(projectId: string, error: unknown): Promise<Project> {
    const project = await this.store.getProject(projectId).catch((cause) => {
      if (cause instanceof StoreNotFoundError) throw cause;
      throw cause;
    });
    if (project.stop_requested) return this.stopProject(projectId);
    project.error = error instanceof Error ? error.message : String(error);
    const next = canTransition(project.state, 'fail');
    if (next) project.state = next;
    await this.save(project);
    await this.appendEvent(project.id, 'workflow_failed', project.error);
    return project;
  }

  private async stopProject(projectId: string): Promise<Project> {
    const project = await this.store.getProject(projectId);
    project.stop_requested = true;
    project.error = 'workflow stopped by user';
    const next = canTransition(project.state, 'stop');
    if (next) project.state = next;
    await this.save(project);
    await this.appendEvent(project.id, 'workflow_stopped', 'workflow stopped');
    return project;
  }

  private async prepareOperation(
    projectId: string,
    kind: OperationKind,
    idempotencyKey: string | undefined,
    requestHash?: string,
  ): Promise<{ operation: Operation; existing: boolean }> {
    const key = idempotencyKey?.trim() || undefined;
    if (key && key.length > 160) throw new ValidationError('idempotency key must be 160 characters or fewer');
    if (key) {
      const existing = await this.store.findOperationByIdempotencyKey(key);
      if (existing) {
        this.assertOperationReplay(existing, projectId, kind, requestHash);
        return { operation: existing, existing: true };
      }
    }
    const now = new Date().toISOString();
    const operation: Operation = {
      id: newId('op'),
      project_id: projectId,
      kind,
      status: 'running',
      ...(key ? { idempotency_key: key } : {}),
      ...(requestHash ? { request_hash: requestHash } : {}),
      lease_owner: this.operationOwner,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      created_at: now,
      updated_at: now,
    };
    try {
      await this.store.createOperation(operation);
      return { operation, existing: false };
    } catch (error) {
      if (error instanceof StoreBusyError) throw new ProjectBusyError();
      if (key && error instanceof StoreDuplicateError) {
        const existing = await this.store.findOperationByIdempotencyKey(key);
        if (existing) {
          this.assertOperationReplay(existing, projectId, kind, requestHash);
          return { operation: existing, existing: true };
      }
      }
      throw error;
    }
  }

  private async executeOperation(operation: Operation, run: () => Promise<Project>): Promise<Project> {
    const heartbeat = setInterval(() => {
      const timestamp = new Date().toISOString();
      void this.store.renewOperationLease(
        operation.id,
        this.operationOwner,
        timestamp,
        new Date(Date.now() + 60_000).toISOString(),
      ).catch(() => false);
    }, 15_000);
    heartbeat.unref?.();
    try {
      const project = await run();
      clearInterval(heartbeat);
      const finishedAt = new Date().toISOString();
      await this.store.finishOperation(operation.id, this.operationOwner, 'succeeded', finishedAt, project.revision);
      return project;
    } catch (error) {
      clearInterval(heartbeat);
      const finishedAt = new Date().toISOString();
      await this.store.finishOperation(
        operation.id,
        this.operationOwner,
        'failed',
        finishedAt,
        undefined,
        error instanceof Error ? error.message : String(error),
      ).catch(() => false);
      throw error;
    }
  }

  private async runOperation(
    projectId: string,
    kind: OperationKind,
    idempotencyKey: string | undefined,
    run: () => Promise<Project>,
    requestHash?: string,
  ): Promise<Project> {
    const prepared = await this.prepareOperation(projectId, kind, idempotencyKey, requestHash);
    if (prepared.existing) return this.replayOperation(prepared.operation, projectId, kind, requestHash);
    return this.executeOperation(prepared.operation, run);
  }

  private async acceptOperation(
    projectId: string,
    kind: OperationKind,
    idempotencyKey: string | undefined,
    run: () => Promise<Project>,
    requestHash?: string,
  ): Promise<OperationAcceptance> {
    const prepared = await this.prepareOperation(projectId, kind, idempotencyKey, requestHash);
    const project = await this.getProject(projectId);
    if (prepared.existing) {
      if (prepared.operation.status === 'running' || prepared.operation.status === 'succeeded') {
        return { operation: prepared.operation, project, replayed: true };
      }
      throw new InvalidStateError(`operation ${prepared.operation.id} previously ${prepared.operation.status}${prepared.operation.error ? `: ${prepared.operation.error}` : ''}`);
    }
    void this.executeOperation(prepared.operation, run).catch(() => undefined);
    return { operation: prepared.operation, project, replayed: false };
  }

  private async replayOperation(operation: Operation, projectId: string, kind: OperationKind, requestHash?: string): Promise<Project> {
    this.assertOperationReplay(operation, projectId, kind, requestHash);
    if (operation.status === 'succeeded') return this.getProject(projectId);
    if (operation.status === 'running') throw new ProjectBusyError();
    throw new InvalidStateError(`operation ${operation.id} previously ${operation.status}${operation.error ? `: ${operation.error}` : ''}`);
  }
  private assertOperationReplay(operation: Operation, projectId: string, kind: OperationKind, requestHash?: string): void {
    if (operation.project_id !== projectId || operation.kind !== kind) {
      throw new ValidationError('idempotency key belongs to a different project or operation');
    }
    if (requestHash && operation.request_hash && operation.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }
  }
  private beginJob(projectId: string): JobHandle {
    if (this.jobs.has(projectId)) throw new ProjectBusyError();
    const controller = new AbortController();
    const done = (): void => { this.jobs.delete(projectId); };
    this.jobs.set(projectId, { controller, done });
    return { controller, done };
  }
}

function emptyPaper(): Paper {
  return { title: '', text: '', source_path: '', sha256: '', claims: [], parsed_at: new Date().toISOString() };
}

function emptyRepo(): RepoSummary {
  return { root: '', files: [], command_candidates: [], scanned_at: new Date().toISOString() };
}

function claimByID(project: Project, claimId: string): Claim {
  return project.claims?.find((claim) => claim.claim_id === claimId) ?? {
    claim_id: claimId, text: '', metric: '', expected_value: 0, tolerance: { abs: 0, rel: 0 }, source: { path: '', line: 0 }, selected: false,
  };
}

async function existingPath(path: string, kind: 'file' | 'directory' | 'path', label: string): Promise<string> {
  if (!path.trim()) throw new Error(`${label} is empty`);
  const absolute = resolve(path);
  const info = await stat(absolute).catch(() => null);
  if (!info) throw new Error(`${label} does not exist: ${absolute}`);
  if (kind === 'file' && !info.isFile()) throw new Error(`${label} is not a file`);
  if (kind === 'directory' && !info.isDirectory()) throw new Error(`${label} is not a directory`);
  return absolute;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
