package tools

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reprolens/internal/domain"
)

func TestBuildReportAndExportPackage(t *testing.T) {
	root := t.TempDir()
	evidenceDir := filepath.Join(root, "evidence")
	if err := os.MkdirAll(filepath.Join(evidenceDir, "runs", "run1"), 0o755); err != nil {
		t.Fatal(err)
	}
	stdoutPath := filepath.Join(evidenceDir, "runs", "run1", "stdout.log")
	if err := os.WriteFile(stdoutPath, []byte("accuracy=0.81\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	project := &domain.Project{
		ID: "p1", Name: "accuracy demo", State: domain.StateCompleted,
		PaperPath: "paper.md", RepoPath: "repo", WorkspacePath: filepath.Join(root, "workspace"), EvidenceDir: evidenceDir,
		Budget:       domain.Budget{MaxRuns: 3, MaxSeconds: 120, MaxPatches: 2},
		Claims:       []domain.Claim{{ID: "C1", Text: "accuracy 0.81", Metric: "accuracy", ExpectedValue: 0.81, Tolerance: domain.Tolerance{Abs: 0.01}}},
		Plans:        []domain.ExperimentPlan{{ID: "plan_c1", ClaimID: "C1", Command: "python run_experiment.py --seed 42", Seed: 42, ExpectedMetric: "accuracy", ExpectedValue: 0.81, Tolerance: domain.Tolerance{Abs: 0.01}}},
		Runs:         []domain.Run{{ID: "run1", Attempt: 1, Runner: "local (unsafe)", Command: "python run_experiment.py", Status: "succeeded", ExitCode: 0, StdoutPath: stdoutPath, Metric: &domain.Metric{Name: "accuracy", Value: 0.81}}},
		Patch:        &domain.PatchProposal{ID: "patch1", RunID: "run1", Diff: "--- a/run_experiment.py\n+++ b/run_experiment.py\n@@ -1 +1 @@\n-SEED = 0\n+SEED = 42\n", Status: "applied", ApprovedBy: "local-user", AppliedAt: &now, CodeAgent: "codex", CodeAgentVersion: "codex exec", CodeAgentSummary: "delegated implementation"},
		Verification: &domain.Verification{ID: "v1", ClaimID: "C1", Metric: "accuracy", Expected: 0.81, Observed: 0.81, Tolerance: domain.Tolerance{Abs: 0.01}, Verdict: domain.VerdictPass, Rule: "abs_error 0 <= 0.01", VerifiedAt: now},
		CreatedAt:    now.Add(-time.Minute), UpdatedAt: now,
	}
	events := []domain.Event{{ProjectID: "p1", Seq: 1, Type: "patch_approved", Message: "user approved patch", CreatedAt: now}}
	report, err := BuildReport(project, events)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"PASS", "0.81", "approved", "python run_experiment.py", "+SEED = 42", "codex"} {
		if !strings.Contains(report.Markdown, want) {
			t.Fatalf("report missing %q:\n%s", want, report.Markdown)
		}
	}
	zipPath, err := ExportPackage(project, report, events)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	entries := map[string]bool{}
	for _, f := range zr.File {
		entries[f.Name] = true
	}
	for _, want := range []string{"manifest.json", "report.md", "project.json", "events.json", "evidence/runs/run1/stdout.log"} {
		if !entries[want] {
			t.Fatalf("ZIP missing %q: %+v", want, entries)
		}
	}
}
