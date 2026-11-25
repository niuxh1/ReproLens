package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"reprolens/internal/agent"
	"reprolens/internal/codeagent"
	"reprolens/internal/config"
	"reprolens/internal/demo"
	"reprolens/internal/domain"
	"reprolens/internal/httpapi"
	"reprolens/internal/orchestrator"
	"reprolens/internal/platformmock"
	"reprolens/internal/store"
	"reprolens/internal/tools"
)

func main() {
	logger := log.New(os.Stdout, "reprolens ", log.LstdFlags)
	envFile := os.Getenv("REPROLENS_ENV_FILE")
	if envFile == "" {
		envFile = ".env"
	}
	cfg, err := config.Load(envFile)
	if err != nil {
		logger.Fatalf("configuration: %v", err)
	}
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "serve":
		if err := serve(cfg, logger); err != nil {
			logger.Fatal(err)
		}
	case "demo":
		fs := flag.NewFlagSet("demo", flag.ExitOnError)
		autoApprove := fs.Bool("auto-approve", false, "approve the proposed patch automatically for a non-interactive demo")
		if err := fs.Parse(os.Args[2:]); err != nil {
			logger.Fatal(err)
		}
		if err := runDemo(cfg, logger, *autoApprove); err != nil {
			logger.Fatal(err)
		}
	case "colab-demo":
		fs := flag.NewFlagSet("colab-demo", flag.ExitOnError)
		platformURL := fs.String("platform-url", "", "optional real Colab-compatible platform base URL; empty starts the local mock")
		if err := fs.Parse(os.Args[2:]); err != nil {
			logger.Fatal(err)
		}
		if err := runColabDemo(cfg, logger, *platformURL); err != nil {
			logger.Fatal(err)
		}
	case "ssh-demo":
		fs := flag.NewFlagSet("ssh-demo", flag.ExitOnError)
		host := fs.String("host", envOr("REPROLENS_SSH_HOST", "asus@127.0.0.1"), "SSH target")
		port := fs.Int("port", envIntOr("REPROLENS_SSH_PORT", 2222), "SSH port")
		identity := fs.String("identity", envOr("REPROLENS_SSH_IDENTITY", ""), "SSH identity file")
		baseDir := fs.String("base-dir", envOr("REPROLENS_SSH_BASE_DIR", "/home/asus/reprolens-test"), "remote base directory")
		gpu := fs.Bool("gpu", false, "export CUDA_VISIBLE_DEVICES on the remote host")
		if err := fs.Parse(os.Args[2:]); err != nil {
			logger.Fatal(err)
		}
		if err := runSSHDemo(cfg, logger, *host, *port, *identity, *baseDir, *gpu); err != nil {
			logger.Fatal(err)
		}
	case "mock-colab":
		fs := flag.NewFlagSet("mock-colab", flag.ExitOnError)
		addr := fs.String("addr", "127.0.0.1:8789", "mock platform listen address")
		if err := fs.Parse(os.Args[2:]); err != nil {
			logger.Fatal(err)
		}
		logger.Printf("mock Colab platform listening on http://%s", *addr)
		if err := http.ListenAndServe(*addr, platformmock.NewHandler()); err != nil {
			logger.Fatal(err)
		}
	case "check-llm":
		if err := checkLLM(cfg); err != nil {
			logger.Fatal(err)
		}
	case "version":
		fmt.Println("ReproLens 0.1.0")
	default:
		fmt.Println("usage: reprolens [serve|demo|colab-demo|ssh-demo|mock-colab|check-llm|version]")
		os.Exit(2)
	}
}

