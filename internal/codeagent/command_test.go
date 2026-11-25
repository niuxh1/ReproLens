package codeagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reprolens/internal/domain"
	"reprolens/internal/tools"
)

func TestCommandAgentProducesDiffAndRunsAcceptance(t *testing.T) {
	ws, err := tools.NewWorkspace(t.TempDir(), "codeagent_project")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws.Root, "run.py"), []byte("print('accuracy=0.50')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	agentScript := `from pathlib import Path
import sys
Path("run.py").write_text("print('accuracy=0.81')\n")
Path("implementation.py").write_text("def solve():\n    return 42\n")
print("prompt_received=" + str(len(sys.argv) > 1))
`
	if err := os.WriteFile(filepath.Join(ws.Root, "fake_agent.py"), []byte(agentScript), 0o644); err != nil {
		t.Fatal(err)
	}
	agent := NewCommandAgent(CommandConfig{
		Command: "python fake_agent.py", AppendPrompt: true, Timeout: 20 * time.Second,
	})
	task := Task{
		ProjectID: "codeagent_project", ClaimID: "C1", Workspace: ws.Root, EvidenceDir: ws.EvidenceDir,
		Claim: domain.Claim{ID: "C1", Metric: "accuracy", ExpectedValue: 0.81},
		Plan: domain.ExperimentPlan{ClaimID: "C1", Command: "python run.py"},
		Run: domain.Run{ID: "run_1", Status: "failed", Stderr: "missing implementation"},
		Diagnosis: domain.Diagnosis{FailureClass: "missing_implementation", NeedsCodeAgent: true},
		AcceptanceCommand: "python run.py",
	}
	result, err := agent.Propose(context.Background(), task)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"+print('accuracy=0.81')", "+def solve():", "+    return 42"} {
		if !strings.Contains(result.Diff, want) {
			t.Fatalf("diff missing %q:\n%s", want, result.Diff)
		}
	}
	if len(result.Files) != 2 {
		t.Fatalf("files = %+v", result.Files)
	}
	if result.LogPath == "" {
		t.Fatal("expected agent log path")
	}
	pm := &tools.PatchManager{Workspace: ws.Root}
	if _, err := pm.Apply(result.Diff); err != nil {
		t.Fatalf("apply delegated diff: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(ws.Root, "implementation.py"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "return 42") {
		t.Fatalf("new implementation = %s", data)
	}
}