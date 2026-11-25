package platformmock

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Offer struct {
	ID        string  `json:"id"`
	Provider  string  `json:"provider"`
	GPUType   string  `json:"gpu_type"`
	VRAMGB    int     `json:"vram_gb"`
	HourlyUSD float64 `json:"hourly_usd"`
	Available bool    `json:"available"`
}

type Handler struct {
	mu        sync.Mutex
	offers    []Offer
	artifacts map[string][]byte
	jobs      map[string]*job
	nextID    int64
}

type job struct {
	ID       string
	OfferID  string
	Command  string
	Image    string
	GPU      bool
	Polls    int
	Status   string
	ExitCode int
	Stdout   string
	Stderr   string
	Created  time.Time
}

func NewHandler() http.Handler {
	h := &Handler{
		offers: []Offer{
			{ID: "colab-cpu", Provider: "colab", GPUType: "CPU", VRAMGB: 0, HourlyUSD: 0.00, Available: true},
			{ID: "colab-t4", Provider: "colab", GPUType: "T4", VRAMGB: 16, HourlyUSD: 0.00, Available: true},
			{ID: "colab-l4", Provider: "colab", GPUType: "L4", VRAMGB: 24, HourlyUSD: 0.35, Available: true},
			{ID: "colab-a100", Provider: "colab", GPUType: "A100", VRAMGB: 40, HourlyUSD: 1.20, Available: true},
		},
		artifacts: map[string][]byte{},
		jobs:      map[string]*job{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "mock-colab"})
	})
	mux.HandleFunc("GET /v1/offers", h.handleOffers)
	mux.HandleFunc("POST /v1/artifacts", h.handleArtifacts)
	mux.HandleFunc("POST /v1/jobs", h.handleCreateJob)
	mux.HandleFunc("GET /v1/jobs/{id}", h.handleJob)
	mux.HandleFunc("GET /v1/jobs/{id}/logs", h.handleLogs)
	return mux
}

func (h *Handler) handleOffers(w http.ResponseWriter, _ *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"offers": h.offers})
}

func (h *Handler) handleArtifacts(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 64<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.mu.Lock()
	h.nextID++
	id := fmt.Sprintf("artifact_%d", h.nextID)
	h.artifacts[id] = data
	h.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{"artifact_id": id})
}

func (h *Handler) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OfferID    string `json:"offer_id"`
		ArtifactID string `json:"artifact_id"`
		Command    string `json:"command"`
		Image      string `json:"image"`
		GPU        bool   `json:"gpu"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.mu.Lock()
	data, ok := h.artifacts[req.ArtifactID]
	h.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "artifact not found")
		return
	}
	stdout, stderr, status, exitCode := simulate(data)
	h.mu.Lock()
	h.nextID++
	id := fmt.Sprintf("job_%d", h.nextID)
	h.jobs[id] = &job{
		ID: id, OfferID: req.OfferID, Command: req.Command, Image: req.Image, GPU: req.GPU,
		Status: status, ExitCode: exitCode, Stdout: stdout, Stderr: stderr, Created: time.Now().UTC(),
	}
	h.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{"job_id": id, "status": "queued"})
}

func (h *Handler) handleJob(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	j, ok := h.jobs[r.PathValue("id")]
	if !ok {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	j.Polls++
	status := j.Status
	if j.Polls < 2 {
		status = "running"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job_id": j.ID, "status": status, "exit_code": j.ExitCode,
		"created_at": j.Created, "updated_at": time.Now().UTC(),
	})
}

func (h *Handler) handleLogs(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	j, ok := h.jobs[r.PathValue("id")]
	if !ok {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"stdout": j.Stdout, "stderr": j.Stderr, "exit_code": j.ExitCode, "status": j.Status,
	})
}

func simulate(archive []byte) (stdout, stderr, status string, exitCode int) {
	content, err := readRunScript(archive)
	if err != nil {
		return "", err.Error(), "failed", 1
	}
	if strings.Contains(content, "SEED = 0") {
		return "", "seed mismatch: expected 42, got 0\n", "failed", 1
	}
	if strings.Contains(content, "SEED = 42") {
		return "accuracy=0.81\n", "", "succeeded", 0
	}
	return "", "simulated runtime could not locate a supported experiment\n", "failed", 1
}

func readRunScript(archive []byte) (string, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return "", err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if filepath.Base(hdr.Name) == "run_experiment.py" {
			data, err := io.ReadAll(io.LimitReader(tr, 2<<20))
			if err != nil {
				return "", err
			}
			return string(data), nil
		}
	}
	return "", fmt.Errorf("run_experiment.py not found in uploaded artifact")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"message": message}})
}
