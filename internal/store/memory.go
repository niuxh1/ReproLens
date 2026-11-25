package store

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"

	"reprolens/internal/domain"
)

type Memory struct {
	mu       sync.RWMutex
	projects map[string]*domain.Project
	events   map[string][]domain.Event
}

func NewMemory() *Memory {
	return &Memory{
		projects: map[string]*domain.Project{},
		events:   map[string][]domain.Event{},
	}
}

func (m *Memory) CreateProject(_ context.Context, project *domain.Project) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.projects[project.ID]; exists {
		return ErrDuplicate
	}
	m.projects[project.ID] = cloneProject(project)
	return nil
}

func (m *Memory) GetProject(_ context.Context, id string) (*domain.Project, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.projects[id]
	if !ok {
		return nil, ErrNotFound
	}
	return cloneProject(p), nil
}

func (m *Memory) SaveProject(_ context.Context, project *domain.Project) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.projects[project.ID]; !ok {
		return ErrNotFound
	}
	m.projects[project.ID] = cloneProject(project)
	return nil
}

func (m *Memory) ListProjects(_ context.Context) ([]*domain.Project, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*domain.Project, 0, len(m.projects))
	for _, p := range m.projects {
		out = append(out, cloneProject(p))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func (m *Memory) AppendEvent(_ context.Context, projectID, eventType, message string, data map[string]any) (domain.Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.projects[projectID]; !ok {
		return domain.Event{}, ErrNotFound
	}
	events := m.events[projectID]
	ev := domain.Event{
		ProjectID: projectID,
		Seq:       int64(len(events) + 1),
		Type:      eventType,
		Message:   message,
		Data:      cloneMap(data),
		CreatedAt: time.Now().UTC(),
	}
	m.events[projectID] = append(events, ev)
	return ev, nil
}

func (m *Memory) ListEvents(_ context.Context, projectID string, after int64) ([]domain.Event, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	events := m.events[projectID]
	out := make([]domain.Event, 0, len(events))
	for _, ev := range events {
		if ev.Seq > after {
			ev.Data = cloneMap(ev.Data)
			out = append(out, ev)
		}
	}
	return out, nil
}

func (m *Memory) Close() error { return nil }

func cloneProject(p *domain.Project) *domain.Project {
	if p == nil {
		return nil
	}
	b, err := json.Marshal(p)
	if err != nil {
		return nil
	}
	var out domain.Project
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return &out
}

func cloneMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	b, err := json.Marshal(in)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return out
}
