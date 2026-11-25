package store

import (
	"context"
	"errors"

	"reprolens/internal/domain"
)

var ErrNotFound = errors.New("project not found")

type Store interface {
	CreateProject(ctx context.Context, project *domain.Project) error
	GetProject(ctx context.Context, id string) (*domain.Project, error)
	SaveProject(ctx context.Context, project *domain.Project) error
	ListProjects(ctx context.Context) ([]*domain.Project, error)
	AppendEvent(ctx context.Context, projectID, eventType, message string, data map[string]any) (domain.Event, error)
	ListEvents(ctx context.Context, projectID string, after int64) ([]domain.Event, error)
	Close() error
}
