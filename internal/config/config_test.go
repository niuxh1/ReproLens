package config

import (
	"os"
	"path/filepath"
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