package agent

import (
	"context"
	"fmt"

	"reprolens/internal/domain"
)

type FallbackAnalyzer struct {
	Primary    Analyzer
	Secondary  Analyzer
	OnFallback func(error)
}

func NewFallbackAnalyzer(primary, secondary Analyzer, onFallback func(error)) *FallbackAnalyzer {
	return &FallbackAnalyzer{Primary: primary, Secondary: secondary, OnFallback: onFallback}
}

func (f *FallbackAnalyzer) ExtractClaims(ctx context.Context, paper domain.Paper, repo domain.RepoSummary) ([]domain.Claim, error) {
	if f.Primary != nil {
		claims, err := f.Primary.ExtractClaims(ctx, paper, repo)
		if err == nil && len(claims) > 0 {
			return claims, nil
		}
		f.fallback(err)
	}
	if f.Secondary == nil {
		return nil, fmt.Errorf("no analyzer available")
	}
	return f.Secondary.ExtractClaims(ctx, paper, repo)
}

func (f *FallbackAnalyzer) BuildPlan(ctx context.Context, claim domain.Claim, paper domain.Paper, repo domain.RepoSummary) (*domain.ExperimentPlan, error) {
	if f.Primary != nil {
		plan, err := f.Primary.BuildPlan(ctx, claim, paper, repo)
		if err == nil && plan != nil && plan.Command != "" {
			return plan, nil
		}
		f.fallback(err)
	}
	if f.Secondary == nil {
		return nil, fmt.Errorf("no analyzer available")
	}
	return f.Secondary.BuildPlan(ctx, claim, paper, repo)
}

func (f *FallbackAnalyzer) Diagnose(ctx context.Context, run domain.Run, repo domain.RepoSummary, workspace string) (*domain.Diagnosis, error) {
	if f.Primary != nil {
		diagnosis, err := f.Primary.Diagnose(ctx, run, repo, workspace)
		if err == nil && diagnosis != nil && diagnosis.FailureClass != "" {
			if diagnosis.PatchDiff == "" && f.Secondary != nil {
				secondaryDiagnosis, secondaryErr := f.Secondary.Diagnose(ctx, run, repo, workspace)
				if secondaryErr == nil && secondaryDiagnosis != nil && secondaryDiagnosis.PatchDiff != "" {
					f.fallback(fmt.Errorf("primary diagnosis had no safe patch"))
					return secondaryDiagnosis, nil
				}
			}
			return diagnosis, nil
		}
		f.fallback(err)
	}
	if f.Secondary == nil {
		return nil, fmt.Errorf("no analyzer available")
	}
	return f.Secondary.Diagnose(ctx, run, repo, workspace)
}

func (f *FallbackAnalyzer) fallback(err error) {
	if f.OnFallback != nil {
		if err == nil {
			err = fmt.Errorf("primary analyzer returned no usable result")
		}
		f.OnFallback(err)
	}
}
