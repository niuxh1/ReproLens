package tools

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"time"
)

type DockerRunner struct {
	DockerBinary string
	Network      string
	Memory       string
	CPUs         string
	PIDs         int
	EnableGPU    bool
}

func NewDockerRunner() *DockerRunner {
	return &DockerRunner{DockerBinary: "docker", Network: "none", Memory: "2g", CPUs: "2", PIDs: 256}
}

func NewDockerRunnerWithGPU(enabled bool) *DockerRunner {
	r := NewDockerRunner()
	r.EnableGPU = enabled
	return r
}

func (d *DockerRunner) Name() string { return "docker (isolated)" }

func (d *DockerRunner) BuildArgs(req ExecutionRequest) ([]string, error) {
	if d == nil {
		return nil, fmt.Errorf("docker runner is nil")
	}
	args, err := validateExecutionCommand(req.Command)
	if err != nil {
		return nil, err
	}
	workspace, containerDir, err := resolveWorkDir(req.Workspace, req.WorkDir)
	if err != nil {
		return nil, err
	}
	image := req.Image
	if image == "" {
		image = "python:3.11-slim"
	}
	network := d.Network
	if network == "" {
		network = "none"
	}
	memory := d.Memory
	if memory == "" {
		memory = "2g"
	}
	cpus := d.CPUs
	if cpus == "" {
		cpus = "2"
	}
	pids := d.PIDs
	if pids <= 0 {
		pids = 256
	}
	mount := workspace + ":/workspace"
	out := []string{
		"run", "--rm", "--network", network, "--memory", memory, "--cpus", cpus,
		"--pids-limit", strconv.Itoa(pids), "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
		"-v", mount, "-w", containerDir,
		"-e", "REPROLENS_SEED=" + strconv.Itoa(req.Seed), "-e", "PYTHONHASHSEED=" + strconv.Itoa(req.Seed),
		"-e", "PYTHONUNBUFFERED=1",
	}
	if d.EnableGPU {
		out = append(out, "--gpus", "all", "-e", "NVIDIA_VISIBLE_DEVICES=all", "-e", "CUDA_VISIBLE_DEVICES=0")
	}
	for key, value := range req.Env {
		out = append(out, "-e", key+"="+value)
	}
	out = append(out, image)
	out = append(out, args...)
	return out, nil
}

func (d *DockerRunner) Execute(ctx context.Context, req ExecutionRequest) (ExecutionResult, error) {
	args, err := d.BuildArgs(req)
	if err != nil {
		return ExecutionResult{}, err
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	env := buildExecutionEnv(req)
	result := ExecutionResult{
		Runner: "docker (isolated)", Command: req.Command, Image: req.Image, WorkDir: req.WorkDir, Env: env, GPU: d.EnableGPU,
		StartedAt: time.Now().UTC(),
	}
	cmd := exec.CommandContext(runCtx, d.DockerBinary, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	result.FinishedAt = time.Now().UTC()
	result.DurationMS = result.FinishedAt.Sub(result.StartedAt).Milliseconds()
	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	if runCtx.Err() == context.DeadlineExceeded {
		result.Status = "timeout"
		result.ExitCode = -1
	} else if runErr == nil {
		result.Status = "succeeded"
		result.ExitCode = 0
	} else if exitErr, ok := runErr.(*exec.ExitError); ok {
		result.Status = "failed"
		result.ExitCode = exitErr.ExitCode()
	} else {
		return result, fmt.Errorf("start docker command: %w", runErr)
	}
	if err := writeRunEvidence(req, &result); err != nil {
		return result, err
	}
	return result, nil
}
