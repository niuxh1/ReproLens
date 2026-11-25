package codeagent

import (
	"context"
	"time"

	"reprolens/internal/domain"
)

type Task struct {
	ProjectID         string
	ClaimID           string
	Workspace         string
	EvidenceDir       string
	AcceptanceCommand string
	Paper             domain.Paper
	Claim             domain.Claim
	Plan              domain.ExperimentPlan
	Run               domain.Run
	Diagnosis         domain.Diagnosis
}

type Result struct {
	Agent    string
	Version  string
	Diff     string
	Files    []string
	Summary  string
	Stdout   string
	Stderr   string
	LogPath  string
	Duration time.Duration
}

type Agent interface {
	Name() string
	Propose(ctx context.Context, task Task) (*Result, error)
}
