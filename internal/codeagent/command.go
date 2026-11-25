package codeagent

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type CommandConfig struct {
	Command       string
	AppendPrompt  bool
	RunAcceptance bool
	Timeout       time.Duration
}

type CommandAgent struct {
	Config CommandConfig
}

func NewCommandAgent(cfg CommandConfig) *CommandAgent {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Minute
	}
	return &CommandAgent{Config: cfg}
}

func (a *CommandAgent) Name() string { return "command-code-agent" }

func (a *CommandAgent) Propose(ctx context.Context, task Task) (*Result, error) {
	if strings.TrimSpace(a.Config.Command) == "" {
		return nil, fmt.Errorf("code agent command is empty")
	}
	if task.Workspace == "" || task.EvidenceDir == "" {
		return nil, fmt.Errorf("workspace and evidence directory are required")
	}
	runID := task.Run.ID
	if runID == "" {
		runID = fmt.Sprintf("run_%d", time.Now().UnixNano())
	}
	evidenceDir := filepath.Join(task.EvidenceDir, "codeagent", runID)
	workDir := filepath.Join(evidenceDir, fmt.Sprintf("workspace_%d", time.Now().UnixNano()))
	if err := os.MkdirAll(evidenceDir, 0o755); err != nil {
		return nil, err
	}
	if err := copyDir(task.Workspace, workDir); err != nil {
		return nil, fmt.Errorf("prepare code-agent workspace: %w", err)
	}
	if err := initGitBaseline(ctx, workDir); err != nil {
		return nil, fmt.Errorf("initialize code-agent baseline: %w", err)
	}
	prompt := buildPrompt(task)
	promptPath := filepath.Join(evidenceDir, "prompt.txt")
	if err := os.WriteFile(promptPath, []byte(prompt), 0o644); err != nil {
		return nil, err
	}
	args, err := splitCommand(a.Config.Command)
	if err != nil {
		return nil, err
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("code agent command is empty")
	}
	runCtx, cancel := context.WithTimeout(ctx, a.Config.Timeout)
	defer cancel()
	if a.Config.AppendPrompt {
		args = append(args, prompt)
	}
	cmd := exec.CommandContext(runCtx, args[0], args[1:]...)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(), "REPROLENS_CODE_PROMPT_FILE="+promptPath, "REPROLENS_CODE_WORKSPACE="+workDir)
	if !a.Config.AppendPrompt {
		cmd.Stdin = strings.NewReader(prompt)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	started := time.Now()
	runErr := cmd.Run()
	duration := time.Since(started)
	agentLog := filepath.Join(evidenceDir, "agent.log")
	_ = os.WriteFile(agentLog, []byte("STDOUT:\n"+stdout.String()+"\nSTDERR:\n"+stderr.String()), 0o644)
	if runErr != nil {
		if runCtx.Err() != nil {
			return nil, fmt.Errorf("code agent timed out: %w", runCtx.Err())
		}
		return nil, fmt.Errorf("code agent failed: %v (log: %s)", runErr, agentLog)
	}
	if a.Config.RunAcceptance && strings.TrimSpace(task.AcceptanceCommand) != "" {
		acceptOut, acceptErr := runShell(runCtx, workDir, task.AcceptanceCommand)
		_ = os.WriteFile(filepath.Join(evidenceDir, "acceptance.log"), []byte(acceptOut), 0o644)
		if acceptErr != nil {
			return nil, fmt.Errorf("code agent acceptance command failed: %v (log: %s)", acceptErr, filepath.Join(evidenceDir, "acceptance.log"))
		}
	}
	if err := execGit(runCtx, workDir, "add", "-N", "."); err != nil {
		return nil, fmt.Errorf("prepare diff: %w", err)
	}
	diff, err := captureGit(runCtx, workDir, "diff", "--binary", "HEAD", "--", ".")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(diff) == "" {
		return nil, fmt.Errorf("code agent produced no file changes")
	}
	nameList, err := captureGit(runCtx, workDir, "diff", "--name-only", "HEAD", "--", ".")
	if err != nil {
		return nil, err
	}
	files := splitLines(nameList)
	if len(files) == 0 {
		return nil, fmt.Errorf("code agent diff has no files")
	}
	diffPath := filepath.Join(evidenceDir, "diff.patch")
	if err := os.WriteFile(diffPath, []byte(diff), 0o644); err != nil {
		return nil, err
	}
	return &Result{
		Agent: "command", Version: a.Config.Command, Diff: diff, Files: files,
		Summary: "delegated code changes from configured command agent", Stdout: stdout.String(),
		Stderr: stderr.String(), LogPath: agentLog, Duration: duration,
	}, nil
}