func serve(cfg config.Config, logger *log.Logger) error {
	orch, closer, err := buildOrchestrator(cfg, logger)
	if err != nil {
		return err
	}
	defer closer()
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.NewServer(orch, cfg.DataDir).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	errCh := make(chan error, 1)
	go func() {
		logger.Printf("listening on http://%s", cfg.Addr)
		errCh <- server.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}

func runDemo(cfg config.Config, logger *log.Logger, autoApprove bool) error {
	orch, closer, err := buildOrchestrator(cfg, logger)
	if err != nil {
		return err
	}
	defer closer()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	demoID := fmt.Sprintf("cli_demo_%d", time.Now().UnixNano())
	paperPath, repoPath, err := demo.Materialize(cfg.DataDir, demoID)
	if err != nil {
		return err
	}
	project, err := orch.CreateProject(ctx, orchestrator.CreateInput{
		Name: "CLI accuracy reproduction demo", PaperPath: paperPath, RepoPath: repoPath,
		Budget: domain.Budget{MaxRuns: 3, MaxSeconds: 60, MaxPatches: 2},
	})
	if err != nil {
		return err
	}
	project, err = orch.Start(ctx, project.ID)
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}
	if len(project.Claims) == 0 {
		return fmt.Errorf("demo produced no claims")
	}
	project, err = orch.SelectClaims(ctx, project.ID, []string{project.Claims[0].ID})
	if err != nil {
		return fmt.Errorf("select claims: %w", err)
	}
	project, err = orch.ConfirmPlan(ctx, project.ID)
	if err != nil {
		return fmt.Errorf("confirm plan: %w", err)
	}
	if project.State == domain.StateAwaitingPatch {
		if project.Patch == nil {
			return fmt.Errorf("workflow is awaiting a patch but no patch is available")
		}
		fmt.Println("Patch proposal:")
		fmt.Println(project.Patch.Diff)
		approved := autoApprove
		if !autoApprove {
			fmt.Print("Apply this patch and retry? [y/N] ")
			reader := bufio.NewReader(os.Stdin)
			answer, _ := reader.ReadString('\n')
			approved = strings.EqualFold(strings.TrimSpace(answer), "y") || strings.EqualFold(strings.TrimSpace(answer), "yes")
		}
		if !approved {
			fmt.Printf("Workflow paused at %s. Project: %s\n", project.State, project.ID)
			return nil
		}
		project, err = orch.ApprovePatch(ctx, project.ID, "cli-user")
		if err != nil {
			return fmt.Errorf("approve patch: %w", err)
		}
	}
	printProjectResult(project)
	return nil
}

func printProjectResult(project *domain.Project) {
	fmt.Printf("Project:   %s\n", project.ID)
	fmt.Printf("State:     %s\n", project.State)
	if project.Verification != nil {
		v := project.Verification
		fmt.Printf("Verdict:   %s (%s: observed %g, expected %g)\n", v.Verdict, v.Metric, v.Observed, v.Expected)
		fmt.Printf("Rule:      %s\n", v.Rule)
	}
	fmt.Printf("Runs:      %d\n", len(project.Runs))
	if project.Report != nil {
		fmt.Printf("Report:    %s\n", filepath.Clean(project.Report.PackagePath))
	}
	if project.Error != "" {
		fmt.Printf("Error:     %s\n", project.Error)
	}
}

func checkLLM(cfg config.Config) error {
	if cfg.LLM.BaseURL == "" {
		return fmt.Errorf("REPROLENS_LLM_BASE_URL is not configured")
	}
	analyzer, err := agent.NewOpenAICompatible(cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model, cfg.LLM.Timeout)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), cfg.LLM.Timeout)
	defer cancel()
	paper := domain.Paper{SourcePath: "probe.md", Text: "# Probe\n\nClaim C1: accuracy = 0.81 (tolerance ±0.01).\n"}
	claims, err := analyzer.ExtractClaims(ctx, paper, domain.RepoSummary{})
	if err != nil {
		return err
	}
	b, _ := json.MarshalIndent(claims, "", "  ")
	fmt.Printf("LLM OK: %s / %s\n%s\n", cfg.LLM.BaseURL, cfg.LLM.Model, b)
	return nil
}

func buildOrchestrator(cfg config.Config, logger *log.Logger) (*orchestrator.Orchestrator, func(), error) {
	runner, err := buildRunner(cfg, logger)
	if err != nil {
		return nil, nil, err
	}
	return buildOrchestratorWithRunner(cfg, logger, runner)
}

