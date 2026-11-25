package orchestrator

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"reprolens/internal/agent"
	"reprolens/internal/domain"
	"reprolens/internal/store"
	"reprolens/internal/tools"
)

var ErrProjectBusy = errors.New("project already has a running job")

type CreateInput struct {
	Name      string
	PaperPath string
	RepoPath  string
	DataPath  string
	Budget    domain.Budget
}

type Orchestrator struct {
	store    store.Store
	analyzer agent.Analyzer
	runner   tools.Runner
	dataDir  string

	mu   sync.Mutex
	jobs map[string]context.CancelFunc
}

func New(s store.Store, analyzer agent.Analyzer, runner tools.Runner, dataDir string) *Orchestrator {
	return &Orchestrator{
		store: s, analyzer: analyzer, runner: runner, dataDir: dataDir,
		jobs: map[string]context.CancelFunc{},
	}
}

func (o *Orchestrator) CreateProject(ctx context.Context, input CreateInput) (*domain.Project, error) {
	if o == nil || o.store == nil || o.analyzer == nil || o.runner == nil {
		return nil, fmt.Errorf("orchestrator is not fully configured")
	}
	paperPath, err := absoluteExistingPath(input.PaperPath, false)
	if err != nil {
		return nil, fmt.Errorf("paper path: %w", err)
	}
	repoPath, err := absoluteExistingPath(input.RepoPath, true)
	if err != nil {
		return nil, fmt.Errorf("repository path: %w", err)
	}
	dataPath := ""
	if strings.TrimSpace(input.DataPath) != "" {
		dataPath, err = absoluteExistingPath(input.DataPath, false)
		if err != nil {
			return nil, fmt.Errorf("data path: %w", err)
		}
	}
	id := newID("proj")
	ws, err := tools.NewWorkspace(o.dataDir, id)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = filepath.Base(repoPath)
	}
	now := time.Now().UTC()
	project := &domain.Project{
		ID: id, Name: name, State: domain.StateCreated,
		PaperPath: paperPath, RepoPath: repoPath, DataPath: dataPath,
		WorkspacePath: ws.Root, EvidenceDir: ws.EvidenceDir,
		Budget: input.Budget.WithDefaults(), CreatedAt: now, UpdatedAt: now,
	}
	if err := o.store.CreateProject(ctx, project); err != nil {
		return nil, err
	}
	if _, err := o.appendEvent(ctx, project.ID, "project_created", "project created", map[string]any{"paper": paperPath, "repo": repoPath}); err != nil {
		return nil, err
	}
	return project, nil
}

func (o *Orchestrator) Start(ctx context.Context, projectID string) (*domain.Project, error) {
	jobCtx, done, err := o.beginJob(ctx, projectID)
	if err != nil {
		return nil, err
	}
	defer done()
	project, err := o.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if project.State != domain.StateCreated {
		return project, fmt.Errorf("start requires CREATED state, got %s", project.State)
	}
	if err := o.transition(ctx, project, domain.ActionInit, "initializing isolated workspace"); err != nil {
		return project, err
	}
	ws, err := tools.NewWorkspace(o.dataDir, project.ID)
	if err != nil {
		return o.failProject(ctx, project, err)
	}
	if err := ws.CopyRepo(project.RepoPath); err != nil {
		return o.failProject(ctx, project, err)
	}
	if _, err := o.appendEvent(ctx, project.ID, "repository_copied", "repository copied into isolated workspace", map[string]any{"workspace": ws.Root}); err != nil {
		return o.failProject(ctx, project, err)
	}
	paper, err := tools.ParsePaper(project.PaperPath)
	if err != nil {
		return o.failProject(ctx, project, err)
	}
	repo, err := tools.ScanRepo(ws.Root)
	if err != nil {
		return o.failProject(ctx, project, err)
	}
	project.Paper = paper
	project.Repo = repo
	if err := o.saveProject(ctx, project); err != nil {
		return o.failProject(ctx, project, err)
	}
	if err := o.transition(ctx, project, domain.ActionIngest, "paper and repository ingested"); err != nil {
		return o.failProject(ctx, project, err)
	}
	claims, err := o.analyzer.ExtractClaims(jobCtx, paper, repo)
	if err != nil {
		return o.failProject(ctx, project, err)
	}
	for i := range claims {
		claims[i].Selected = false
	}
	project.Claims = claims
	if err := o.transition(ctx, project, domain.ActionExtractClaims, "candidate claims extracted"); err != nil {
		return o.failProject(ctx, project, err)
	}
	if err := o.saveProject(ctx, project); err != nil {
		return o.failProject(ctx, project, err)
	}
	if _, err := o.appendEvent(ctx, project.ID, "claims_extracted", fmt.Sprintf("%d measurable claims found", len(claims)), map[string]any{"count": len(claims)}); err != nil {
		return project, err
	}
	return project, nil
}