func copyDir(source, dest string) error {
	source, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return filepath.WalkDir(source, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == source {
			return nil
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", ".reprolens", "__pycache__", ".pytest_cache", "node_modules", ".venv", "venv":
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(dest, rel), 0o755)
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		out, err := os.OpenFile(filepath.Join(dest, rel), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			_ = in.Close()
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeInErr := in.Close()
		closeOutErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeInErr != nil {
			return closeInErr
		}
		return closeOutErr
	})
}

func initGitBaseline(ctx context.Context, dir string) error {
	if err := execGit(ctx, dir, "init", "-q"); err != nil {
		return err
	}
	exclude := ".reprolens/\n__pycache__/\n*.pyc\n.pytest_cache/\n"
	if err := os.WriteFile(filepath.Join(dir, ".git", "info", "exclude"), []byte(exclude), 0o644); err != nil {
		return err
	}
	if err := execGit(ctx, dir, "config", "user.email", "reprolens@local"); err != nil {
		return err
	}
	if err := execGit(ctx, dir, "config", "user.name", "ReproLens CodeAgent"); err != nil {
		return err
	}
	if err := execGit(ctx, dir, "add", "-A"); err != nil {
		return err
	}
	return execGit(ctx, dir, "commit", "-q", "-m", "baseline")
}

func execGit(ctx context.Context, dir string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(out.String()))
	}
	return nil
}

func captureGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(errOut.String()))
	}
	return out.String(), nil
}

func runShell(ctx context.Context, dir, command string) (string, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

func splitLines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			out = append(out, line)
		}
	}
	return out
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
		return nil, fmt.Errorf("unterminated quote in code agent command")
	}
	flush()
	return args, nil
}

func buildPrompt(task Task) string {
	var b strings.Builder
	b.WriteString("You are a professional code implementation agent working inside a disposable copy of a research repository.\n")
	b.WriteString("Implement or repair the missing experiment code needed to reproduce the selected paper claim.\n\n")
	b.WriteString("Hard constraints:\n")
	b.WriteString("- Modify only files inside the current working directory.\n")
	b.WriteString("- Do not change the paper's expected value, tolerance, data split, metric definition, or claim.\n")
	b.WriteString("- Keep changes minimal and preserve existing public behavior where possible.\n")
	b.WriteString("- Do not commit changes.\n")
	b.WriteString("- Run relevant tests if possible and report the commands and results in your final response.\n\n")
	fmt.Fprintf(&b, "Project: %s\nClaim: %s\nMetric: %s\nExpected: %g\nTolerance: abs=%g rel=%g\nPlan command: %s\nAcceptance command: %s\n\n",
		task.ProjectID, task.Claim.ID, task.Claim.Metric, task.Claim.ExpectedValue, task.Claim.Tolerance.Abs, task.Claim.Tolerance.Rel, task.Plan.Command, task.AcceptanceCommand)
	b.WriteString("Diagnosis:\n")
	fmt.Fprintf(&b, "class=%s\nroot_cause=%s\nexplanation=%s\nneeds_code_agent=%v\n\n", task.Diagnosis.FailureClass, task.Diagnosis.RootCause, task.Diagnosis.Explanation, task.Diagnosis.NeedsCodeAgent)
	b.WriteString("Failed run stdout:\n")
	b.WriteString(truncate(task.Run.Stdout, 8000))
	b.WriteString("\nFailed run stderr:\n")
	b.WriteString(truncate(task.Run.Stderr, 8000))
	b.WriteString("\n\nPaper excerpt:\n")
	b.WriteString(truncate(task.Paper.Text, 12000))
	b.WriteString("\n\nWhen finished, provide a concise summary of files changed, tests run, and remaining risks.\n")
	return b.String()
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n...[truncated]"
}
