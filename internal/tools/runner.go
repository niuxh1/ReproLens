package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type ExecutionRequest struct {
	ProjectID   string
	RunID       string
	Workspace   string
	EvidenceDir string
	Command     string
	Image       string
	WorkDir     string
	Seed        int
	Timeout     time.Duration
	Env         map[string]string
}

type ExecutionResult struct {
	Runner      string
	Status      string
	Command     string
	Image       string
	WorkDir     string
	ExitCode    int
	StartedAt   time.Time
	FinishedAt  time.Time
	DurationMS  int64
	Stdout      string
	Stderr      string
	StdoutPath  string
	StderrPath  string
	Env         map[string]string
	GPU         bool
	Provider    string
	RemoteJobID string
	OfferID     string
}

type Runner interface {
	Name() string
	Execute(ctx context.Context, req ExecutionRequest) (ExecutionResult, error)
}

var (
	allowedExecRE = regexp.MustCompile(`(?i)^(python(?:3)?|pytest|rscript|bash|sh|go\s+test|node|uv\s+run|poetry\s+run|pip(?:3)?)(?:\s|$)`)
	runIDRE       = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

func validateExecutionCommand(command string) ([]string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, fmt.Errorf("command is empty")
	}
	if strings.ContainsAny(command, "\r\n") {
		return nil, fmt.Errorf("command must be a single line")
	}
	if strings.Contains(command, "&&") || strings.Contains(command, "||") || strings.Contains(command, ";") ||
		strings.Contains(command, "|") || strings.Contains(command, ">") || strings.Contains(command, "<") ||
		strings.Contains(command, "`") || strings.Contains(command, "$(") || strings.Contains(command, "${") {
		return nil, fmt.Errorf("command contains unsupported shell composition")
	}
	if !allowedExecRE.MatchString(command) {
		return nil, fmt.Errorf("command executable is not allowed")
	}
	args, err := splitCommand(command)
	if err != nil {
		return nil, err
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("command is empty")
	}
	return args, nil
}

func splitCommand(command string) ([]string, error) {
	var args []string
	var b strings.Builder
	quote := rune(0)
	escaped := false
	flush := func() {
		if b.Len() > 0 {
			args = append(args, b.String())
			b.Reset()
		}
	}
	for _, r := range command {
		if escaped {
			b.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			} else {
				b.WriteRune(r)
			}
			continue
		}
		switch r {
		case '\'', '"':
			quote = r
		case ' ', '\t':
			flush()
		default:
			b.WriteRune(r)
		}
	}
	if escaped {
		b.WriteRune('\\')
	}
	if quote != 0 {
		return nil, fmt.Errorf("unterminated quote in command")
	}
	flush()
	return args, nil
}

func resolveWorkDir(workspace, workDir string) (string, string, error) {
	root, err := filepath.Abs(workspace)
	if err != nil {
		return "", "", err
	}
	if workDir == "" {
		workDir = "."
	}
	if filepath.IsAbs(workDir) {
		return "", "", fmt.Errorf("work_dir must be relative")
	}
	full, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(workDir)))
	if err != nil {
		return "", "", err
	}
	rel, err := filepath.Rel(root, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("work_dir escapes workspace")
	}
	info, err := os.Stat(full)
	if err != nil {
		return "", "", fmt.Errorf("work_dir: %w", err)
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("work_dir is not a directory")
	}
	container := "/workspace"
	if rel != "." {
		container = pathJoinContainer(rel)
	}
	return full, container, nil
}

func buildExecutionEnv(req ExecutionRequest) map[string]string {
	env := map[string]string{}
	keys := []string{
		"PATH", "PATHEXT", "SystemRoot", "ComSpec", "WINDIR", "TEMP", "TMP",
		"USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "USER", "LOGNAME",
		"HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "MPLBACKEND",
	}
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			env[key] = value
		}
	}
	env["PYTHONUNBUFFERED"] = "1"
	env["PYTHONIOENCODING"] = "utf-8"
	env["PYTHONHASHSEED"] = fmt.Sprintf("%d", req.Seed)
	env["REPROLENS_SEED"] = fmt.Sprintf("%d", req.Seed)
	for key, value := range req.Env {
		if strings.TrimSpace(key) == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
			continue
		}
		env[key] = value
	}
	return env
}

func envList(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+env[key])
	}
	return out
}

func writeRunEvidence(req ExecutionRequest, result *ExecutionResult) error {
	if req.EvidenceDir == "" {
		return fmt.Errorf("evidence directory is empty")
	}
	if !runIDRE.MatchString(req.RunID) {
		return fmt.Errorf("invalid run id %q", req.RunID)
	}
	dir := filepath.Join(req.EvidenceDir, "runs", req.RunID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	stdoutPath := filepath.Join(dir, "stdout.log")
	stderrPath := filepath.Join(dir, "stderr.log")
	if err := os.WriteFile(stdoutPath, []byte(result.Stdout), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(stderrPath, []byte(result.Stderr), 0o644); err != nil {
		return err
	}
	result.StdoutPath = stdoutPath
	result.StderrPath = stderrPath
	manifest := map[string]any{
		"run_id": req.RunID, "runner": result.Runner, "command": req.Command, "image": req.Image,
		"work_dir": req.WorkDir, "status": result.Status, "exit_code": result.ExitCode,
		"started_at": result.StartedAt, "finished_at": result.FinishedAt, "duration_ms": result.DurationMS,
		"env": result.Env, "stdout": "stdout.log", "stderr": "stderr.log",
		"gpu": result.GPU, "provider": result.Provider, "remote_job_id": result.RemoteJobID, "offer_id": result.OfferID,
	}
	b, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o644)
}

func pathJoinContainer(rel string) string {
	rel = filepath.ToSlash(rel)
	if rel == "." || rel == "" {
		return "/workspace"
	}
	return "/workspace/" + strings.TrimPrefix(rel, "/")
}
