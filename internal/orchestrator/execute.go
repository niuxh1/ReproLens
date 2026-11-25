package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"reprolens/internal/codeagent"
	"reprolens/internal/domain"
	"reprolens/internal/tools"
)

func (o *Orchestrator) executePlans(ctx context.Context, project *domain.Project) (*domain.Project, error) {
	for project.CurrentPlanIndex < len(project.Plans) {
		if err := o.checkStopped(ctx, project); err != nil {
			return project, nil
		}
		plan := project.Plans[project.CurrentPlanIndex]
		run, diagnosis, err := o.runPlan(ctx, project, plan)
		if err != nil {
			if errors.Is(err, context.Canceled) || project.StopRequested {
				return o.stopProject(context.Background(), project)
			}
			return o.failProject(context.Background(), project, err)
		}
		if run.Status != "succeeded" {
			if err := o.checkStopped(ctx, project); err != nil {
				return project, nil
			}
			if diagnosis == nil {
				return o.failProject(context.Background(), project, fmt.Errorf("experiment failed and no diagnosis was produced"))
			}
			var delegated *codeagent.Result
			if strings.TrimSpace(diagnosis.PatchDiff) == "" && diagnosis.NeedsCodeAgent && o.codeAgent != nil {
				claim := claimByID(project, plan.ClaimID)
				delegated, err = o.codeAgent.Propose(ctx, codeagent.Task{
					ProjectID: project.ID, ClaimID: plan.ClaimID, Workspace: project.WorkspacePath,
					EvidenceDir: project.EvidenceDir, AcceptanceCommand: plan.Command,
					Paper: project.Paper, Claim: claim, Plan: plan, Run: run, Diagnosis: *diagnosis,
				})
				if err != nil {
					return o.failProject(context.Background(), project, fmt.Errorf("code agent delegation failed: %w", err))
				}
				if delegated == nil || strings.TrimSpace(delegated.Diff) == "" {
					return o.failProject(context.Background(), project, fmt.Errorf("code agent returned no implementation diff"))
				}
				diagnosis.PatchDiff = delegated.Diff
				diagnosis.Explanation = strings.TrimSpace(diagnosis.Explanation + " Delegated implementation produced by " + delegated.Agent + ".")
				if _, err := o.appendEvent(ctx, project.ID, "code_agent_proposed", "code agent produced an implementation diff", map[string]any{
					"agent": delegated.Agent, "version": delegated.Version, "files": delegated.Files,
					"log_path": delegated.LogPath, "duration_ms": delegated.Duration.Milliseconds(),
				}); err != nil {
					return o.failProject(context.Background(), project, err)
				}
			}
			if strings.TrimSpace(diagnosis.PatchDiff) == "" {
				message := "experiment failed and no safe patch was proposed"
				if diagnosis.RootCause != "" {
					message = diagnosis.RootCause
				}
				if diagnosis.NeedsCodeAgent && o.codeAgent == nil {
					message += "; configure REPROLENS_CODE_AGENT_CMD to delegate implementation"
				}
				return o.failProject(context.Background(), project, fmt.Errorf("%s", message))
			}
			if project.PatchAttempts >= project.Budget.MaxPatches {
				return o.failProject(context.Background(), project, fmt.Errorf("patch budget exhausted after %d proposal(s)", project.PatchAttempts))
			}
			pm := &tools.PatchManager{Workspace: project.WorkspacePath}
			files, err := pm.Validate(diagnosis.PatchDiff)
			if err != nil {
				return o.failProject(context.Background(), project, fmt.Errorf("proposed patch failed safety validation: %w", err))
			}
			patch := &domain.PatchProposal{
				ID: newID("patch"), RunID: run.ID, ClaimID: plan.ClaimID,
				Diagnosis: *diagnosis, Diff: diagnosis.PatchDiff, Files: files,
				Status: "proposed", CreatedAt: time.Now().UTC(),
			}
			if delegated != nil {
				patch.CodeAgent = delegated.Agent
				patch.CodeAgentVersion = delegated.Version
				patch.CodeAgentLogPath = delegated.LogPath
				patch.CodeAgentSummary = delegated.Summary
			}
			project.Patch = patch
			project.PatchAttempts++
			project.Error = ""
			if err := o.saveProject(ctx, project); err != nil {
				return o.failProject(context.Background(), project, err)
			}
			if _, err := o.appendEvent(ctx, project.ID, "patch_proposed", "minimal patch proposed; waiting for human approval", map[string]any{
				"patch_id": project.Patch.ID, "run_id": run.ID, "failure_class": diagnosis.FailureClass,
				"files": files, "diff_sha256": hashString(diagnosis.PatchDiff),
			}); err != nil {
				return o.failProject(context.Background(), project, err)
			}
			if err := o.transition(ctx, project, domain.ActionRunFailed, "experiment failed; patch approval required"); err != nil {
				return o.failProject(context.Background(), project, err)
			}
			return project, nil
		}

		if err := o.transition(ctx, project, domain.ActionRunSucceeded, "experiment succeeded; verifying metric"); err != nil {
			return o.failProject(context.Background(), project, err)
		}
		verification := tools.VerifyRun(plan, run)
		project.Verifications = append(project.Verifications, verification)
		project.Verification = &project.Verifications[len(project.Verifications)-1]
		project.CurrentPlanIndex++
		if err := o.saveProject(ctx, project); err != nil {
			return o.failProject(context.Background(), project, err)
		}
		if _, err := o.appendEvent(ctx, project.ID, "verification_completed", fmt.Sprintf("claim %s verdict: %s", verification.ClaimID, verification.Verdict), map[string]any{
			"claim_id": verification.ClaimID, "verdict": verification.Verdict,
			"expected": verification.Expected, "observed": verification.Observed,
		}); err != nil {
			return o.failProject(context.Background(), project, err)
		}
		if project.CurrentPlanIndex < len(project.Plans) {
			if err := o.transition(ctx, project, domain.ActionNextPlan, "continuing with next confirmed plan"); err != nil {
				return o.failProject(context.Background(), project, err)
			}
			continue
		}
		if err := o.transition(ctx, project, domain.ActionVerificationCompleted, "all selected claims verified; generating report"); err != nil {
			return o.failProject(context.Background(), project, err)
		}
		return o.finishReport(ctx, project)
	}
	return o.failProject(context.Background(), project, fmt.Errorf("no experiment plan was executed"))
}