func (o *Orchestrator) SelectClaims(ctx context.Context, projectID string, claimIDs []string) (*domain.Project, error) {
	jobCtx, done, err := o.beginJob(ctx, projectID)
	if err != nil {
		return nil, err
	}
	defer done()
	project, err := o.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if project.State != domain.StateAwaitingClaims {
		return project, fmt.Errorf("claim selection requires AWAITING_CLAIMS state, got %s", project.State)
	}
	if len(claimIDs) == 0 {
		return project, fmt.Errorf("select at least one claim")
	}
	wanted := map[string]bool{}
	for _, id := range claimIDs {
		wanted[strings.ToUpper(strings.TrimSpace(id))] = true
	}
	var selected []string
	selectedSet := map[string]bool{}
	for i := range project.Claims {
		c := &project.Claims[i]
		selectedNow := wanted[strings.ToUpper(c.ID)]
		c.Selected = selectedNow
		if selectedNow {
			selected = append(selected, c.ID)
			selectedSet[c.ID] = true
		}
	}
	if len(selected) == 0 {
		return project, fmt.Errorf("selected claim ids do not match any extracted claim")
	}
	project.SelectedClaimIDs = selected
	if err := o.transition(ctx, project, domain.ActionSelectClaims, "claims selected; building experiment plans"); err != nil {
		return project, err
	}
	project.Plans = nil
	for _, claim := range project.Claims {
		if !selectedSet[claim.ID] {
			continue
		}
		plan, err := o.analyzer.BuildPlan(jobCtx, claim, project.Paper, project.Repo)
		if err != nil {
			return o.failProject(ctx, project, err)
		}
		if plan.ID == "" {
			plan.ID = "plan_" + strings.ToLower(claim.ID)
		}
		plan.ClaimID = claim.ID
		plan.Confirmed = false
		project.Plans = append(project.Plans, *plan)
	}
	project.CurrentPlanIndex = 0
	if err := o.saveProject(ctx, project); err != nil {
		return o.failProject(ctx, project, err)
	}
	if _, err := o.appendEvent(ctx, project.ID, "plans_ready", fmt.Sprintf("%d experiment plan(s) generated", len(project.Plans)), map[string]any{"plans": len(project.Plans)}); err != nil {
		return project, err
	}
	return project, nil
}

func (o *Orchestrator) ConfirmPlan(ctx context.Context, projectID string) (*domain.Project, error) {
	jobCtx, done, err := o.beginJob(ctx, projectID)
	if err != nil {
		return nil, err
	}
	defer done()
	project, err := o.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if project.State != domain.StateAwaitingPlan {
		return project, fmt.Errorf("plan confirmation requires AWAITING_PLAN state, got %s", project.State)
	}
	if len(project.Plans) == 0 {
		return project, fmt.Errorf("no experiment plans to confirm")
	}
	for i := range project.Plans {
		project.Plans[i].Confirmed = true
	}
	project.CurrentPlanIndex = 0
	if err := o.transition(ctx, project, domain.ActionConfirmPlan, "experiment plan confirmed by user"); err != nil {
		return project, err
	}
	if _, err := os.Stat(project.WorkspacePath); err != nil {
		return o.failProject(ctx, project, fmt.Errorf("workspace unavailable: %w", err))
	}
	if _, err := o.appendEvent(ctx, project.ID, "sandbox_ready", "execution workspace prepared", map[string]any{"runner": o.runner.Name()}); err != nil {
		return project, err
	}
	if err := o.transition(ctx, project, domain.ActionStartExecution, "starting controlled execution"); err != nil {
		return project, err
	}
	return o.executePlans(jobCtx, project)
}

