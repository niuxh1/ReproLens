package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"reprolens/internal/domain"
)

func testStores(t *testing.T) map[string]Store {
	t.Helper()
	return map[string]Store{
		"memory": NewMemory(),
		"sqlite": mustSQLite(t),
	}
}

func mustSQLite(t *testing.T) Store {
	t.Helper()
	s, err := NewSQLite(filepath.Join(t.TempDir(), "reprolens.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func sampleProject(id string) *domain.Project {
	now := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	return &domain.Project{
		ID:            id,
		Name:          "accuracy demo",
		State:         domain.StateCreated,
		PaperPath:     "paper.md",
		RepoPath:      "repo",
		WorkspacePath: "workspace",
		EvidenceDir:   "evidence",
		Budget:        domain.Budget{MaxRuns: 3, MaxSeconds: 120, MaxPatches: 2},
		Claims: []domain.Claim{{
			ID: "C1", Text: "accuracy 0.81", Metric: "accuracy", ExpectedValue: 0.81,
			Tolerance: domain.Tolerance{Abs: 0.01}, Source: domain.ClaimSource{Path: "paper.md", Line: 4},
		}},
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func TestProjectRoundTripAndSave(t *testing.T) {
	ctx := context.Background()
	for name, s := range testStores(t) {
		t.Run(name, func(t *testing.T) {
			p := sampleProject("p1")
			if err := s.CreateProject(ctx, p); err != nil {
				t.Fatal(err)
			}
			got, err := s.GetProject(ctx, "p1")
			if err != nil {
				t.Fatal(err)
			}
			if got.Name != p.Name || len(got.Claims) != 1 || got.Claims[0].ExpectedValue != 0.81 {
				t.Fatalf("round trip mismatch: %+v", got)
			}
			got.State = domain.StateAwaitingClaims
			got.Error = "none"
			got.UpdatedAt = got.UpdatedAt.Add(time.Minute)
			if err := s.SaveProject(ctx, got); err != nil {
				t.Fatal(err)
			}
			again, err := s.GetProject(ctx, "p1")
			if err != nil {
				t.Fatal(err)
			}
			if again.State != domain.StateAwaitingClaims || again.Error != "none" {
				t.Fatalf("saved state mismatch: %+v", again)
			}
		})
	}
}

func TestEventSequenceAndFiltering(t *testing.T) {
	ctx := context.Background()
	for name, s := range testStores(t) {
		t.Run(name, func(t *testing.T) {
			if err := s.CreateProject(ctx, sampleProject("p2")); err != nil {
				t.Fatal(err)
			}
			first, err := s.AppendEvent(ctx, "p2", "state", "created", map[string]any{"state": "CREATED"})
			if err != nil {
				t.Fatal(err)
			}
			second, err := s.AppendEvent(ctx, "p2", "run", "started", map[string]any{"attempt": 1})
			if err != nil {
				t.Fatal(err)
			}
			if first.Seq != 1 || second.Seq != 2 {
				t.Fatalf("event seqs = %d, %d", first.Seq, second.Seq)
			}
			events, err := s.ListEvents(ctx, "p2", 1)
			if err != nil {
				t.Fatal(err)
			}
			if len(events) != 1 || events[0].Seq != 2 || events[0].Type != "run" {
				t.Fatalf("filtered events = %+v", events)
			}
			if events[0].Data["attempt"] != float64(1) {
				t.Fatalf("event data = %#v", events[0].Data)
			}
		})
	}
}

func TestMissingProjectReturnsErrNotFound(t *testing.T) {
	ctx := context.Background()
	for name, s := range testStores(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := s.GetProject(ctx, "missing"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("err = %v, want ErrNotFound", err)
			}
		})
	}
}
