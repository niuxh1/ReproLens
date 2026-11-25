package domain

import "time"

type State string
type Action string

const (
	StateCreated        State = "CREATED"
	StateInitialized    State = "INITIALIZED"
	StateIngested       State = "INGESTED"
	StateAwaitingClaims State = "AWAITING_CLAIMS"
	StateAwaitingPlan   State = "AWAITING_PLAN"
	StateSandboxReady   State = "SANDBOX_READY"
	StateExecuting      State = "EXECUTING"
	StateAwaitingPatch  State = "AWAITING_PATCH"
	StateRetrying       State = "RETRYING"
	StateVerifying      State = "VERIFYING"
	StateReporting      State = "REPORTING"
	StateCompleted      State = "COMPLETED"
	StateFailed         State = "FAILED"
	StateStopped        State = "STOPPED"
)

const (
	ActionInit                  Action = "init"
	ActionIngest                Action = "ingest"
	ActionExtractClaims         Action = "extract_claims"
	ActionSelectClaims          Action = "select_claims"
	ActionConfirmPlan           Action = "confirm_plan"
	ActionStartExecution        Action = "start_execution"
	ActionRunSucceeded          Action = "run_succeeded"
	ActionRunFailed             Action = "run_failed"
	ActionApprovePatch          Action = "approve_patch"
	ActionRetryStart            Action = "retry_start"
	ActionRejectPatch           Action = "reject_patch"
	ActionVerificationCompleted Action = "verification_completed"
	ActionReportCompleted       Action = "report_completed"
	ActionStop                  Action = "stop"
	ActionFail                  Action = "fail"
)

type Tolerance struct {
	Abs float64 `json:"abs,omitempty"`
	Rel float64 `json:"rel,omitempty"`
}

type ClaimSource struct {
	Path  string `json:"path"`
	Line  int    `json:"line"`
	Quote string `json:"quote,omitempty"`
}

type Claim struct {
	ID            string      `json:"claim_id"`
	Text          string      `json:"text"`
	Metric        string      `json:"metric"`
	ExpectedValue float64     `json:"expected_value"`
	Tolerance     Tolerance   `json:"tolerance"`
	Source        ClaimSource `json:"source"`
	Selected      bool        `json:"selected"`
}

type Paper struct {
	Title      string    `json:"title"`
	Text       string    `json:"text"`
	SourcePath string    `json:"source_path"`
	SHA256     string    `json:"sha256"`
	Claims     []Claim   `json:"claims"`
	ParsedAt   time.Time `json:"parsed_at"`
}

type RepoSummary struct {
	Root              string    `json:"root"`
	Readme            string    `json:"readme,omitempty"`
	Files             []string  `json:"files"`
	CommandCandidates []string  `json:"command_candidates"`
	Requirements      []string  `json:"requirements,omitempty"`
	License           string    `json:"license,omitempty"`
	ScannedAt         time.Time `json:"scanned_at"`
}

type MetricSource struct {
	Kind    string `json:"kind"`
	Path    string `json:"path,omitempty"`
	Pattern string `json:"pattern,omitempty"`
	Key     string `json:"key,omitempty"`
}

type ExperimentPlan struct {
	ID             string       `json:"id"`
	ClaimID        string       `json:"claim_id"`
	Command        string       `json:"command"`
	Image          string       `json:"image"`
	WorkDir        string       `json:"work_dir"`
	Seed           int          `json:"seed"`
	ExpectedMetric string       `json:"expected_metric"`
	ExpectedValue  float64      `json:"expected_value"`
	Tolerance      Tolerance    `json:"tolerance"`
	MetricSource   MetricSource `json:"metric_source"`
	Notes          string       `json:"notes,omitempty"`
	Confirmed      bool         `json:"confirmed"`
}

type Metric struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Raw   string  `json:"raw,omitempty"`
}

