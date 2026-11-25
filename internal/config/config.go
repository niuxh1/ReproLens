package config

import (
	"bufio"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultAddr       = "127.0.0.1:8080"
	DefaultDataDir    = "./data"
	DefaultRunner     = "auto"
	DefaultLLMTimeout = 60 * time.Second
)

type Config struct {
	Addr    string
	DataDir string
	Runner  string
	LLM     LLMConfig
}

type LLMConfig struct {
	BaseURL string
	APIKey  string
	Model   string
	Timeout time.Duration
}

func Load(envPath string) (Config, error) {
	cfg := Config{
		Addr:    DefaultAddr,
		DataDir: DefaultDataDir,
		Runner:  DefaultRunner,
		LLM: LLMConfig{
			Timeout: DefaultLLMTimeout,
		},
	}

	values := map[string]string{}
	if envPath == "" {
		envPath = ".env"
	}
	if err := loadDotEnv(envPath, values); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, fmt.Errorf("read env file: %w", err)
	}

	override := func(key string, dst *string) {
		if v, ok := os.LookupEnv(key); ok {
			*dst = strings.TrimSpace(v)
			return
		}
		if v, ok := values[key]; ok {
			*dst = strings.TrimSpace(v)
		}
	}

	override("REPROLENS_ADDR", &cfg.Addr)
	override("REPROLENS_DATA_DIR", &cfg.DataDir)
	override("REPROLENS_RUNNER", &cfg.Runner)
	override("REPROLENS_LLM_BASE_URL", &cfg.LLM.BaseURL)
	override("REPROLENS_LLM_API_KEY", &cfg.LLM.APIKey)
	override("REPROLENS_LLM_MODEL", &cfg.LLM.Model)

	timeout := cfg.LLM.Timeout.String()
	override("REPROLENS_LLM_TIMEOUT", &timeout)
	parsed, err := time.ParseDuration(strings.TrimSpace(timeout))
	if err != nil || parsed <= 0 {
		return Config{}, fmt.Errorf("invalid REPROLENS_LLM_TIMEOUT %q", timeout)
	}
	cfg.LLM.Timeout = parsed

	if cfg.Addr == "" {
		return Config{}, errors.New("REPROLENS_ADDR must not be empty")
	}
	if cfg.Runner != "auto" && cfg.Runner != "docker" && cfg.Runner != "local" {
		return Config{}, fmt.Errorf("invalid REPROLENS_RUNNER %q (want auto, docker, or local)", cfg.Runner)
	}
	cfg.LLM.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.LLM.BaseURL), "/")
	if cfg.LLM.BaseURL != "" {
		u, err := url.Parse(cfg.LLM.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return Config{}, fmt.Errorf("invalid REPROLENS_LLM_BASE_URL %q", cfg.LLM.BaseURL)
		}
		if strings.TrimSpace(cfg.LLM.APIKey) == "" {
			return Config{}, errors.New("REPROLENS_LLM_API_KEY is required when REPROLENS_LLM_BASE_URL is set")
		}
		if strings.TrimSpace(cfg.LLM.Model) == "" {
			return Config{}, errors.New("REPROLENS_LLM_MODEL is required when REPROLENS_LLM_BASE_URL is set")
		}
	}
	if cfg.DataDir == "" {
		return Config{}, errors.New("REPROLENS_DATA_DIR must not be empty")
	}
	return cfg, nil
}

func loadDotEnv(path string, values map[string]string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		if key != "" {
			values[key] = value
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func (c Config) LocalRunnerAllowed() bool {
	if c.Runner == "local" {
		return true
	}
	host, _, ok := strings.Cut(c.Addr, ":")
	if !ok {
		return false
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

var _ = strconv.Itoa
