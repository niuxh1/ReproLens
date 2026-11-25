package tools

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceContainsPathsAndCopiesRepo(t *testing.T) {
	dataDir := t.TempDir()
	ws, err := NewWorkspace(dataDir, "p1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.ResolvePath("../escape.txt"); err == nil {
		t.Fatal("expected traversal to be rejected")
	}
	if _, err := ws.ResolvePath(filepath.Join("nested", "..", "ok.txt")); err != nil {
		t.Fatalf("valid relative path rejected: %v", err)
	}

	src := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "README.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ws.CopyRepo(src); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(ws.Root, "README.md")); err != nil {
		t.Fatalf("README not copied: %v", err)
	}
}

func TestParsePaperExtractsDocxText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "paper.docx")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	xml := `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Claim C1: accuracy = 0.81</w:t></w:r></w:p><w:p><w:r><w:t>tolerance ±0.01</w:t></w:r></w:p></w:body></w:document>`
	if _, err := w.Write([]byte(xml)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	paper, err := ParsePaper(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(paper.Text, "Claim C1") || !strings.Contains(paper.Text, "0.81") {
		t.Fatalf("paper text = %q", paper.Text)
	}
	if paper.SHA256 == "" {
		t.Fatal("expected sha256")
	}
}

func TestScanRepoFindsReadmeCommandAndFiles(t *testing.T) {
	dir := t.TempDir()
	readme := "# Demo\n\n```bash\npython train.py --seed 42\n```\n"
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readme), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "train.py"), []byte("print('ok')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "requirements.txt"), []byte("numpy==1.26\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	repo, err := ScanRepo(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(repo.Readme, "python train.py") {
		t.Fatalf("readme = %q", repo.Readme)
	}
	if len(repo.CommandCandidates) == 0 || repo.CommandCandidates[0] != "python train.py --seed 42" {
		t.Fatalf("commands = %+v", repo.CommandCandidates)
	}
	if len(repo.Requirements) != 1 || repo.Requirements[0] != "numpy==1.26" {
		t.Fatalf("requirements = %+v", repo.Requirements)
	}
	if !contains(repo.Files, "train.py") {
		t.Fatalf("files = %+v", repo.Files)
	}
}

func TestPatchManagerRejectsTraversalAndAppliesValidDiff(t *testing.T) {
	ws, err := NewWorkspace(t.TempDir(), "p2")
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(ws.Root, "run_experiment.py")
	if err := os.WriteFile(script, []byte("import sys\nSEED = 0\nprint('accuracy=0.50')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pm := &PatchManager{Workspace: ws.Root}
	traversal := "--- a/../escape.py\n+++ b/../escape.py\n@@ -1 +1 @@\n-x\n+y\n"
	if _, err := pm.Validate(traversal); err == nil {
		t.Fatal("expected traversal patch rejection")
	}
	diff := "--- a/run_experiment.py\n+++ b/run_experiment.py\n@@ -1,3 +1,3 @@\n import sys\n-SEED = 0\n+SEED = 42\n print('accuracy=0.50')\n"
	files, err := pm.Apply(diff)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0] != "run_experiment.py" {
		t.Fatalf("files = %+v", files)
	}
	got, err := os.ReadFile(script)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "SEED = 42") {
		t.Fatalf("patched content = %s", got)
	}
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
