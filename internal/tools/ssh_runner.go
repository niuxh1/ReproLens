package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type SSHConfig struct {
	Host      string
	Port      int
	Identity  string
	BaseDir   string
	SSHBinary string
	SCPBinary string
}

type SSHRunner struct {
	Config    SSHConfig
	EnableGPU bool
}

func NewSSHRunner(cfg SSHConfig) *SSHRunner {
	if cfg.Port == 0 {
		cfg.Port = 22
	}
	if cfg.BaseDir == "" {
		cfg.BaseDir = "/tmp/reprolens"
	}
	if cfg.SSHBinary == "" {
		cfg.SSHBinary = "ssh"
	}
	if cfg.SCPBinary == "" {
		cfg.SCPBinary = "scp"
	}
	return &SSHRunner{Config: cfg}
}

func NewSSHRunnerWithGPU(cfg SSHConfig, enabled bool) *SSHRunner {
	r := NewSSHRunner(cfg)
	r.EnableGPU = enabled
	return r
}

func (r *SSHRunner) Name() string { return "ssh (remote host)" }

func (r *SSHRunner) BuildSSHArgs(remoteCommand string) []string {
	args := []string{"-p", strconv.Itoa(r.Config.Port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"}
	if r.Config.Identity != "" {
		args = append(args, "-i", r.Config.Identity)
	}
	return append(args, r.Config.Host, remoteCommand)
}

func (r *SSHRunner) BuildSCPArgs(source, dest string) []string {
	args := []string{"-O", "-P", strconv.Itoa(r.Config.Port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"}
	if r.Config.Identity != "" {
		args = append(args, "-i", r.Config.Identity)
	}
	return append(args, source, r.Config.Host+":"+dest)
}

func (r *SSHRunner) BuildRunScript(req ExecutionRequest, remoteDir string) string {
	var b strings.Builder
	b.WriteString("#!/usr/bin/env bash\n")
	b.WriteString("set -euo pipefail\n")
	b.WriteString("export PATH=\"$PATH:/usr/lib/wsl/lib\"\n")
	b.WriteString("cd " + shellQuote(remoteDir) + "\n")
	b.WriteString("tar -xzf " + shellQuote(path.Join(remoteDir, "workspace.tar.gz")) + "\n")
	b.WriteString("rm -f " + shellQuote(path.Join(remoteDir, "workspace.tar.gz")) + "\n")
	fmt.Fprintf(&b, "export REPROLENS_SEED=%d\n", req.Seed)
	fmt.Fprintf(&b, "export PYTHONHASHSEED=%d\n", req.Seed)
	b.WriteString("export PYTHONUNBUFFERED=1\n")
	b.WriteString("export PYTHONIOENCODING=utf-8\n")
	b.WriteString("export MPLBACKEND=Agg\n")
	if r.EnableGPU {
		b.WriteString("export CUDA_VISIBLE_DEVICES=0\n")
		b.WriteString("export NVIDIA_VISIBLE_DEVICES=all\n")
	}
	keys := make([]string, 0, len(req.Env))
	for key := range req.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if key == "" || strings.ContainsAny(key, "=;\n") {
			continue
		}
		fmt.Fprintf(&b, "export %s=%s\n", key, shellQuote(req.Env[key]))
	}
	b.WriteString(req.Command)
	b.WriteString("\n")
	return b.String()
}

func (r *SSHRunner) Execute(ctx context.Context, req ExecutionRequest) (ExecutionResult, error) {
	if r.Config.Host == "" || strings.ContainsAny(r.Config.Host, " \t\r\n") {
		return ExecutionResult{}, fmt.Errorf("invalid SSH host")
	}
	if !workspaceIDRE.MatchString(req.ProjectID) || !runIDRE.MatchString(req.RunID) {
		return ExecutionResult{}, fmt.Errorf("invalid project or run id")
	}
	if _, err := validateExecutionCommand(req.Command); err != nil {
		return ExecutionResult{}, err
	}
	if req.Workspace == "" || req.EvidenceDir == "" {
		return ExecutionResult{}, fmt.Errorf("workspace and evidence directory are required")
	}
	if !strings.HasPrefix(r.Config.BaseDir, "/") {
		return ExecutionResult{}, fmt.Errorf("SSH base dir must be an absolute POSIX path")
	}
	remoteDir := path.Join(r.Config.BaseDir, "reprolens", req.ProjectID, req.RunID)
	if err := os.MkdirAll(filepath.Join(req.EvidenceDir, "remote", req.RunID), 0o755); err != nil {
		return ExecutionResult{}, err
	}
	archivePath := filepath.Join(req.EvidenceDir, "remote", req.RunID, "workspace.tar.gz")
	if err := CreateWorkspaceArchive(req.Workspace, archivePath); err != nil {
		return ExecutionResult{}, err
	}
	script := r.BuildRunScript(req, remoteDir)
	scriptPath := filepath.Join(req.EvidenceDir, "remote", req.RunID, "run.sh")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		return ExecutionResult{}, err
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	started := time.Now().UTC()
	if err := r.runInfrastructure(runCtx, r.Config.SSHBinary, r.BuildSSHArgs("mkdir -p "+shellQuote(remoteDir))); err != nil {
		return ExecutionResult{}, err
	}
	if err := r.runInfrastructure(runCtx, r.Config.SCPBinary, r.BuildSCPArgs(archivePath, path.Join(remoteDir, "workspace.tar.gz"))); err != nil {
		return ExecutionResult{}, err
	}
	if err := r.runInfrastructure(runCtx, r.Config.SCPBinary, r.BuildSCPArgs(scriptPath, path.Join(remoteDir, "run.sh"))); err != nil {
		return ExecutionResult{}, err
	}
	stdout, stderr, exitCode, runErr := runCaptured(runCtx, r.Config.SSHBinary, r.BuildSSHArgs("bash "+shellQuote(path.Join(remoteDir, "run.sh"))))
	finished := time.Now().UTC()
	result := ExecutionResult{
		Runner: "ssh (remote host)", Provider: "ssh", RemoteJobID: req.RunID, Command: req.Command,
		WorkDir: req.WorkDir, ExitCode: exitCode, StartedAt: started, FinishedAt: finished,
		DurationMS: finished.Sub(started).Milliseconds(), Stdout: stdout, Stderr: stderr,
		Env: buildExecutionEnv(req), GPU: r.EnableGPU,
	}
	if runCtx.Err() == context.DeadlineExceeded {
		result.Status = "timeout"
		result.ExitCode = -1
	} else if runErr == nil {
		result.Status = "succeeded"
		result.ExitCode = 0
	} else if errors.Is(runErr, context.Canceled) {
		result.Status = "failed"
	} else {
		result.Status = "failed"
	}
	if err := writeRunEvidence(req, &result); err != nil {
		return result, err
	}
	return result, nil
}

func (r *SSHRunner) runInfrastructure(ctx context.Context, binary string, args []string) error {
	cmd := exec.CommandContext(ctx, binary, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %v: %s", binary, err, strings.TrimSpace(out.String()))
	}
	return nil
}

func runCaptured(ctx context.Context, binary string, args []string) (string, string, int, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return stdout.String(), stderr.String(), exitCode, err
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