type Run struct {
	ID             string            `json:"run_id"`
	Attempt        int               `json:"attempt"`
	Runner         string            `json:"runner"`
	Command        string            `json:"command"`
	Image          string            `json:"image,omitempty"`
	WorkDir        string            `json:"work_dir"`
	Status         string            `json:"status"`
	ExitCode       int               `json:"exit_code"`
	StartedAt      time.Time         `json:"started_at"`
	FinishedAt     time.Time         `json:"finished_at"`
	DurationMS     int64             `json:"duration_ms"`
	StdoutPath     string            `json:"stdout_path,omitempty"`
	StderrPath     string            `json:"stderr_path,omitempty"`
	Stdout         string            `json:"stdout,omitempty"`
	Stderr         string            `json:"stderr,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	ArtifactPaths  []string          `json:"artifact_paths,omitempty"`
	Metric         *Metric           `json:"metric,omitempty"`
	FailureClass   string            `json:"failure_class,omitempty"`
	FailureSummary string            `json:"failure_summary,omitempty"`
}

type Diagnosis struct {
	FailureClass string `json:"failure_class"`
	RootCause    string `json:"root_cause"`
	Confidence   string `json:"confidence"`
	PatchDiff    string `json:"patch_diff,omitempty"`
	Explanation  string `json:"explanation,omitempty"`
}

type PatchProposal struct {
	ID         string     `json:"patch_id"`
	RunID      string     `json:"run_id"`
	Diagnosis  Diagnosis  `json:"diagnosis"`
	Diff       string     `json:"diff"`
	Files      []string   `json:"files"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	AppliedAt  *time.Time `json:"applied_at,omitempty"`
	ApprovedBy string     `json:"approved_by,omitempty"`
}

type Verdict string

const (
	VerdictPass                 Verdict = "PASS"
	VerdictDifferent            Verdict = "DIFFERENT"
	VerdictInsufficientEvidence Verdict = "INSUFFICIENT_EVIDENCE"
	VerdictFailed               Verdict = "FAILED"
)

type Verification struct {
	ID         string    `json:"verification_id"`
	ClaimID    string    `json:"claim_id"`
	Metric     string    `json:"metric"`
	Expected   float64   `json:"expected"`
	Observed   float64   `json:"observed"`
	Tolerance  Tolerance `json:"tolerance"`
	Verdict    Verdict   `json:"verdict"`
	Rule       string    `json:"rule"`
	Evidence   []string  `json:"evidence,omitempty"`
	Note       string    `json:"note,omitempty"`
	VerifiedAt time.Time `json:"verified_at"`
}

type EvidenceRef struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
	Size   int64  `json:"size,omitempty"`
}

type Report struct {
	ID          string        `json:"report_id"`
	GeneratedAt time.Time     `json:"generated_at"`
	Summary     string        `json:"summary"`
	Markdown    string        `json:"markdown"`
	PackagePath string        `json:"package_path,omitempty"`
	Evidence    []EvidenceRef `json:"evidence,omitempty"`
}

type Budget struct {
	MaxRuns    int `json:"max_runs"`
	MaxSeconds int `json:"max_seconds"`
	MaxPatches int `json:"max_patches"`
}

func (b Budget) WithDefaults() Budget {
	if b.MaxRuns <= 0 {
		b.MaxRuns = 3
	}
	if b.MaxSeconds <= 0 {
		b.MaxSeconds = 120
	}
	if b.MaxPatches <= 0 {
		b.MaxPatches = 2
	}
	return b
}

type Project struct {
	ID               string           `json:"id"`
	Name             string           `json:"name"`
	State            State            `json:"state"`
	PaperPath        string           `json:"paper_path"`
	RepoPath         string           `json:"repo_path"`
	DataPath         string           `json:"data_path,omitempty"`
	WorkspacePath    string           `json:"workspace_path"`
	EvidenceDir      string           `json:"evidence_dir"`
	Budget           Budget           `json:"budget"`
	Paper            Paper            `json:"paper"`
	Repo             RepoSummary      `json:"repo"`
	Claims           []Claim          `json:"claims,omitempty"`
	SelectedClaimIDs []string         `json:"selected_claim_ids,omitempty"`
	Plans            []ExperimentPlan `json:"plans,omitempty"`
	Runs             []Run            `json:"runs,omitempty"`
	Patch            *PatchProposal   `json:"patch,omitempty"`
	Verification     *Verification    `json:"verification,omitempty"`
	Report           *Report          `json:"report,omitempty"`
	StopRequested    bool             `json:"stop_requested,omitempty"`
	Error            string           `json:"error,omitempty"`
	CreatedAt        time.Time        `json:"created_at"`
	UpdatedAt        time.Time        `json:"updated_at"`
}

type Event struct {
	ID        int64          `json:"id"`
	ProjectID string         `json:"project_id"`
	Seq       int64          `json:"seq"`
	Type      string         `json:"type"`
	Message   string         `json:"message"`
	Data      map[string]any `json:"data,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
}
