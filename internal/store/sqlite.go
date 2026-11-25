package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"reprolens/internal/domain"
)

type SQLite struct {
	db *sql.DB
}

func NewSQLite(path string) (*SQLite, error) {
	if path == "" {
		return nil, fmt.Errorf("sqlite path is empty")
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create sqlite directory: %w", err)
		}
	}
	dsn := "file:" + filepath.ToSlash(path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &SQLite{db: db}
	if err := s.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *SQLite) migrate(ctx context.Context) error {
	statements := []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA busy_timeout=5000`,
		`PRAGMA foreign_keys=ON`,
		`CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			state TEXT NOT NULL,
			payload BLOB NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			type TEXT NOT NULL,
			message TEXT NOT NULL,
			data_json TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(project_id, seq),
			FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, seq)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("sqlite migration: %w", err)
		}
	}
	return nil
}

func (s *SQLite) CreateProject(ctx context.Context, project *domain.Project) error {
	if project == nil {
		return fmt.Errorf("project is nil")
	}
	if project.CreatedAt.IsZero() {
		project.CreatedAt = time.Now().UTC()
	}
	if project.UpdatedAt.IsZero() {
		project.UpdatedAt = project.CreatedAt
	}
	payload, err := json.Marshal(project)
	if err != nil {
		return fmt.Errorf("marshal project: %w", err)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO projects(id, state, payload, updated_at) VALUES(?, ?, ?, ?)`,
		project.ID, string(project.State), payload, project.UpdatedAt.Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("insert project: %w", err)
	}
	return nil
}

func (s *SQLite) GetProject(ctx context.Context, id string) (*domain.Project, error) {
	var payload []byte
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM projects WHERE id = ?`, id).Scan(&payload)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("select project: %w", err)
	}
	var project domain.Project
	if err := json.Unmarshal(payload, &project); err != nil {
		return nil, fmt.Errorf("unmarshal project: %w", err)
	}
	return &project, nil
}

func (s *SQLite) SaveProject(ctx context.Context, project *domain.Project) error {
	if project == nil {
		return fmt.Errorf("project is nil")
	}
	if project.UpdatedAt.IsZero() {
		project.UpdatedAt = time.Now().UTC()
	}
	payload, err := json.Marshal(project)
	if err != nil {
		return fmt.Errorf("marshal project: %w", err)
	}
	result, err := s.db.ExecContext(ctx,
		`UPDATE projects SET state = ?, payload = ?, updated_at = ? WHERE id = ?`,
		string(project.State), payload, project.UpdatedAt.Format(time.RFC3339Nano), project.ID,
	)
	if err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLite) ListProjects(ctx context.Context) ([]*domain.Project, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT payload FROM projects ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	var projects []*domain.Project
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		var project domain.Project
		if err := json.Unmarshal(payload, &project); err != nil {
			return nil, err
		}
		projects = append(projects, &project)
	}
	return projects, rows.Err()
}

func (s *SQLite) AppendEvent(ctx context.Context, projectID, eventType, message string, data map[string]any) (domain.Event, error) {
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return domain.Event{}, fmt.Errorf("marshal event data: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Event{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM projects WHERE id = ?`, projectID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			return domain.Event{}, ErrNotFound
		}
		return domain.Event{}, err
	}
	var seq int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE project_id = ?`, projectID,
	).Scan(&seq); err != nil {
		return domain.Event{}, err
	}
	created := time.Now().UTC()
	result, err := tx.ExecContext(ctx,
		`INSERT INTO events(project_id, seq, type, message, data_json, created_at) VALUES(?, ?, ?, ?, ?, ?)`,
		projectID, seq, eventType, message, string(dataJSON), created.Format(time.RFC3339Nano),
	)
	if err != nil {
		return domain.Event{}, fmt.Errorf("insert event: %w", err)
	}
	id, _ := result.LastInsertId()
	if err := tx.Commit(); err != nil {
		return domain.Event{}, err
	}
	return domain.Event{
		ID: id, ProjectID: projectID, Seq: seq, Type: eventType, Message: message,
		Data: cloneMap(data), CreatedAt: created,
	}, nil
}

func (s *SQLite) ListEvents(ctx context.Context, projectID string, after int64) ([]domain.Event, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, project_id, seq, type, message, COALESCE(data_json, '{}'), created_at
		 FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC`, projectID, after,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []domain.Event
	for rows.Next() {
		var ev domain.Event
		var dataJSON, created string
		if err := rows.Scan(&ev.ID, &ev.ProjectID, &ev.Seq, &ev.Type, &ev.Message, &dataJSON, &created); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(dataJSON), &ev.Data); err != nil {
			return nil, err
		}
		ev.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
		events = append(events, ev)
	}
	return events, rows.Err()
}

func (s *SQLite) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}
