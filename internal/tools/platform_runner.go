package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

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

type PlatformOffer struct {
	ID        string  `json:"id"`
	Provider  string  `json:"provider"`
	GPUType   string  `json:"gpu_type"`
	VRAMGB    int     `json:"vram_gb"`
	HourlyUSD float64 `json:"hourly_usd"`
	Available bool    `json:"available"`
}

type PlatformRunner struct {
	Config    PlatformConfig
	EnableGPU bool
	client    *http.Client
}

func NewPlatformRunner(cfg PlatformConfig) *PlatformRunner {
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if cfg.Provider == "" {
		cfg.Provider = "colab"
	}
	if cfg.Image == "" {
		cfg.Image = "python:3.11-slim"
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 2 * time.Second
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Minute
	}
	return &PlatformRunner{Config: cfg, client: &http.Client{Timeout: 60 * time.Second}}
}

func NewPlatformRunnerWithGPU(cfg PlatformConfig, enabled bool) *PlatformRunner {
	r := NewPlatformRunner(cfg)
	r.EnableGPU = enabled
	return r
}

func (r *PlatformRunner) Name() string {
	return r.Config.Provider + " (rental platform)"
}

func (r *PlatformRunner) Execute(ctx context.Context, req ExecutionRequest) (ExecutionResult, error) {
	if r.Config.BaseURL == "" {
		return ExecutionResult{}, fmt.Errorf("platform base URL is empty")
	}
	if _, err := validateExecutionCommand(req.Command); err != nil {
		return ExecutionResult{}, err
	}
	if req.Workspace == "" || req.EvidenceDir == "" || req.ProjectID == "" || req.RunID == "" {
		return ExecutionResult{}, fmt.Errorf("workspace, evidence, project id, and run id are required")
	}
	if !workspaceIDRE.MatchString(req.ProjectID) || !runIDRE.MatchString(req.RunID) {
		return ExecutionResult{}, fmt.Errorf("invalid project or run id")
	}
	archiveDir := filepath.Join(req.EvidenceDir, "platform", req.RunID)
	if err := os.MkdirAll(archiveDir, 0o755); err != nil {
		return ExecutionResult{}, err
	}
	archivePath := filepath.Join(archiveDir, "workspace.tar.gz")
	if err := CreateWorkspaceArchive(req.Workspace, archivePath); err != nil {
		return ExecutionResult{}, err
	}
	offer, err := r.SelectOffer(ctx)
	if err != nil {
		return ExecutionResult{}, err
	}
	artifactID, err := r.UploadArtifact(ctx, archivePath)
	if err != nil {
		return ExecutionResult{}, err
	}
	started := time.Now().UTC()
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = r.Config.Timeout
	}
	jobID, err := r.CreateJob(ctx, offer, artifactID, req, timeout)
	if err != nil {
		return ExecutionResult{}, err
	}
	status, exitCode, err := r.WaitForJob(ctx, jobID, timeout)
	if err != nil {
		return ExecutionResult{}, err
	}
	logs, err := r.FetchLogs(ctx, jobID)
	if err != nil {
		return ExecutionResult{}, err
	}
	finished := time.Now().UTC()
	env := buildExecutionEnv(req)
	env["REPROLENS_PLATFORM"] = offer.Provider
	env["REPROLENS_OFFER_ID"] = offer.ID
	result := ExecutionResult{
		Runner: fmt.Sprintf("%s:%s", offer.Provider, offer.GPUType), Provider: offer.Provider,
		RemoteJobID: jobID, OfferID: offer.ID, GPU: offer.VRAMGB > 0,
		Command: req.Command, Image: r.Config.Image, WorkDir: req.WorkDir,
		Status: status, ExitCode: exitCode, StartedAt: started, FinishedAt: finished,
		DurationMS: finished.Sub(started).Milliseconds(), Stdout: logs.Stdout, Stderr: logs.Stderr, Env: env,
	}
	if result.Status == "timeout" {
		result.ExitCode = -1
	}
	if err := writeRunEvidence(req, &result); err != nil {
		return result, err
	}
	return result, nil
}