func (o *Orchestrator) runPlan(ctx context.Context, project *domain.Project, plan domain.ExperimentPlan) (domain.Run, *domain.Diagnosis, error) {
	if len(project.Runs) >= project.Budget.MaxRuns {
		return domain.Run{}, nil, fmt.Errorf("run budget exhausted after %d attempt(s)", len(project.Runs))
	}
	runID := newID("run")
	timeout := time.Duration(project.Budget.MaxSeconds) * time.Second
	result, err := o.runner.Execute(ctx, tools.ExecutionRequest{
		ProjectID: project.ID, RunID: runID, Workspace: project.WorkspacePath, EvidenceDir: project.EvidenceDir,
		Command: plan.Command, Image: plan.Image, WorkDir: plan.WorkDir, Seed: plan.Seed,
		Timeout: timeout,
	})
	if err != nil {
		return domain.Run{}, nil, err
	}
	run := domain.Run{
		ID: runID, Attempt: len(project.Runs) + 1, Runner: result.Runner,
		Command: result.Command, Image: result.Image, WorkDir: result.WorkDir,
		Status: result.Status, ExitCode: result.ExitCode, StartedAt: result.StartedAt,
		FinishedAt: result.FinishedAt, DurationMS: result.DurationMS, StdoutPath: result.StdoutPath,
		StderrPath: result.StderrPath, Stdout: result.Stdout, Stderr: result.Stderr, Env: result.Env,
		GPU: result.GPU, Provider: result.Provider, RemoteJobID: result.RemoteJobID, OfferID: result.OfferID,
	}
	if result.Status == "succeeded" {
		if metric, err := tools.ExtractMetric(result.Stdout, plan.MetricSource); err == nil {
			run.Metric = metric
		} else {
			_, _ = o.appendEvent(ctx, project.ID, "metric_unavailable", err.Error(), map[string]any{"run_id": runID})
		}
	}
	project.Runs = append(project.Runs, run)
	if err := o.saveProject(ctx, project); err != nil {
		return run, nil, err
	}
	if _, err := o.appendEvent(ctx, project.ID, "run_completed", fmt.Sprintf("run %d finished with status %s", run.Attempt, run.Status), map[string]any{
		"run_id": run.ID, "attempt": run.Attempt, "status": run.Status, "exit_code": run.ExitCode,
		"duration_ms": run.DurationMS, "stdout_path": run.StdoutPath, "stderr_path": run.StderrPath,
	}); err != nil {
		return run, nil, err
	}
	if result.Status == "succeeded" {
		return run, nil, nil
	}
	diagnosis, diagErr := o.analyzer.Diagnose(ctx, run, project.Repo, project.WorkspacePath)
	if diagErr != nil {
		diagnosis = &domain.Diagnosis{FailureClass: "unknown", RootCause: "diagnosis failed", Confidence: "low", Explanation: diagErr.Error()}
	}
	run.FailureClass = diagnosis.FailureClass
	run.FailureSummary = diagnosis.RootCause
	if len(project.Runs) > 0 {
		project.Runs[len(project.Runs)-1] = run
	}
	if err := o.saveProject(ctx, project); err != nil {
		return run, diagnosis, err
	}
	if _, err := o.appendEvent(ctx, project.ID, "diagnosis_completed", "failure diagnosed as "+diagnosis.FailureClass, map[string]any{
		"run_id": run.ID, "failure_class": diagnosis.FailureClass, "confidence": diagnosis.Confidence,
	}); err != nil {
		return run, diagnosis, err
	}
	return run, diagnosis, nil
}

func (o *Orchestrator) finishReport(ctx context.Context, project *domain.Project) (*domain.Project, error) {
	events, err := o.store.ListEvents(ctx, project.ID, 0)
	if err != nil {
		return o.failProject(context.Background(), project, err)
	}
	report, err := tools.BuildReport(project, events)
	if err != nil {
		return o.failProject(context.Background(), project, err)
	}
	packagePath, err := tools.ExportPackage(project, report, events)
	if err != nil {
		return o.failProject(context.Background(), project, err)
	}
	report.PackagePath = packagePath
	project.Report = &report
	if err := o.saveProject(ctx, project); err != nil {
		return o.failProject(context.Background(), project, err)
	}
	if _, err := o.appendEvent(ctx, project.ID, "report_generated", "evidence report and reproduction package generated", map[string]any{
		"report_id": report.ID, "package_path": packagePath,
	}); err != nil {
		return o.failProject(context.Background(), project, err)
	}
	if err := o.transition(ctx, project, domain.ActionReportCompleted, "workflow completed"); err != nil {
		return o.failProject(context.Background(), project, err)
	}
	return project, nil
}

func claimByID(project *domain.Project, claimID string) domain.Claim {
	for _, claim := range project.Claims {
		if claim.ID == claimID {
			return claim
		}
	}
	return domain.Claim{ID: claimID}
}
