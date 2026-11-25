package tools

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reprolens/internal/platformmock"
)

func TestPlatformRunnerSelectsOfferUploadsAndPolls(t *testing.T) {
	server := httptest.NewServer(platformmock.NewHandler())
	defer server.Close()
	ws, err := NewWorkspace(t.TempDir(), "platform_project")
	if err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(ws.Root, "run_experiment.py")
	if err := os.WriteFile(scriptPath, []byte("SEED = 0\nprint('accuracy=0.81')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := NewPlatformRunner(PlatformConfig{
		BaseURL: server.URL, Provider: "colab", Image: "python:3.11-slim",
		MinVRAMGB: 16, MaxHourlyUSD: 0.5, PollInterval: 20 * time.Millisecond,
		Timeout: 10 * time.Second,
	})
	runner.EnableGPU = true
	result, err := runner.Execute(context.Background(), ExecutionRequest{
		ProjectID: "platform_project", RunID: "run_fail", Workspace: ws.Root, EvidenceDir: ws.EvidenceDir,
		Command: "python run_experiment.py --seed 42", WorkDir: ".", Seed: 42, Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || result.OfferID != "colab-t4" || !result.GPU {
		t.Fatalf("failed run result = %+v", result)
	}
	if !strings.Contains(result.Stderr, "seed mismatch") || result.RemoteJobID == "" {
		t.Fatalf("failure evidence = %+v", result)
	}

	if err := os.WriteFile(scriptPath, []byte("SEED = 42\nprint('accuracy=0.81')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err = runner.Execute(context.Background(), ExecutionRequest{
		ProjectID: "platform_project", RunID: "run_pass", Workspace: ws.Root, EvidenceDir: ws.EvidenceDir,
		Command: "python run_experiment.py --seed 42", WorkDir: ".", Seed: 42, Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || !strings.Contains(result.Stdout, "accuracy=0.81") {
		t.Fatalf("success run result = %+v", result)
	}
	if result.OfferID != "colab-t4" || !result.GPU {
		t.Fatalf("selected offer = %+v", result)
	}
}
