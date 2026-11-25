package tools

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"reprolens/internal/domain"
)

func ExtractMetric(stdout string, source domain.MetricSource) (*domain.Metric, error) {
	if source.Kind != "" && source.Kind != "stdout_regex" {
		return nil, fmt.Errorf("unsupported metric source kind %q", source.Kind)
	}
	if source.Pattern == "" {
		return nil, fmt.Errorf("metric regex is empty")
	}
	re, err := regexp.Compile(source.Pattern)
	if err != nil {
		return nil, fmt.Errorf("compile metric regex: %w", err)
	}
	match := re.FindStringSubmatch(stdout)
	if len(match) == 0 {
		return nil, fmt.Errorf("metric not found in stdout")
	}
	raw := match[0]
	if len(match) > 1 && match[1] != "" {
		raw = match[1]
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return nil, fmt.Errorf("parse metric %q: %w", raw, err)
	}
	name := source.Key
	if name == "" {
		name = inferMetricName(source.Pattern)
	}
	return &domain.Metric{Name: name, Value: value, Raw: raw}, nil
}

func VerifyMetric(expected, observed float64, tolerance domain.Tolerance) (domain.Verdict, string) {
	if math.IsNaN(expected) || math.IsNaN(observed) || math.IsInf(expected, 0) || math.IsInf(observed, 0) {
		return domain.VerdictInsufficientEvidence, "non-finite values cannot be verified"
	}
	if tolerance.Abs < 0 || tolerance.Rel < 0 {
		return domain.VerdictInsufficientEvidence, "negative tolerance is invalid"
	}
	diff := math.Abs(observed - expected)
	if tolerance.Abs == 0 && tolerance.Rel == 0 {
		if diff == 0 {
			return domain.VerdictPass, "exact equality"
		}
		return domain.VerdictDifferent, "exact equality failed"
	}
	if tolerance.Abs > 0 && diff <= tolerance.Abs {
		return domain.VerdictPass, fmt.Sprintf("abs_error %.8g <= %.8g", diff, tolerance.Abs)
	}
	if tolerance.Rel > 0 && expected != 0 && diff/math.Abs(expected) <= tolerance.Rel {
		return domain.VerdictPass, fmt.Sprintf("rel_error %.8g <= %.8g", diff/math.Abs(expected), tolerance.Rel)
	}
	parts := make([]string, 0, 2)
	if tolerance.Abs > 0 {
		parts = append(parts, fmt.Sprintf("abs_error %.8g > %.8g", diff, tolerance.Abs))
	}
	if tolerance.Rel > 0 {
		rel := math.Inf(1)
		if expected != 0 {
			rel = diff / math.Abs(expected)
		}
		parts = append(parts, fmt.Sprintf("rel_error %.8g > %.8g", rel, tolerance.Rel))
	}
	return domain.VerdictDifferent, strings.Join(parts, "; ")
}

func VerifyRun(plan domain.ExperimentPlan, run domain.Run) domain.Verification {
	base := domain.Verification{
		ID:         "verify_" + run.ID,
		ClaimID:    plan.ClaimID,
		Metric:     plan.ExpectedMetric,
		Expected:   plan.ExpectedValue,
		Tolerance:  plan.Tolerance,
		VerifiedAt: time.Now().UTC(),
	}
	if run.Status != "succeeded" {
		base.Verdict = domain.VerdictFailed
		base.Note = "the experiment did not complete successfully"
		return base
	}
	metric, err := ExtractMetric(run.Stdout, plan.MetricSource)
	if err != nil {
		base.Verdict = domain.VerdictInsufficientEvidence
		base.Note = err.Error()
		return base
	}
	base.Observed = metric.Value
	base.Verdict, base.Rule = VerifyMetric(plan.ExpectedValue, metric.Value, plan.Tolerance)
	if run.StdoutPath != "" {
		base.Evidence = append(base.Evidence, run.StdoutPath)
	}
	return base
}

func inferMetricName(pattern string) string {
	known := regexp.MustCompile(`(?i)(accuracy|f1|auc|precision|recall|loss|mae|rmse|rouge|bleu)`)
	if match := known.FindString(pattern); match != "" {
		return strings.ToLower(match)
	}
	return "metric"
}
