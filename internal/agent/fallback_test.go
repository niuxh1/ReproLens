package agent

import (
	"context"
	"errors"
	"testing"

	"reprolens/internal/domain"
)

type stubAnalyzer struct {
	claims []domain.Claim
	plan   *domain.ExperimentPlan
	diag   *domain.Diagnosis
	err    error
}

func (s stubAnalyzer) ExtractClaims(context.Context, domain.Paper, domain.RepoSummary) ([]domain.Claim, error) {
	return s.claims, s.err
}
func (s stubAnalyzer) BuildPlan(context.Context, domain.Claim, domain.Paper, domain.RepoSummary) (*domain.ExperimentPlan, error) {
	return s.plan, s.err
}
func (s stubAnalyzer) Diagnose(context.Context, domain.Run, domain.RepoSummary, string) (*domain.Diagnosis, error) {
	return s.diag, s.err
}

func TestFallbackAnalyzerSwitchesToHeuristicOnPrimaryFailure(t *testing.T) {
	primary := stubAnalyzer{err: errors.New("local API unavailable")}
	secondary := stubAnalyzer{claims: []domain.Claim{{ID: "C1"}}, plan: &domain.ExperimentPlan{Command: "python run.py"}, diag: &domain.Diagnosis{FailureClass: "unknown"}}
	a := NewFallbackAnalyzer(primary, secondary, nil)
	claims, err := a.ExtractClaims(context.Background(), domain.Paper{}, domain.RepoSummary{})
	if err != nil || len(claims) != 1 {
		t.Fatalf("claims = %+v err=%v", claims, err)
	}
	plan, err := a.BuildPlan(context.Background(), domain.Claim{ID: "C1"}, domain.Paper{}, domain.RepoSummary{})
	if err != nil || plan.Command != "python run.py" {
		t.Fatalf("plan = %+v err=%v", plan, err)
	}
	diag, err := a.Diagnose(context.Background(), domain.Run{}, domain.RepoSummary{}, "")
	if err != nil || diag.FailureClass != "unknown" {
		t.Fatalf("diagnosis = %+v err=%v", diag, err)
	}
}
func TestFallbackAnalyzerUsesSecondaryPatchWhenPrimaryOmitsPatch(t *testing.T) {
	primary := stubAnalyzer{diag: &domain.Diagnosis{FailureClass: "seed_mismatch", RootCause: "seed was not propagated"}}
	secondary := stubAnalyzer{diag: &domain.Diagnosis{FailureClass: "seed_mismatch", RootCause: "seed mismatch", PatchDiff: "--- a/run.py\n+++ b/run.py\n@@ -1 +1 @@\n-SEED = 0\n+SEED = 42\n"}}
	a := NewFallbackAnalyzer(primary, secondary, nil)
	diag, err := a.Diagnose(context.Background(), domain.Run{}, domain.RepoSummary{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if diag.PatchDiff == "" {
		t.Fatalf("expected fallback patch, got %+v", diag)
	}
}
