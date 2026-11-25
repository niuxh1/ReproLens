package agent

import (
	"context"

	"reprolens/internal/domain"
)

type Analyzer interface {
	ExtractClaims(ctx context.Context, paper domain.Paper, repo domain.RepoSummary) ([]domain.Claim, error)
	BuildPlan(ctx context.Context, claim domain.Claim, paper domain.Paper, repo domain.RepoSummary) (*domain.ExperimentPlan, error)
	Diagnose(ctx context.Context, run domain.Run, repo domain.RepoSummary, workspace string) (*domain.Diagnosis, error)
}
