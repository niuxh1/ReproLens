package tools

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"reprolens/internal/domain"
)

func TestLocalRunnerCapturesOutputAndEvidence(t *testing.T) {
	if _, err := exec.LookPath("python"); err != nil {
		t.Skip("python not available")
	}
	ws, err := NewWorkspace(t.TempDir(), "runner1")
	if err != nil {
		t.Fatal(err)
	}
	runner := NewLocalRunner()
	result, err := runner.Execute(context.Background(), ExecutionRequest{
		RunID:       "run1",
		Workspace:   ws.Root,
		EvidenceDir: ws.EvidenceDir,
		Command:     `python -c "print('accuracy=0.81')"`,
		WorkDir:     ".",
		Seed:        42,
		Timeout:     10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || !strings.Contains(result.Stdout, "accuracy=0.81") {
		t.Fatalf("result = %+v", result)
	}
	if result.StdoutPath == "" || result.StderrPath == "" {
		t.Fatalf("missing log paths: %+v", result)
	}
	if _, err := os.Stat(result.StdoutPath); err != nil {
		t.Fatalf("stdout evidence missing: %v", err)
	}
	if result.Env["REPROLENS_SEED"] != "42" {
		t.Fatalf("env = %+v", result.Env)
	}
}

func TestLocalRunnerRejectsShellComposition(t *testing.T) {
	runner := NewLocalRunner()
	_, err := runner.Execute(context.Background(), ExecutionRequest{
		RunID: "run2", Workspace: t.TempDir(), Command: "python -c \"print(1)\" && echo bad", Timeout: time.Second,
	})
	if err == nil {
		t.Fatal("expected shell composition to be rejected")
	}
}

func TestDockerRunnerBuildsRestrictedArgs(t *testing.T) {
	d := NewDockerRunner()
	d.Network = "none"
	d.Memory = "1g"
	d.CPUs = "1.5"
	d.PIDs = 128
	ws := t.TempDir()
	args, err := d.BuildArgs(ExecutionRequest{
		Workspace: ws, WorkDir: ".", Image: "python:3.11-slim", Seed: 42,
		Command: `python run_experiment.py --seed 42`,
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--network none", "--memory 1g", "--cpus 1.5", "--pids-limit 128", "--cap-drop ALL", "--security-opt no-new-privileges", ws + ":/workspace", "python:3.11-slim", "python run_experiment.py --seed 42"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q: %s", want, joined)
		}
	}
}

func TestVerifyMetricPassDifferentAndInsufficient(t *testing.T) {
	if verdict, _ := VerifyMetric(0.81, 0.815, domain.Tolerance{Abs: 0.01}); verdict != domain.VerdictPass {
		t.Fatalf("absolute tolerance verdict = %s", verdict)
	}
	if verdict, _ := VerifyMetric(100, 103, domain.Tolerance{Rel: 0.05}); verdict != domain.VerdictPass {
		t.Fatalf("relative tolerance verdict = %s", verdict)
	}
	if verdict, _ := VerifyMetric(0.81, 0.70, domain.Tolerance{Abs: 0.01}); verdict != domain.VerdictDifferent {
		t.Fatalf("different verdict = %s", verdict)
	}
	if verdict, _ := VerifyMetric(0, 0, domain.Tolerance{}); verdict != domain.VerdictPass {
		t.Fatalf("exact verdict = %s", verdict)
	}
}

func TestExtractMetricFromStdout(t *testing.T) {
	metric, err := ExtractMetric("training...\naccuracy = 0.812\n", domain.MetricSource{
		Kind: "stdout_regex", Pattern: `(?i)accuracy\s*[:=]\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if metric.Name != "accuracy" || metric.Value != 0.812 {
		t.Fatalf("metric = %+v", metric)
	}
	if _, err := ExtractMetric("no metric here", domain.MetricSource{Kind: "stdout_regex", Pattern: `accuracy=(\d+)`}); err == nil {
		t.Fatal("expected missing metric error")
	}
}
