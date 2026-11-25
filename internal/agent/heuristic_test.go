package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reprolens/internal/domain"
)

func TestHeuristicExtractsClaimWithMetricToleranceAndLine(t *testing.T) {
	paper := domain.Paper{Text: strings.Join([]string{
		"# ReproLens Demo Paper",
		"",
		"Claim C1: The classifier achieves accuracy = 0.81 (tolerance ±0.01) on the test split.",
		"Unrelated text with 1576 participants.",
	}, "\n")}
	claims, err := NewHeuristic().ExtractClaims(context.Background(), paper, domain.RepoSummary{})
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 {
		t.Fatalf("claims = %d, want 1: %+v", len(claims), claims)
	}
	c := claims[0]
	if c.ID != "C1" || c.Metric != "accuracy" || c.ExpectedValue != 0.81 {
		t.Fatalf("claim = %+v", c)
	}
	if c.Tolerance.Abs != 0.01 {
		t.Fatalf("tolerance = %+v", c.Tolerance)
	}
	if c.Source.Line != 3 {
		t.Fatalf("source line = %d", c.Source.Line)
	}
	if !strings.Contains(c.Source.Quote, "accuracy") {
		t.Fatalf("source quote = %q", c.Source.Quote)
	}
}

func TestHeuristicBuildsPlanFromReadme(t *testing.T) {
	claim := domain.Claim{
		ID: "C1", Metric: "accuracy", ExpectedValue: 0.81,
		Tolerance: domain.Tolerance{Abs: 0.01},
	}
	repo := domain.RepoSummary{Readme: "Run the experiment:\n\n```bash\npython run_experiment.py --seed 42 --data data.csv\n```\n"}
	plan, err := NewHeuristic().BuildPlan(context.Background(), claim, domain.Paper{}, repo)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Command != "python run_experiment.py --seed 42 --data data.csv" {
		t.Fatalf("command = %q", plan.Command)
	}
	if plan.Seed != 42 {
		t.Fatalf("seed = %d", plan.Seed)
	}
	if plan.Image != "python:3.11-slim" {
		t.Fatalf("image = %q", plan.Image)
	}
	if plan.MetricSource.Kind != "stdout_regex" || !strings.Contains(plan.MetricSource.Pattern, "accuracy") {
		t.Fatalf("metric source = %+v", plan.MetricSource)
	}
}

func TestHeuristicDiagnosesSeedMismatchAndProposesPatch(t *testing.T) {
	dir := t.TempDir()
	script := "import sys\nSEED = 0\nprint('accuracy=0.50')\n"
	if err := os.WriteFile(filepath.Join(dir, "run_experiment.py"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	run := domain.Run{
		Status: "failed", ExitCode: 1,
		Stderr: "seed mismatch: expected 42, got 0\n",
		Env:    map[string]string{"REPROLENS_SEED": "42"},
	}
	diagnosis, err := NewHeuristic().Diagnose(context.Background(), run, domain.RepoSummary{}, dir)
	if err != nil {
		t.Fatal(err)
	}
	if diagnosis.FailureClass != "seed_mismatch" {
		t.Fatalf("class = %q", diagnosis.FailureClass)
	}
	if !strings.Contains(diagnosis.PatchDiff, "-SEED = 0") || !strings.Contains(diagnosis.PatchDiff, "+SEED = 42") {
		t.Fatalf("patch = %s", diagnosis.PatchDiff)
	}
	if diagnosis.Confidence != "high" {
		t.Fatalf("confidence = %q", diagnosis.Confidence)
	}
}

func TestHeuristicExtractsCountClaim(t *testing.T) {
	paper := domain.Paper{SourcePath: "paper.md", Text: "Claim C1: The experiment yields 25 misclassification errors (tolerance ±0.01).\n"}
	claims, err := NewHeuristic().ExtractClaims(context.Background(), paper, domain.RepoSummary{})
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Metric != "errors" || claims[0].ExpectedValue != 25 {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestHeuristicExtractsIterationsClaim(t *testing.T) {
	paper := domain.Paper{SourcePath: "paper.md", Text: "Claim C1: Grokfast reaches 95% validation accuracy in 910 optimization iterations (tolerance ±300).\n"}
	claims, err := NewHeuristic().ExtractClaims(context.Background(), paper, domain.RepoSummary{})
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Metric != "iterations" || claims[0].ExpectedValue != 910 {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestHeuristicDeduplicatesSameMetricAndValue(t *testing.T) {
	paper := domain.Paper{SourcePath: "paper.md", Text: "The method reaches 95% accuracy in about 910 optimization iterations.\n\nClaim C1: The method reaches 95% accuracy in 910 optimization iterations (tolerance ±300).\n"}
	claims, err := NewHeuristic().ExtractClaims(context.Background(), paper, domain.RepoSummary{})
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Tolerance.Abs != 300 || claims[0].ID != "C1" {
		t.Fatalf("claims = %+v", claims)
	}
}
