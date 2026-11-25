package demo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMaterializeWritesPaperAndRepo(t *testing.T) {
	paper, repo, err := Materialize(t.TempDir(), "demo1")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(paper)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "accuracy = 0.81") {
		t.Fatalf("paper = %s", data)
	}
	script, err := os.ReadFile(filepath.Join(repo, "run_experiment.py"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(script), "SEED = 0") {
		t.Fatalf("script = %s", script)
	}
}
