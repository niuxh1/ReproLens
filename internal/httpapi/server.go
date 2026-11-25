package httpapi

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"reprolens/internal/demo"
	"reprolens/internal/domain"
	"reprolens/internal/orchestrator"
	"reprolens/internal/store"
)

//go:embed static/*
var staticFiles embed.FS

type Server struct {
	orch    *orchestrator.Orchestrator
	dataDir string
	handler http.Handler
}

func NewServer(orch *orchestrator.Orchestrator, dataDir string) *Server {
	s := &Server{orch: orch, dataDir: dataDir}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /api/v1/projects", s.handleListProjects)
	mux.HandleFunc("POST /api/v1/projects", s.handleCreateProject)
	mux.HandleFunc("POST /api/v1/demo", s.handleDemo)
	mux.HandleFunc("GET /api/v1/projects/{id}", s.handleGetProject)
	mux.HandleFunc("POST /api/v1/projects/{id}/start", s.handleStart)
	mux.HandleFunc("POST /api/v1/projects/{id}/claims", s.handleSelectClaims)
	mux.HandleFunc("POST /api/v1/projects/{id}/plan/confirm", s.handleConfirmPlan)
	mux.HandleFunc("POST /api/v1/projects/{id}/patch/approve", s.handleApprovePatch)
	mux.HandleFunc("POST /api/v1/projects/{id}/patch/reject", s.handleRejectPatch)
	mux.HandleFunc("POST /api/v1/projects/{id}/stop", s.handleStop)
	mux.HandleFunc("GET /api/v1/projects/{id}/events", s.handleEvents)
	mux.HandleFunc("GET /api/v1/projects/{id}/events/stream", s.handleEventStream)
	mux.HandleFunc("GET /api/v1/projects/{id}/report.md", s.handleReport)
	mux.HandleFunc("GET /api/v1/projects/{id}/package", s.handlePackage)
	mux.HandleFunc("GET /{$}", s.handleIndex)
	sub, err := fs.Sub(staticFiles, "static")
	if err == nil {
		mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(sub))))
	}
	s.handler = recoverMiddleware(mux)
	return s
}

func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "time": time.Now().UTC(), "service": "reprolens"})
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.orch.ListProjects(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, projects)
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name      string        `json:"name"`
		PaperPath string        `json:"paper_path"`
		RepoPath  string        `json:"repo_path"`
		DataPath  string        `json:"data_path"`
		Budget    domain.Budget `json:"budget"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	project, err := s.orch.CreateProject(r.Context(), orchestrator.CreateInput{
		Name: input.Name, PaperPath: input.PaperPath, RepoPath: input.RepoPath, DataPath: input.DataPath, Budget: input.Budget,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, project)
}

func (s *Server) handleDemo(w http.ResponseWriter, r *http.Request) {
	demoID := fmt.Sprintf("demo_%d", time.Now().UnixNano())
	paperPath, repoPath, err := demo.Materialize(s.dataDir, demoID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	project, err := s.orch.CreateProject(r.Context(), orchestrator.CreateInput{
		Name: "Accuracy reproduction demo", PaperPath: paperPath, RepoPath: repoPath,
		Budget: domain.Budget{MaxRuns: 3, MaxSeconds: 60, MaxPatches: 2},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, project)
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	project, err := s.orch.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	project, err := s.orch.Start(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (s *Server) handleSelectClaims(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ClaimIDs []string `json:"claim_ids"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	project, err := s.orch.SelectClaims(r.Context(), r.PathValue("id"), input.ClaimIDs)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (s *Server) handleConfirmPlan(w http.ResponseWriter, r *http.Request) {
	project, err := s.orch.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	id := project.ID
	go func() {
		if _, err := s.orch.ConfirmPlan(context.Background(), id); err != nil {
			log.Printf("confirm plan %s: %v", id, err)
		}
	}()
	writeJSON(w, http.StatusAccepted, project)
}

func (s *Server) handleApprovePatch(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ApprovedBy string `json:"approved_by"`
	}
	_ = decodeJSON(w, r, &input)
	project, err := s.orch.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	id := project.ID
	go func() {
		if _, err := s.orch.ApprovePatch(context.Background(), id, input.ApprovedBy); err != nil {
			log.Printf("approve patch %s: %v", id, err)
		}
	}()
	writeJSON(w, http.StatusAccepted, project)
}

func (s *Server) handleRejectPatch(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Reason string `json:"reason"`
	}
	_ = decodeJSON(w, r, &input)
	project, err := s.orch.RejectPatch(r.Context(), r.PathValue("id"), input.Reason)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	project, err := s.orch.Stop(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	events, err := s.orch.Events(r.Context(), r.PathValue("id"), after)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) handleEventStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		events, err := s.orch.Events(r.Context(), r.PathValue("id"), after)
		if err != nil {
			fmt.Fprintf(w, "event: error\ndata: %q\n\n", err.Error())
			flusher.Flush()
			return
		}
		for _, event := range events {
			data, _ := json.Marshal(event)
			fmt.Fprintf(w, "id: %d\nevent: reprolens\ndata: %s\n\n", event.Seq, data)
			after = event.Seq
		}
		flusher.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) handleReport(w http.ResponseWriter, r *http.Request) {
	project, err := s.orch.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if project.Report == nil {
		writeError(w, http.StatusNotFound, "report is not ready")
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(project.Report.Markdown))
}

func (s *Server) handlePackage(w http.ResponseWriter, r *http.Request) {
	project, err := s.orch.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if project.Report == nil || project.Report.PackagePath == "" {
		writeError(w, http.StatusNotFound, "reproduction package is not ready")
		return
	}
	path, err := filepath.Abs(project.Report.PackagePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "package file is missing")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(path)))
	http.ServeFile(w, r, path)
}

func (s *Server) handleIndex(w http.ResponseWriter, _ *http.Request) {
	data, err := staticFiles.ReadFile("static/index.html")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		if strings.Contains(err.Error(), "EOF") {
			return fmt.Errorf("request body must be valid JSON")
		}
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"message": message}})
}

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}

func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("panic serving %s: %v", r.URL.Path, recovered)
				writeError(w, http.StatusInternalServerError, "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
