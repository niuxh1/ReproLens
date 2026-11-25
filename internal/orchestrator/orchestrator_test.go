package orchestrator

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reprolens/internal/agent"
	"reprolens/internal/codeagent"
	"reprolens/internal/demo"
	"reprolens/internal/domain"
	"reprolens/internal/platformmock"
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
		t.Fatalf("confirm plan: %v; state=%s patch=%+v runs=%+v", err, project.State, project.Patch, project.Runs)
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

func TestDemoWorkflowOnColabStylePlatform(t *testing.T) {
	ctx := context.Background()
	platformServer := httptest.NewServer(platformmock.NewHandler())
	defer platformServer.Close()
	dataDir := t.TempDir()
	paperPath, repoPath, err := demo.Materialize(dataDir, "platform-demo")
	if err != nil {
		t.Fatal(err)
	}
	runner := tools.NewPlatformRunnerWithGPU(tools.PlatformConfig{
		BaseURL: platformServer.URL, Provider: "colab", Image: "python:3.11-slim",
		MinVRAMGB: 16, MaxHourlyUSD: 0.5, PollInterval: 10 * time.Millisecond, Timeout: 10 * time.Second,
	}, true)
	mem := store.NewMemory()
	o := New(mem, agent.NewHeuristic(), runner, dataDir)
	project, err := o.CreateProject(ctx, CreateInput{
		Name: "Platform demo", PaperPath: paperPath, RepoPath: repoPath,
		Budget: domain.Budget{MaxRuns: 3, MaxSeconds: 30, MaxPatches: 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	project, err = o.Start(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	project, err = o.SelectClaims(ctx, project.ID, []string{"C1"})
	if err != nil {
		t.Fatal(err)
	}
	project, err = o.ConfirmPlan(ctx, project.ID)
	if err != nil {
		t.Fatalf("confirm plan: %v; state=%s patch=%+v runs=%+v", err, project.State, project.Patch, project.Runs)
	}
	if project.State != domain.StateAwaitingPatch {
		t.Fatalf("state = %s runs=%+v", project.State, project.Runs)
	}
	project, err = o.ApprovePatch(ctx, project.ID, "platform-test-user")
	if err != nil {
		t.Fatal(err)
	}
	if project.State != domain.StateCompleted || project.Verification == nil || project.Verification.Verdict != domain.VerdictPass {
		t.Fatalf("final = %+v", project)
	}
	if len(project.Runs) != 2 || project.Runs[1].Provider != "colab" || !project.Runs[1].GPU {
		t.Fatalf("platform runs = %+v", project.Runs)
	}
}

type failingImplementationRunner struct{}

func (failingImplementationRunner) Name() string { return "fake-failing-runner" }
func (failingImplementationRunner) Execute(_ context.Context, req tools.ExecutionRequest) (tools.ExecutionResult, error) {
	now := time.Now().UTC()
	return tools.ExecutionResult{
		Runner: "fake-failing-runner", Command: req.Command, Status: "failed", ExitCode: 1,
		StartedAt: now, FinishedAt: now, Stderr: "NotImplementedError: missing algorithm\n",
	}, nil
}

func TestCodeAgentDelegationProducesPatchWithoutDirectApply(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	paperPath, repoPath, err := demo.Materialize(dataDir, "codeagent-demo")
	if err != nil {
		t.Fatal(err)
	}
	mem := store.NewMemory()
	o := New(mem, agent.NewHeuristic(), failingImplementationRunner{}, dataDir)
	mock := &codeagent.Mock{Result: &codeagent.Result{
		Agent: "mock-code-agent", Version: "test", Summary: "implemented missing algorithm",
		Diff:  "--- /dev/null\n+++ b/delegated_impl.py\n@@ -0,0 +1,2 @@\n+def solve():\n+    return 42\n",
		Files: []string{"delegated_impl.py"},
	}}
	o.SetCodeAgent(mock)
	project, err := o.CreateProject(ctx, CreateInput{
		Name: "CodeAgent demo", PaperPath: paperPath, RepoPath: repoPath,
		Budget: domain.Budget{MaxRuns: 2, MaxSeconds: 30, MaxPatches: 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	project, err = o.Start(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	project, err = o.SelectClaims(ctx, project.ID, []string{"C1"})
	if err != nil {
		t.Fatal(err)
	}
	project, err = o.ConfirmPlan(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if project.State != domain.StateAwaitingPatch || project.Patch == nil {
		t.Fatalf("state=%s patch=%+v", project.State, project.Patch)
	}
	if mock.Calls != 1 || project.Patch.CodeAgent != "mock-code-agent" {
		t.Fatalf("calls=%d patch=%+v", mock.Calls, project.Patch)
	}
	if _, err := os.Stat(filepath.Join(project.WorkspacePath, "delegated_impl.py")); !os.IsNotExist(err) {
		t.Fatalf("code agent must not apply directly; stat err=%v", err)
	}
}