func (o *Orchestrator) ApprovePatch(ctx context.Context, projectID, approvedBy string) (*domain.Project, error) {
	jobCtx, done, err := o.beginJob(ctx, projectID)
	if err != nil {
		return nil, err
	}
	defer done()
	project, err := o.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if project.State != domain.StateAwaitingPatch {
		return project, fmt.Errorf("patch approval requires AWAITING_PATCH state, got %s", project.State)
	}
	if project.Patch == nil || project.Patch.Status != "proposed" {
		return project, fmt.Errorf("no proposed patch is available")
	}
	if strings.TrimSpace(approvedBy) == "" {
		approvedBy = "local-user"
	}
	project.Patch.ApprovedBy = approvedBy
	project.Patch.Status = "approved"
	if err := o.saveProject(ctx, project); err != nil {
		return project, err
	}
	if _, err := o.appendEvent(ctx, project.ID, "patch_approved", "human approved patch application", map[string]any{
		"patch_id": project.Patch.ID, "claim_id": project.Patch.ClaimID, "approved_by": approvedBy,
		"diff_sha256": hashString(project.Patch.Diff),
	}); err != nil {
		return project, err
	}
	if err := o.transition(ctx, project, domain.ActionApprovePatch, "applying approved patch"); err != nil {
		return project, err
	}
	if err := o.checkStopped(jobCtx, project); err != nil {
		return project, err
	}
	pm := &tools.PatchManager{Workspace: project.WorkspacePath}
	files, err := pm.Apply(project.Patch.Diff)
	if err != nil {
		project.Patch.Status = "apply_failed"
		_ = o.saveProject(ctx, project)
		return o.failProject(ctx, project, err)
	}
	now := time.Now().UTC()
	project.Patch.Status = "applied"
	project.Patch.AppliedAt = &now
	project.Patch.Files = files
	if err := o.saveProject(ctx, project); err != nil {
		return project, err
	}
	if _, err := o.appendEvent(ctx, project.ID, "patch_applied", "approved patch applied", map[string]any{"patch_id": project.Patch.ID, "files": files}); err != nil {
		return project, err
	}
	if err := o.transition(ctx, project, domain.ActionRetryStart, "retrying experiment after approved patch"); err != nil {
		return project, err
	}
	return o.executePlans(jobCtx, project)
}

func (o *Orchestrator) RejectPatch(ctx context.Context, projectID, reason string) (*domain.Project, error) {
	_, done, err := o.beginJob(ctx, projectID)
	if err != nil {
		return nil, err
	}
	defer done()
	project, err := o.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if project.State != domain.StateAwaitingPatch {
		return project, fmt.Errorf("patch rejection requires AWAITING_PATCH state, got %s", project.State)
	}
	if project.Patch == nil {
		return project, fmt.Errorf("no patch proposal is available")
	}
	project.Patch.Status = "rejected"
	if strings.TrimSpace(reason) == "" {
		reason = "patch rejected by user"
	}
	project.Error = reason
	if err := o.saveProject(ctx, project); err != nil {
		return project, err
	}
	if _, err := o.appendEvent(ctx, project.ID, "patch_rejected", reason, map[string]any{"patch_id": project.Patch.ID}); err != nil {
		return project, err
	}
	if err := o.transition(ctx, project, domain.ActionRejectPatch, "patch rejected; run stopped"); err != nil {
		return project, err
	}
	return project, nil
}

func (o *Orchestrator) Stop(ctx context.Context, projectID string) (*domain.Project, error) {
	project, err := o.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if project.State.Terminal() {
		return project, nil
	}
	project.StopRequested = true
	project.UpdatedAt = time.Now().UTC()
	if err := o.store.SaveProject(ctx, project); err != nil {
		return project, err
	}
	if _, err := o.appendEvent(ctx, project.ID, "stop_requested", "stop requested by user", nil); err != nil {
		return project, err
	}
	o.mu.Lock()
	cancel := o.jobs[projectID]
	o.mu.Unlock()
	if cancel != nil {
		cancel()
		return project, nil
	}
	latest, err := o.GetProject(ctx, projectID)
	if err != nil {
		return project, err
	}
	if latest.State.Terminal() {
		return latest, nil
	}
	if err := o.transition(ctx, latest, domain.ActionStop, "workflow stopped"); err != nil {
		return latest, err
	}
	return latest, nil
}

