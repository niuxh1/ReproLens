package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadReadsDotEnvAndValidatesKey(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	content := "REPROLENS_ADDR=127.0.0.1:9090\n" +
		"REPROLENS_DATA_DIR=./runtime\n" +
		"REPROLENS_RUNNER=local\n" +
		"REPROLENS_LLM_BASE_URL=http://127.0.0.1:8788/v1\n" +
		"REPROLENS_LLM_API_KEY=test-key\n" +
		"REPROLENS_LLM_MODEL=deepseek-v4.1-flash\n" +
		"REPROLENS_LLM_TIMEOUT=12s\n"
	if err := os.WriteFile(envPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(envPath)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Addr != "127.0.0.1:9090" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	if cfg.DataDir != "./runtime" {
		t.Fatalf("DataDir = %q", cfg.DataDir)
	}
	if cfg.Runner != "local" {
		t.Fatalf("Runner = %q", cfg.Runner)
	}
	if cfg.LLM.BaseURL != "http://127.0.0.1:8788/v1" {
		t.Fatalf("LLM.BaseURL = %q", cfg.LLM.BaseURL)
	}
	if cfg.LLM.APIKey != "test-key" {
		t.Fatalf("LLM.APIKey not loaded")
	}
	if cfg.LLM.Model != "deepseek-v4.1-flash" {
		t.Fatalf("LLM.Model = %q", cfg.LLM.Model)
	}
	if cfg.LLM.Timeout != 12*time.Second {
		t.Fatalf("LLM.Timeout = %v", cfg.LLM.Timeout)
	}
}

func TestLoadRejectsIncompleteLLMConfig(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("REPROLENS_LLM_BASE_URL=http://127.0.0.1:8788/v1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Load(envPath); err == nil {
		t.Fatal("Load() expected an error for missing model/key")
	}
}

func TestLoadUsesDefaultsWithoutEnvFile(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.env"))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Addr != "127.0.0.1:8080" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	if cfg.Runner != "auto" {
		t.Fatalf("Runner = %q", cfg.Runner)
	}
	if cfg.LLM.Timeout != 60*time.Second {
		t.Fatalf("LLM.Timeout = %v", cfg.LLM.Timeout)
	}
}
func TestLoadPlatformRunnerAndGPU(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	content := "REPROLENS_RUNNER=colab\n" +
		"REPROLENS_ENABLE_GPU=true\n" +
		"REPROLENS_PLATFORM_BASE_URL=http://127.0.0.1:8789\n" +
		"REPROLENS_PLATFORM_PROVIDER=colab\n" +
		"REPROLENS_PLATFORM_IMAGE=python:3.11-slim\n" +
		"REPROLENS_PLATFORM_GPU_TYPE=T4\n" +
		"REPROLENS_PLATFORM_MIN_VRAM_GB=16\n" +
		"REPROLENS_PLATFORM_MAX_HOURLY_USD=0.5\n" +
		"REPROLENS_PLATFORM_POLL_INTERVAL=250ms\n" +
		"REPROLENS_PLATFORM_TIMEOUT=5m\n"
	if err := os.WriteFile(envPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Runner != "colab" || !cfg.EnableGPU {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.Platform.BaseURL != "http://127.0.0.1:8789" || cfg.Platform.GPUType != "T4" || cfg.Platform.MinVRAMGB != 16 {
		t.Fatalf("platform = %+v", cfg.Platform)
	}
	if cfg.Platform.PollInterval != 250*time.Millisecond || cfg.Platform.Timeout != 5*time.Minute {
		t.Fatalf("platform durations = %+v", cfg.Platform)
	}
}

func TestLoadSSHRunnerRequiresHost(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("REPROLENS_RUNNER=ssh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(envPath); err == nil {
		t.Fatal("expected SSH runner without host to fail")
	}
}

func TestLoadRejectsInvalidGPUFlag(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("REPROLENS_ENABLE_GPU=maybe\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(envPath); err == nil {
		t.Fatal("expected invalid GPU flag to fail")
	}
}

func TestLoadCodeAgentDefaults(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	content := "REPROLENS_CODE_AGENT=codex\n" +
		"REPROLENS_CODE_AGENT_TIMEOUT=7m\n" +
		"REPROLENS_CODE_AGENT_RUN_ACCEPTANCE=true\n"
	if err := os.WriteFile(envPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CodeAgent.Type != "codex" || !strings.Contains(cfg.CodeAgent.Command, "codex exec") {
		t.Fatalf("code agent = %+v", cfg.CodeAgent)
	}
	if cfg.CodeAgent.Timeout != 7*time.Minute || !cfg.CodeAgent.RunAcceptance {
		t.Fatalf("code agent = %+v", cfg.CodeAgent)
	}
}

func TestLoadCommandCodeAgentRequiresCommand(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("REPROLENS_CODE_AGENT=command\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(envPath); err == nil {
		t.Fatal("expected command code agent without command to fail")
	}
}
