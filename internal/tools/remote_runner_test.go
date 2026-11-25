package tools

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateWorkspaceArchive(t *testing.T) {
	ws, err := NewWorkspace(t.TempDir(), "archive_project")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(ws.Root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws.Root, "sub", "run.py"), []byte("print('ok')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(ws.Root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws.Root, ".git", "ignored"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "workspace.tar.gz")
	if err := CreateWorkspaceArchive(ws.Root, archive); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	found := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Name == "sub/run.py" {
			data, _ := io.ReadAll(tr)
			if string(data) != "print('ok')\n" {
				t.Fatalf("archive content = %q", data)
			}
			found = true
		}
		if strings.Contains(hdr.Name, ".git") {
			t.Fatalf("archive unexpectedly contains .git: %s", hdr.Name)
		}
	}
	if !found {
		t.Fatal("archive missing sub/run.py")
	}
}

func TestSSHRunnerBuildScriptAndArgs(t *testing.T) {
	r := NewSSHRunnerWithGPU(SSHConfig{
		Host: "asus@127.0.0.1", Port: 2222, Identity: `C:\keys\wsl_rsa`, BaseDir: "/home/asus/reprolens",
	}, true)
	req := ExecutionRequest{
		ProjectID: "proj_1", RunID: "run_1", Command: "python run_experiment.py --seed 42", Seed: 42,
	}
	script := r.BuildRunScript(req, "/home/asus/reprolens/proj_1/run_1")
	for _, want := range []string{"cd '/home/asus/reprolens/proj_1/run_1'", "tar -xzf", "REPROLENS_SEED=42", "CUDA_VISIBLE_DEVICES=0", "python run_experiment.py --seed 42"} {
		if !strings.Contains(script, want) {
			t.Fatalf("script missing %q:\n%s", want, script)
		}
	}
	sshArgs := strings.Join(r.BuildSSHArgs("echo ok"), " ")
	for _, want := range []string{"-p 2222", "-i", "wsl_rsa", "asus@127.0.0.1", "echo ok"} {
		if !strings.Contains(sshArgs, want) {
			t.Fatalf("ssh args missing %q: %s", want, sshArgs)
		}
	}
	scpArgs := strings.Join(r.BuildSCPArgs("local.tar.gz", "/home/asus/reprolens/workspace.tar.gz"), " ")
	for _, want := range []string{"-P 2222", "-i", "wsl_rsa", "local.tar.gz", "asus@127.0.0.1:/home/asus/reprolens/workspace.tar.gz"} {
		if !strings.Contains(scpArgs, want) {
			t.Fatalf("scp args missing %q: %s", want, scpArgs)
		}
	}
}

func TestSSHRunnerWSLIntegration(t *testing.T) {
	if os.Getenv("REPROLENS_TEST_SSH") != "1" {
		t.Skip("set REPROLENS_TEST_SSH=1 to run the WSL SSH integration")
	}
	ws, err := NewWorkspace(t.TempDir(), "ssh_project")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws.Root, "probe.py"), []byte("print('SSH_DEPLOY_OK')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := NewSSHRunner(SSHConfig{
		Host: os.Getenv("REPROLENS_TEST_SSH_HOST"), Port: 2222,
		Identity: os.Getenv("REPROLENS_TEST_SSH_IDENTITY"), BaseDir: "/home/asus/reprolens-test",
	})
	result, err := runner.Execute(context.Background(), ExecutionRequest{
		ProjectID: "ssh_project", RunID: "run_1", Workspace: ws.Root, EvidenceDir: ws.EvidenceDir,
		Command: "python3 probe.py", WorkDir: ".", Seed: 42, Timeout: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || !strings.Contains(result.Stdout, "SSH_DEPLOY_OK") {
		t.Fatalf("result = %+v", result)
	}
}