func (o *Orchestrator) GetProject(ctx context.Context, projectID string) (*domain.Project, error) {
	return o.store.GetProject(ctx, projectID)
}

func (o *Orchestrator) ListProjects(ctx context.Context) ([]*domain.Project, error) {
	return o.store.ListProjects(ctx)
}

func (o *Orchestrator) Events(ctx context.Context, projectID string, after int64) ([]domain.Event, error) {
	return o.store.ListEvents(ctx, projectID, after)
}

func (o *Orchestrator) beginJob(parent context.Context, projectID string) (context.Context, func(), error) {
	if parent == nil {
		parent = context.Background()
	}
	o.mu.Lock()
	if _, busy := o.jobs[projectID]; busy {
		o.mu.Unlock()
		return nil, nil, ErrProjectBusy
	}
	ctx, cancel := context.WithCancel(parent)
	o.jobs[projectID] = cancel
	o.mu.Unlock()
	done := func() {
		cancel()
		o.mu.Lock()
		delete(o.jobs, projectID)
		o.mu.Unlock()
	}
	return ctx, done, nil
}

func (o *Orchestrator) transition(ctx context.Context, project *domain.Project, action domain.Action, message string) error {
	from := project.State
	next, ok := domain.CanTransition(from, action)
	if !ok {
		return fmt.Errorf("invalid transition: %s + %s", from, action)
	}
	project.State = next
	project.UpdatedAt = time.Now().UTC()
	if err := o.store.SaveProject(ctx, project); err != nil {
		return err
	}
	_, err := o.appendEvent(ctx, project.ID, "state_changed", message, map[string]any{"from": from, "to": next, "action": action})
	return err
}

func (o *Orchestrator) saveProject(ctx context.Context, project *domain.Project) error {
	project.UpdatedAt = time.Now().UTC()
	return o.store.SaveProject(ctx, project)
}

func (o *Orchestrator) appendEvent(ctx context.Context, projectID, eventType, message string, data map[string]any) (domain.Event, error) {
	return o.store.AppendEvent(ctx, projectID, eventType, message, data)
}

func (o *Orchestrator) failProject(ctx context.Context, project *domain.Project, cause error) (*domain.Project, error) {
	if errors.Is(cause, context.Canceled) || project.StopRequested {
		return o.stopProject(ctx, project)
	}
	project.Error = cause.Error()
	if next, ok := domain.CanTransition(project.State, domain.ActionFail); ok {
		project.State = next
	}
	project.UpdatedAt = time.Now().UTC()
	if err := o.store.SaveProject(ctx, project); err != nil {
		return project, err
	}
	_, _ = o.appendEvent(ctx, project.ID, "workflow_failed", cause.Error(), nil)
	return project, cause
}

func (o *Orchestrator) stopProject(ctx context.Context, project *domain.Project) (*domain.Project, error) {
	project.StopRequested = true
	project.Error = "workflow stopped by user"
	if next, ok := domain.CanTransition(project.State, domain.ActionStop); ok {
		project.State = next
	}
	project.UpdatedAt = time.Now().UTC()
	if err := o.store.SaveProject(ctx, project); err != nil {
		return project, err
	}
	_, _ = o.appendEvent(ctx, project.ID, "workflow_stopped", "workflow stopped", nil)
	return project, nil
}

func (o *Orchestrator) checkStopped(ctx context.Context, project *domain.Project) error {
	if ctx.Err() != nil || project.StopRequested {
		_, err := o.stopProject(context.Background(), project)
		if err != nil {
			return err
		}
		return context.Canceled
	}
	return nil
}

func absoluteExistingPath(path string, dir bool) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("path is empty")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if dir && !info.IsDir() {
		return "", fmt.Errorf("not a directory")
	}
	if !dir && info.IsDir() {
		return "", fmt.Errorf("is a directory")
	}
	return abs, nil
}

func newID(prefix string) string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}

func hashString(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