func buildOrchestratorWithRunner(cfg config.Config, logger *log.Logger, runner tools.Runner) (*orchestrator.Orchestrator, func(), error) {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, nil, err
	}
	persisted, err := store.NewSQLite(filepath.Join(cfg.DataDir, "reprolens.db"))
	if err != nil {
		return nil, nil, err
	}
	analyzer := buildAnalyzer(cfg, logger)
	orch := orchestrator.New(persisted, analyzer, runner, cfg.DataDir)
	if cfg.CodeAgent.Type != "" && cfg.CodeAgent.Type != "none" {
		orch.SetCodeAgent(codeagent.NewCommandAgent(codeagent.CommandConfig{
			Command: cfg.CodeAgent.Command, AppendPrompt: true, RunAcceptance: cfg.CodeAgent.RunAcceptance, Timeout: cfg.CodeAgent.Timeout,
		}))
		logger.Printf("code agent enabled: %s (%s)", cfg.CodeAgent.Type, cfg.CodeAgent.Command)
	}
	return orch, func() { _ = persisted.Close() }, nil
}

func buildAnalyzer(cfg config.Config, logger *log.Logger) agent.Analyzer {
	heuristic := agent.NewHeuristic()
	if cfg.LLM.BaseURL == "" {
		logger.Printf("LLM disabled; using deterministic heuristic analyzer")
		return heuristic
	}
	remote, err := agent.NewOpenAICompatible(cfg.LLM.BaseURL, cfg.LLM.APIKey, cfg.LLM.Model, cfg.LLM.Timeout)
	if err != nil {
		logger.Printf("LLM configuration rejected, using heuristic analyzer: %v", err)
		return heuristic
	}
	logger.Printf("LLM analyzer: %s (%s), heuristic fallback enabled", cfg.LLM.Model, cfg.LLM.BaseURL)
	return agent.NewFallbackAnalyzer(remote, heuristic, func(err error) {
		logger.Printf("LLM fallback: %v", err)
	})
}

func buildRunner(cfg config.Config, logger *log.Logger) (tools.Runner, error) {
	switch cfg.Runner {
	case "local":
		logger.Printf("runner=local gpu=%v", cfg.EnableGPU)
		return tools.NewLocalRunnerWithGPU(cfg.EnableGPU), nil
	case "docker":
		logger.Printf("runner=docker gpu=%v", cfg.EnableGPU)
		return tools.NewDockerRunnerWithGPU(cfg.EnableGPU), nil
	case "ssh":
		logger.Printf("runner=ssh host=%s gpu=%v", cfg.Remote.Host, cfg.EnableGPU)
		return tools.NewSSHRunnerWithGPU(tools.SSHConfig{
			Host: cfg.Remote.Host, Port: cfg.Remote.Port, Identity: cfg.Remote.Identity, BaseDir: cfg.Remote.BaseDir,
		}, cfg.EnableGPU), nil
	case "colab", "platform":
		logger.Printf("runner=%s platform=%s gpu=%v", cfg.Runner, cfg.Platform.BaseURL, cfg.EnableGPU)
		return tools.NewPlatformRunnerWithGPU(tools.PlatformConfig{
			BaseURL: cfg.Platform.BaseURL, APIKey: cfg.Platform.APIKey, Provider: cfg.Platform.Provider,
			Image: cfg.Platform.Image, GPUType: cfg.Platform.GPUType, MinVRAMGB: cfg.Platform.MinVRAMGB,
			MaxHourlyUSD: cfg.Platform.MaxHourlyUSD, PollInterval: cfg.Platform.PollInterval, Timeout: cfg.Platform.Timeout,
		}, cfg.EnableGPU), nil
	case "auto":
		if _, err := exec.LookPath("docker"); err == nil {
			logger.Printf("docker detected; runner=docker gpu=%v", cfg.EnableGPU)
			return tools.NewDockerRunnerWithGPU(cfg.EnableGPU), nil
		}
		if !cfg.LocalRunnerAllowed() {
			return nil, fmt.Errorf("docker not found and local runner is only allowed on loopback addresses")
		}
		logger.Printf("docker not found; using local demo runner (unsafe) gpu=%v", cfg.EnableGPU)
		return tools.NewLocalRunnerWithGPU(cfg.EnableGPU), nil
	default:
		return nil, fmt.Errorf("unknown runner %q", cfg.Runner)
	}
}

