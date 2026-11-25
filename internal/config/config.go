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
	DefaultAddr            = "127.0.0.1:8080"
	DefaultDataDir         = "./data"
	DefaultRunner          = "auto"
	DefaultLLMTimeout      = 60 * time.Second
	DefaultSSHPort         = 22
	DefaultSSHBaseDir      = "/tmp/reprolens"
	DefaultPlatformPoll    = 2 * time.Second
	DefaultPlatformTimeout = 30 * time.Minute
)

type Config struct {
	Addr      string
	DataDir   string
	Runner    string
	EnableGPU bool
	CodeAgent CodeAgentConfig
	LLM       LLMConfig
	Remote    RemoteConfig
	Platform  PlatformConfig
}

type CodeAgentConfig struct {
	Type          string
	Command       string
	Timeout       time.Duration
	RunAcceptance bool
}

type LLMConfig struct {
	BaseURL string
	APIKey  string
	Model   string
	Timeout time.Duration
}

type RemoteConfig struct {
	Host     string
	Port     int
	Identity string
	BaseDir  string
}

type PlatformConfig struct {
	BaseURL      string
	APIKey       string
	Provider     string
	Image        string
	GPUType      string
	MinVRAMGB    int
	MaxHourlyUSD float64
	PollInterval time.Duration
	Timeout      time.Duration
}

