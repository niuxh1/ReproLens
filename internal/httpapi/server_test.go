package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"reprolens/internal/agent"
	"reprolens/internal/domain"
	"reprolens/internal/orchestrator"
	"reprolens/internal/store"
	"reprolens/internal/tools"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	dataDir := t.TempDir()
	o := orchestrator.New(store.NewMemory(), agent.NewHeuristic(), tools.NewLocalRunner(), dataDir)
	return NewServer(o, dataDir)
}

func TestHealth(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %+v", body)
	}
}

func TestDemoCreateStartAndEvents(t *testing.T) {
	s := newTestServer(t)
	handler := s.Handler()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/demo", strings.NewReader("{}")))
	if rec.Code != http.StatusCreated {
		t.Fatalf("demo status = %d body=%s", rec.Code, rec.Body.String())
	}
	var project domain.Project
	if err := json.Unmarshal(rec.Body.Bytes(), &project); err != nil {
		t.Fatal(err)
	}
	if project.ID == "" || project.State != domain.StateCreated {
		t.Fatalf("project = %+v", project)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+project.ID+"/start", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("start status = %d body=%s", rec.Code, rec.Body.String())
	}
	var started domain.Project
	if err := json.Unmarshal(rec.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.State != domain.StateAwaitingClaims || len(started.Claims) == 0 {
		t.Fatalf("started = %+v", started)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+project.ID+"/events", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d body=%s", rec.Code, rec.Body.String())
	}
	var events []domain.Event
	if err := json.Unmarshal(rec.Body.Bytes(), &events); err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Seq != 1 {
		t.Fatalf("events = %+v", events)
	}
}

func TestMissingProjectReturns404(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/projects/missing", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateProjectRejectsMalformedJSON(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/projects", strings.NewReader("{")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}