func runColabDemo(cfg config.Config, logger *log.Logger, platformURL string) error {
	var mock *httptest.Server
	if platformURL == "" {
		mock = httptest.NewServer(platformmock.NewHandler())
		defer mock.Close()
		platformURL = mock.URL
	}
	runner := tools.NewPlatformRunnerWithGPU(tools.PlatformConfig{
		BaseURL: platformURL, Provider: "colab", Image: "python:3.11-slim",
		MinVRAMGB: 16, MaxHourlyUSD: 0.5, PollInterval: 100 * time.Millisecond, Timeout: 2 * time.Minute,
	}, true)
	orch, closer, err := buildOrchestratorWithRunner(cfg, logger, runner)
	if err != nil {
		return err
	}
	defer closer()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	demoID := fmt.Sprintf("colab_demo_%d", time.Now().UnixNano())
	paperPath, repoPath, err := demo.Materialize(cfg.DataDir, demoID)
	if err != nil {
		return err
	}
	project, err := orch.CreateProject(ctx, orchestrator.CreateInput{
		Name: "Colab-style platform demo", PaperPath: paperPath, RepoPath: repoPath,
		Budget: domain.Budget{MaxRuns: 3, MaxSeconds: 60, MaxPatches: 2},
	})
	if err != nil {
		return err
	}
	project, err = orch.Start(ctx, project.ID)
	if err != nil {
		return err
	}
	project, err = orch.SelectClaims(ctx, project.ID, []string{project.Claims[0].ID})
	if err != nil {
		return err
	}
	project, err = orch.ConfirmPlan(ctx, project.ID)
	if err != nil {
		return err
	}
	if project.State != domain.StateAwaitingPatch || project.Patch == nil {
		return fmt.Errorf("expected platform demo to require a patch, got state=%s", project.State)
	}
	fmt.Println("Colab-style platform selected a GPU offer and returned a failure with evidence:")
	for _, run := range project.Runs {
		fmt.Printf("- run %d: provider=%s offer=%s gpu=%v job=%s status=%s\n", run.Attempt, run.Provider, run.OfferID, run.GPU, run.RemoteJobID, run.Status)
	}
	fmt.Println("Patch proposal:")
	fmt.Println(project.Patch.Diff)
	fmt.Println("Simulated human approval: applying patch and retrying on the platform.")
	project, err = orch.ApprovePatch(ctx, project.ID, "colab-demo-user")
	if err != nil {
		return err
	}
	printProjectResult(project)
	for _, run := range project.Runs {
		fmt.Printf("Run %d: provider=%s offer=%s gpu=%v job=%s status=%s\n", run.Attempt, run.Provider, run.OfferID, run.GPU, run.RemoteJobID, run.Status)
	}
	return nil
}

func runSSHDemo(cfg config.Config, logger *log.Logger, host string, port int, identity, baseDir string, gpu bool) error {
	if identity == "" {
		if resolved, err := filepath.Abs(filepath.Join(".work", "ssh", "reprolens_wsl_rsa")); err == nil {
			identity = resolved
		}
	}
	ws, err := tools.NewWorkspace(cfg.DataDir, fmt.Sprintf("ssh_probe_%d", time.Now().UnixNano()))
	if err != nil {
		return err
	}
	probe := "print('SSH_DEPLOY_OK')\n"
	shellProbe := "#!/usr/bin/env bash\nset -euo pipefail\npython3 probe.py\nnvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true\n"
	if err := os.WriteFile(filepath.Join(ws.Root, "probe.py"), []byte(probe), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(ws.Root, "probe.sh"), []byte(shellProbe), 0o755); err != nil {
		return err
	}
	runner := tools.NewSSHRunnerWithGPU(tools.SSHConfig{
		Host: host, Port: port, Identity: identity, BaseDir: baseDir,
	}, gpu)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	result, err := runner.Execute(ctx, tools.ExecutionRequest{
		ProjectID: "ssh_probe", RunID: "run_1", Workspace: ws.Root, EvidenceDir: ws.EvidenceDir,
		Command: "bash probe.sh", WorkDir: ".", Seed: 42, Timeout: 60 * time.Second,
	})
	if err != nil {
		return err
	}
	fmt.Printf("SSH deployment status: %s\n", result.Status)
	fmt.Printf("SSH host: %s:%d\n", host, port)
	fmt.Printf("GPU enabled: %v\n", result.GPU)
	fmt.Printf("stdout:\n%s\n", result.Stdout)
	if result.Stderr != "" {
		fmt.Printf("stderr:\n%s\n", result.Stderr)
	}
	if result.Status != "succeeded" {
		return fmt.Errorf("SSH deployment probe failed")
	}
	return nil
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return n
}
