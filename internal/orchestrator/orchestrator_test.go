package orchestrator

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"reprolens/internal/agent"
	"reprolens/internal/demo"
	"reprolens/internal/domain"
	"reprolens/internal/store"
	"reprolens/internal/tools"
)

func TestDemoWorkflowReachesRuleComputedPass(t *testing.T) {
	if _, err := exec.LookPath("python"); err != nil {
		t.Skip("python not available")
	}
	ctx := context.Background()
	dataDir := t.TempDir()
	paperPath, repoPath, err := demo.Materialize(dataDir, "demo-project")
	if err != nil {
		t.Fatal(err)
	}
	mem := store.NewMemory()
	o := New(mem, agent.NewHeuristic(), tools.NewLocalRunner(), dataDir)
	project, err := o.CreateProject(ctx, CreateInput{
		Name: "Accuracy demo", PaperPath: paperPath, RepoPath: repoPath,
		Budget: domain.Budget{MaxRuns: 3, MaxSeconds: 30, MaxPatches: 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	project, err = o.Start(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if project.State != domain.StateAwaitingClaims {
		t.Fatalf("state after start = %s", project.State)
	}
	if len(project.Claims) != 1 || project.Claims[0].ID != "C1" {
		t.Fatalf("claims = %+v", project.Claims)
	}
	project, err = o.SelectClaims(ctx, project.ID, []string{"C1"})
	if err != nil {
		t.Fatal(err)
	}
	if project.State != domain.StateAwaitingPlan || len(project.Plans) != 1 {
		t.Fatalf("project after selection = %+v", project)
	}
	project, err = o.ConfirmPlan(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if project.State != domain.StateAwaitingPatch {
		t.Fatalf("state after first run = %s; runs=%+v", project.State, project.Runs)
	}
	if project.Patch == nil || !strings.Contains(project.Patch.Diff, "+SEED = 42") {
		t.Fatalf("patch = %+v", project.Patch)
	}
	project, err = o.ApprovePatch(ctx, project.ID, "test-user")
	if err != nil {
		t.Fatal(err)
	}
	if project.State != domain.StateCompleted {
		t.Fatalf("final state = %s error=%s runs=%+v", project.State, project.Error, project.Runs)
	}
	if project.Verification == nil || project.Verification.Verdict != domain.VerdictPass {
		t.Fatalf("verification = %+v", project.Verification)
	}
	if project.Report == nil || project.Report.PackagePath == "" {
		t.Fatalf("report = %+v", project.Report)
	}
	if _, err := os.Stat(project.Report.PackagePath); err != nil {
		t.Fatalf("package missing: %v", err)
	}
	events, err := mem.ListEvents(ctx, project.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	foundApproval := false
	for _, ev := range events {
		if ev.Type == "patch_approved" {
			foundApproval = true
		}
	}
	if !foundApproval {
		t.Fatalf("patch approval event missing: %+v", events)
	}
}