func Load(envPath string) (Config, error) {
	cfg := Config{
		Addr:      DefaultAddr,
		DataDir:   DefaultDataDir,
		Runner:    DefaultRunner,
		LLM:       LLMConfig{Timeout: DefaultLLMTimeout},
		CodeAgent: CodeAgentConfig{Type: "none", Timeout: 10 * time.Minute},
		Remote:    RemoteConfig{Port: DefaultSSHPort, BaseDir: DefaultSSHBaseDir},
		Platform: PlatformConfig{
			Provider: "colab", Image: "python:3.11-slim",
			PollInterval: DefaultPlatformPoll, Timeout: DefaultPlatformTimeout,
		},
	}

	values := map[string]string{}
	if envPath == "" {
		envPath = ".env"
	}
	if err := loadDotEnv(envPath, values); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, fmt.Errorf("read env file: %w", err)
	}
	get := func(key, fallback string) string {
		if v, ok := os.LookupEnv(key); ok {
			return strings.TrimSpace(v)
		}
		if v, ok := values[key]; ok {
			return strings.TrimSpace(v)
		}
		return fallback
	}
	getInt := func(key string, fallback int) (int, error) {
		raw := get(key, strconv.Itoa(fallback))
		n, err := strconv.Atoi(raw)
		if err != nil {
			return 0, fmt.Errorf("invalid %s %q", key, raw)
		}
		return n, nil
	}
	getFloat := func(key string, fallback float64) (float64, error) {
		raw := get(key, strconv.FormatFloat(fallback, 'f', -1, 64))
		n, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid %s %q", key, raw)
		}
		return n, nil
	}
	getDuration := func(key string, fallback time.Duration) (time.Duration, error) {
		raw := get(key, fallback.String())
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return 0, fmt.Errorf("invalid %s %q", key, raw)
		}
		return d, nil
	}

	cfg.Addr = get("REPROLENS_ADDR", cfg.Addr)
	cfg.DataDir = get("REPROLENS_DATA_DIR", cfg.DataDir)
	cfg.Runner = strings.ToLower(get("REPROLENS_RUNNER", cfg.Runner))
	if raw := get("REPROLENS_ENABLE_GPU", "false"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("invalid REPROLENS_ENABLE_GPU %q", raw)
		}
		cfg.EnableGPU = v
	}
	var err error
	cfg.CodeAgent.Type = strings.ToLower(get("REPROLENS_CODE_AGENT", cfg.CodeAgent.Type))
	cfg.CodeAgent.Command = get("REPROLENS_CODE_AGENT_CMD", cfg.CodeAgent.Command)
	if cfg.CodeAgent.Timeout, err = getDuration("REPROLENS_CODE_AGENT_TIMEOUT", cfg.CodeAgent.Timeout); err != nil {
		return Config{}, err
	}
	if raw := get("REPROLENS_CODE_AGENT_RUN_ACCEPTANCE", "false"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("invalid REPROLENS_CODE_AGENT_RUN_ACCEPTANCE %q", raw)
		}
		cfg.CodeAgent.RunAcceptance = v
	}
	cfg.LLM.BaseURL = get("REPROLENS_LLM_BASE_URL", cfg.LLM.BaseURL)
	cfg.LLM.APIKey = get("REPROLENS_LLM_API_KEY", cfg.LLM.APIKey)
	cfg.LLM.Model = get("REPROLENS_LLM_MODEL", cfg.LLM.Model)
	if cfg.LLM.Timeout, err = getDuration("REPROLENS_LLM_TIMEOUT", cfg.LLM.Timeout); err != nil {
		return Config{}, err
	}
	cfg.Remote.Host = get("REPROLENS_SSH_HOST", cfg.Remote.Host)
	if cfg.Remote.Port, err = getInt("REPROLENS_SSH_PORT", cfg.Remote.Port); err != nil {
		return Config{}, err
	}
	cfg.Remote.Identity = get("REPROLENS_SSH_IDENTITY", cfg.Remote.Identity)
	cfg.Remote.BaseDir = get("REPROLENS_SSH_BASE_DIR", cfg.Remote.BaseDir)
	cfg.Platform.BaseURL = get("REPROLENS_PLATFORM_BASE_URL", cfg.Platform.BaseURL)
	cfg.Platform.APIKey = get("REPROLENS_PLATFORM_API_KEY", cfg.Platform.APIKey)
	cfg.Platform.Provider = strings.ToLower(get("REPROLENS_PLATFORM_PROVIDER", cfg.Platform.Provider))
	cfg.Platform.Image = get("REPROLENS_PLATFORM_IMAGE", cfg.Platform.Image)
	cfg.Platform.GPUType = get("REPROLENS_PLATFORM_GPU_TYPE", cfg.Platform.GPUType)
	if cfg.Platform.MinVRAMGB, err = getInt("REPROLENS_PLATFORM_MIN_VRAM_GB", cfg.Platform.MinVRAMGB); err != nil {
		return Config{}, err
	}
	if cfg.Platform.MaxHourlyUSD, err = getFloat("REPROLENS_PLATFORM_MAX_HOURLY_USD", cfg.Platform.MaxHourlyUSD); err != nil {
		return Config{}, err
	}
	if cfg.Platform.PollInterval, err = getDuration("REPROLENS_PLATFORM_POLL_INTERVAL", cfg.Platform.PollInterval); err != nil {
		return Config{}, err
	}
	if cfg.Platform.Timeout, err = getDuration("REPROLENS_PLATFORM_TIMEOUT", cfg.Platform.Timeout); err != nil {
		return Config{}, err
	}

	if cfg.Addr == "" {
		return Config{}, errors.New("REPROLENS_ADDR must not be empty")
	}
	switch cfg.CodeAgent.Type {
	case "", "none":
		cfg.CodeAgent.Type = "none"
	case "claude":
		if cfg.CodeAgent.Command == "" {
			cfg.CodeAgent.Command = "claude -p --allowedTools Read,Edit,Write,Bash"
		}
	case "codex":
		if cfg.CodeAgent.Command == "" {
			cfg.CodeAgent.Command = "codex exec --approve-for-me --ephemeral"
		}
	case "gemini":
		if cfg.CodeAgent.Command == "" {
			cfg.CodeAgent.Command = "gemini"
		}
	case "command":
		if cfg.CodeAgent.Command == "" {
			return Config{}, errors.New("REPROLENS_CODE_AGENT_CMD is required for the command code agent")
		}
	default:
		return Config{}, fmt.Errorf("invalid REPROLENS_CODE_AGENT %q", cfg.CodeAgent.Type)
	}
	switch cfg.Runner {
	case "auto", "docker", "local", "ssh", "colab", "platform":
	default:
		return Config{}, fmt.Errorf("invalid REPROLENS_RUNNER %q (want auto, docker, local, ssh, colab, or platform)", cfg.Runner)
	}
	if cfg.Runner == "ssh" && strings.TrimSpace(cfg.Remote.Host) == "" {
		return Config{}, errors.New("REPROLENS_SSH_HOST is required when REPROLENS_RUNNER=ssh")
	}
	if cfg.Remote.Port < 1 || cfg.Remote.Port > 65535 {
		return Config{}, fmt.Errorf("invalid REPROLENS_SSH_PORT %d", cfg.Remote.Port)
	}
	if cfg.Runner == "colab" || cfg.Runner == "platform" {
		if cfg.Platform.BaseURL == "" {
			return Config{}, errors.New("REPROLENS_PLATFORM_BASE_URL is required for platform runners")
		}
		u, err := url.Parse(cfg.Platform.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return Config{}, fmt.Errorf("invalid REPROLENS_PLATFORM_BASE_URL %q", cfg.Platform.BaseURL)
		}
	}
	cfg.Platform.BaseURL = strings.TrimRight(cfg.Platform.BaseURL, "/")
	cfg.LLM.BaseURL = strings.TrimRight(cfg.LLM.BaseURL, "/")
	if cfg.LLM.BaseURL != "" {
		u, err := url.Parse(cfg.LLM.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return Config{}, fmt.Errorf("invalid REPROLENS_LLM_BASE_URL %q", cfg.LLM.BaseURL)
		}
		if cfg.LLM.APIKey == "" {
			return Config{}, errors.New("REPROLENS_LLM_API_KEY is required when REPROLENS_LLM_BASE_URL is set")
		}
		if cfg.LLM.Model == "" {
			return Config{}, errors.New("REPROLENS_LLM_MODEL is required when REPROLENS_LLM_BASE_URL is set")
		}
	}
	if cfg.DataDir == "" {
		return Config{}, errors.New("REPROLENS_DATA_DIR must not be empty")
	}
	if cfg.Platform.MinVRAMGB < 0 || cfg.Platform.MaxHourlyUSD < 0 {
		return Config{}, errors.New("platform VRAM and price limits must be non-negative")
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
	return scanner.Err()
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
