package tools

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"
)

type LocalRunner struct{}

func NewLocalRunner() *LocalRunner { return &LocalRunner{} }

func (r *LocalRunner) Name() string { return "local (unsafe)" }

func (r *LocalRunner) Execute(ctx context.Context, req ExecutionRequest) (ExecutionResult, error) {
	args, err := validateExecutionCommand(req.Command)
	if err != nil {
		return ExecutionResult{}, err
	}
	dir, _, err := resolveWorkDir(req.Workspace, req.WorkDir)
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
		Runner: "local (unsafe)", Command: req.Command, WorkDir: req.WorkDir, Env: env,
		StartedAt: time.Now().UTC(),
	}
	cmd := exec.CommandContext(runCtx, args[0], args[1:]...)
	cmd.Dir = dir
	cmd.Env = envList(env)
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
		return result, fmt.Errorf("start local command: %w", runErr)
	}
	if err := writeRunEvidence(req, &result); err != nil {
		return result, err
	}
	return result, nil
}