func (r *PlatformRunner) SelectOffer(ctx context.Context) (PlatformOffer, error) {
	var raw json.RawMessage
	if err := r.doJSON(ctx, http.MethodGet, "/v1/offers", nil, &raw); err != nil {
		return PlatformOffer{}, err
	}
	var envelope struct {
		Offers []PlatformOffer `json:"offers"`
	}
	var offers []PlatformOffer
	if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Offers != nil {
		offers = envelope.Offers
	} else if err := json.Unmarshal(raw, &offers); err != nil {
		return PlatformOffer{}, fmt.Errorf("decode offers: %w", err)
	}
	filtered := make([]PlatformOffer, 0, len(offers))
	for _, offer := range offers {
		if !offer.Available {
			continue
		}
		if r.EnableGPU {
			if offer.VRAMGB <= 0 || offer.VRAMGB < r.Config.MinVRAMGB {
				continue
			}
			if r.Config.GPUType != "" && !strings.EqualFold(offer.GPUType, r.Config.GPUType) {
				continue
			}
		} else if offer.VRAMGB > 0 {
			// Prefer CPU offers when the run does not request a GPU.
			continue
		}
		if r.Config.MaxHourlyUSD > 0 && offer.HourlyUSD > r.Config.MaxHourlyUSD {
			continue
		}
		filtered = append(filtered, offer)
	}
	if len(filtered) == 0 && !r.EnableGPU {
		for _, offer := range offers {
			if offer.Available && (r.Config.MaxHourlyUSD <= 0 || offer.HourlyUSD <= r.Config.MaxHourlyUSD) {
				filtered = append(filtered, offer)
			}
		}
	}
	if len(filtered) == 0 {
		return PlatformOffer{}, fmt.Errorf("no platform offer satisfies GPU/VRAM/price requirements")
	}
	sort.Slice(filtered, func(i, j int) bool {
		if filtered[i].HourlyUSD == filtered[j].HourlyUSD {
			return filtered[i].VRAMGB > filtered[j].VRAMGB
		}
		return filtered[i].HourlyUSD < filtered[j].HourlyUSD
	})
	return filtered[0], nil
}

func (r *PlatformRunner) UploadArtifact(ctx context.Context, archivePath string) (string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filepath.Base(archivePath))
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, f); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.Config.BaseURL+"/v1/artifacts", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	r.setAuth(req)
	resp, err := r.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("artifact upload failed: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		ArtifactID string `json:"artifact_id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	if out.ArtifactID == "" {
		return "", fmt.Errorf("platform returned empty artifact id")
	}
	return out.ArtifactID, nil
}

func (r *PlatformRunner) CreateJob(ctx context.Context, offer PlatformOffer, artifactID string, req ExecutionRequest, timeout time.Duration) (string, error) {
	payload := map[string]any{
		"offer_id": offer.ID, "artifact_id": artifactID, "command": req.Command,
		"image": r.Config.Image, "gpu": offer.VRAMGB > 0, "timeout_seconds": int(timeout.Seconds()),
		"env": map[string]string{"REPROLENS_SEED": fmt.Sprintf("%d", req.Seed), "MPLBACKEND": "Agg"},
	}
	var out struct {
		JobID string `json:"job_id"`
	}
	if err := r.doJSON(ctx, http.MethodPost, "/v1/jobs", payload, &out); err != nil {
		return "", err
	}
	if out.JobID == "" {
		return "", fmt.Errorf("platform returned empty job id")
	}
	return out.JobID, nil
}

func (r *PlatformRunner) WaitForJob(ctx context.Context, jobID string, timeout time.Duration) (string, int, error) {
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(r.Config.PollInterval)
	defer ticker.Stop()
	for {
		var status struct {
			Status   string `json:"status"`
			ExitCode int    `json:"exit_code"`
		}
		if err := r.doJSON(waitCtx, http.MethodGet, "/v1/jobs/"+jobID, nil, &status); err != nil {
			return "", 0, err
		}
		switch strings.ToLower(status.Status) {
		case "succeeded", "failed", "cancelled", "canceled", "timeout":
			return strings.ToLower(status.Status), status.ExitCode, nil
		}
		select {
		case <-waitCtx.Done():
			return "timeout", -1, nil
		case <-ticker.C:
		}
	}
}

type platformLogs struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

func (r *PlatformRunner) FetchLogs(ctx context.Context, jobID string) (platformLogs, error) {
	var logs platformLogs
	if err := r.doJSON(ctx, http.MethodGet, "/v1/jobs/"+jobID+"/logs", nil, &logs); err != nil {
		return logs, err
	}
	return logs, nil
}

func (r *PlatformRunner) doJSON(ctx context.Context, method, path string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, r.Config.BaseURL+path, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	r.setAuth(req)
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("platform request %s failed: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil {
		if rawOut, ok := out.(*json.RawMessage); ok {
			*rawOut = append((*rawOut)[:0], raw...)
			return nil
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return err
		}
	}
	return nil
}

func (r *PlatformRunner) setAuth(req *http.Request) {
	if r.Config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+r.Config.APIKey)
	}
}
