package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"reprolens/internal/domain"
)

type OpenAICompatibleAnalyzer struct {
	baseURL string
	apiKey  string
	model   string
	client  *http.Client
}

func NewOpenAICompatible(baseURL, apiKey, model string, timeout time.Duration) (*OpenAICompatibleAnalyzer, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, fmt.Errorf("LLM base URL is empty")
	}
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("invalid LLM base URL %q", baseURL)
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("LLM API key is empty")
	}
	if strings.TrimSpace(model) == "" {
		return nil, fmt.Errorf("LLM model is empty")
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &OpenAICompatibleAnalyzer{
		baseURL: baseURL,
		apiKey:  strings.TrimSpace(apiKey),
		model:   strings.TrimSpace(model),
		client:  &http.Client{Timeout: timeout},
	}, nil
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model          string         `json:"model"`
	Messages       []chatMessage  `json:"messages"`
	Temperature    float64        `json:"temperature"`
	MaxTokens      int            `json:"max_tokens,omitempty"`
	ResponseFormat map[string]any `json:"response_format,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type httpStatusError struct {
	Status int
	Body   string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("LLM request failed with HTTP %d: %s", e.Status, e.Body)
}

func (a *OpenAICompatibleAnalyzer) ExtractClaims(ctx context.Context, paper domain.Paper, repo domain.RepoSummary) ([]domain.Claim, error) {
	numbered := numberLines(paper.Text)
	prompt := "Extract measurable experimental claims from the paper. Return only JSON with shape " +
		`{"claims":[{"claim_id":"C1","text":"...","metric":"accuracy","expected_value":0.81,"tolerance":{"abs":0.01,"rel":0},"source":{"line":3,"quote":"..."}}]}. ` +
		"Only include claims backed by a numeric metric in the supplied text. Every source.line must refer to the numbered line. " +
		"Never invent a value. Repository summary (may be empty):\n" + summarizeRepo(repo) + "\n\nNumbered paper:\n" + numbered
	content, err := a.chat(ctx, "You are a conservative scientific claim extractor. Return valid JSON only.", prompt)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Claims []domain.Claim `json:"claims"`
	}
	if err := decodeJSONObject(content, &envelope); err != nil {
		return nil, fmt.Errorf("parse claims JSON: %w", err)
	}
	if len(envelope.Claims) == 0 {
		return nil, fmt.Errorf("LLM returned no measurable claims")
	}
	if len(envelope.Claims) > 20 {
		envelope.Claims = envelope.Claims[:20]
	}
	lineCount := len(strings.Split(paper.Text, "\n"))
	for i := range envelope.Claims {
		c := &envelope.Claims[i]
		c.ID = strings.TrimSpace(c.ID)
		if c.ID == "" {
			c.ID = fmt.Sprintf("C%d", i+1)
		}
		c.Text = strings.TrimSpace(c.Text)
		c.Metric = normalizeMetric(c.Metric)
		if c.Metric == "" || math.IsNaN(c.ExpectedValue) || math.IsInf(c.ExpectedValue, 0) {
			return nil, fmt.Errorf("LLM returned invalid claim %d", i+1)
		}
		if c.Tolerance.Abs < 0 || c.Tolerance.Rel < 0 {
			return nil, fmt.Errorf("LLM returned negative tolerance")
		}
		if c.Tolerance.Abs == 0 && c.Tolerance.Rel == 0 {
			c.Tolerance.Abs = 0.01
		}
		c.Source.Path = paper.SourcePath
		if c.Source.Line < 1 || c.Source.Line > lineCount {
			c.Source.Line = 0
		}
	}
	return envelope.Claims, nil
}

func (a *OpenAICompatibleAnalyzer) BuildPlan(ctx context.Context, claim domain.Claim, paper domain.Paper, repo domain.RepoSummary) (*domain.ExperimentPlan, error) {
	prompt := "Build one reproducible experiment plan for the selected claim. Return only JSON with shape " +
		`{"command":"python run.py --seed 42","image":"python:3.11-slim","work_dir":".","seed":42,"metric_source":{"kind":"stdout_regex","path":"","pattern":"(?i)accuracy\\s*[:=]\\s*([0-9.]+)"},"notes":"..."}. ` +
		"Use a single shell command without pipes, redirection, command substitution, or multiple statements. " +
		"Prefer a command documented in the paper or README. Do not change the selected claim or its expected value.\n\n" +
		"Claim:\n" + claimSummary(claim) + "\n\nRepository:\n" + summarizeRepo(repo) + "\n\nPaper excerpt:\n" + truncate(paper.Text, 12000)
	content, err := a.chat(ctx, "You are a conservative computational reproduction planner. Return valid JSON only.", prompt)
	if err != nil {
		return nil, err
	}
	var plan domain.ExperimentPlan
	if err := decodeJSONObject(content, &plan); err != nil {
		return nil, fmt.Errorf("parse plan JSON: %w", err)
	}
	plan.ClaimID = claim.ID
	plan.ExpectedMetric = normalizeMetric(claim.Metric)
	plan.ExpectedValue = claim.ExpectedValue
	plan.Tolerance = claim.Tolerance
	if strings.TrimSpace(plan.Command) == "" {
		return nil, fmt.Errorf("LLM returned an empty command")
	}
	plan.Command = strings.TrimSpace(plan.Command)
	if err := validateCommand(plan.Command); err != nil {
		return nil, err
	}
	if plan.Image == "" {
		plan.Image = "python:3.11-slim"
	}
	if plan.WorkDir == "" {
		plan.WorkDir = "."
	}
	if plan.ID == "" {
		plan.ID = "plan_" + strings.ToLower(claim.ID)
	}
	if plan.MetricSource.Kind == "" {
		plan.MetricSource.Kind = "stdout_regex"
	}
	if plan.MetricSource.Key == "" {
		plan.MetricSource.Key = plan.ExpectedMetric
	}
	if plan.MetricSource.Kind == "stdout_regex" && plan.MetricSource.Pattern == "" {
		plan.MetricSource.Pattern = `(?i)` + regexp.QuoteMeta(plan.ExpectedMetric) + `\s*[:=]\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))`
	}
	if plan.MetricSource.Kind == "stdout_regex" {
		if _, err := regexp.Compile(plan.MetricSource.Pattern); err != nil {
			return nil, fmt.Errorf("invalid metric regex: %w", err)
		}
	}
	return &plan, nil
}

func (a *OpenAICompatibleAnalyzer) Diagnose(ctx context.Context, run domain.Run, repo domain.RepoSummary, _ string) (*domain.Diagnosis, error) {
	prompt := "Diagnose this failed computational experiment. Return only JSON with shape " +
		`{"failure_class":"seed_mismatch|dependency_missing|path_error|syntax_error|timeout|unknown","root_cause":"...","confidence":"high|medium|low","patch_diff":"optional unified diff","explanation":"..."}. ` +
		"Do not propose changing the data split, metric definition, or expected paper value. A patch must be minimal and expressed as a git-compatible unified diff. " +
		"If no safe patch is supported, leave patch_diff empty.\n\nRun:\n" + runSummary(run) + "\n\nRepository:\n" + summarizeRepo(repo)
	content, err := a.chat(ctx, "You are a conservative computational reproduction debugger. Return valid JSON only.", prompt)
	if err != nil {
		return nil, err
	}
	var diagnosis domain.Diagnosis
	if err := decodeJSONObject(content, &diagnosis); err != nil {
		return nil, fmt.Errorf("parse diagnosis JSON: %w", err)
	}
	diagnosis.FailureClass = strings.TrimSpace(diagnosis.FailureClass)
	if diagnosis.FailureClass == "" {
		diagnosis.FailureClass = "unknown"
	}
	if diagnosis.Confidence != "high" && diagnosis.Confidence != "medium" && diagnosis.Confidence != "low" {
		diagnosis.Confidence = "low"
	}
	if diagnosis.PatchDiff != "" && !strings.Contains(diagnosis.PatchDiff, "--- a/") {
		diagnosis.PatchDiff = ""
	}
	return &diagnosis, nil
}

func (a *OpenAICompatibleAnalyzer) chat(ctx context.Context, system, user string) (string, error) {
	req := chatRequest{
		Model: a.model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature:    0.1,
		MaxTokens:      4096,
		ResponseFormat: map[string]any{"type": "json_object"},
	}
	content, err := a.doChat(ctx, req)
	if err != nil {
		var statusErr *httpStatusError
		if errorsAs(err, &statusErr) && (statusErr.Status == http.StatusBadRequest || statusErr.Status == http.StatusUnprocessableEntity) {
			req.ResponseFormat = nil
			return a.doChat(ctx, req)
		}
	}
	return content, err
}

func (a *OpenAICompatibleAnalyzer) doChat(ctx context.Context, payload chatRequest) (string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+a.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("call LLM: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 600 {
			snippet = snippet[:600]
		}
		return "", &httpStatusError{Status: resp.StatusCode, Body: snippet}
	}
	var parsed chatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("decode LLM response: %w", err)
	}
	if parsed.Error != nil {
		return "", fmt.Errorf("LLM error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 || strings.TrimSpace(parsed.Choices[0].Message.Content) == "" {
		return "", fmt.Errorf("LLM returned no message content")
	}
	return strings.TrimSpace(parsed.Choices[0].Message.Content), nil
}

func decodeJSONObject(content string, dst any) error {
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start < 0 || end <= start {
		return fmt.Errorf("no JSON object found")
	}
	return json.Unmarshal([]byte(content[start:end+1]), dst)
}

func numberLines(text string) string {
	lines := strings.Split(text, "\n")
	var b strings.Builder
	for i, line := range lines {
		fmt.Fprintf(&b, "[L%d] %s\n", i+1, line)
	}
	return b.String()
}

func summarizeRepo(repo domain.RepoSummary) string {
	var b strings.Builder
	if repo.Readme != "" {
		b.WriteString("README:\n")
		b.WriteString(truncate(repo.Readme, 8000))
		b.WriteString("\n")
	}
	if len(repo.Files) > 0 {
		b.WriteString("Files: " + strings.Join(limitStrings(repo.Files, 80), ", ") + "\n")
	}
	if len(repo.CommandCandidates) > 0 {
		b.WriteString("Commands: " + strings.Join(repo.CommandCandidates, " | ") + "\n")
	}
	if len(repo.Requirements) > 0 {
		b.WriteString("Requirements: " + strings.Join(repo.Requirements, ", ") + "\n")
	}
	return b.String()
}

func claimSummary(claim domain.Claim) string {
	return fmt.Sprintf("id=%s metric=%s expected=%v tolerance_abs=%v tolerance_rel=%v source=%s:%d text=%s",
		claim.ID, claim.Metric, claim.ExpectedValue, claim.Tolerance.Abs, claim.Tolerance.Rel,
		claim.Source.Path, claim.Source.Line, claim.Text)
}

func runSummary(run domain.Run) string {
	return fmt.Sprintf("status=%s exit=%d runner=%s command=%s\nstdout:\n%s\nstderr:\n%s",
		run.Status, run.ExitCode, run.Runner, run.Command, truncate(run.Stdout, 8000), truncate(run.Stderr, 8000))
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n...[truncated]"
}

func limitStrings(in []string, max int) []string {
	if len(in) <= max {
		return in
	}
	return in[:max]
}

var allowedCommandRE = regexp.MustCompile(`(?i)^\s*(python(?:3)?|pytest|rscript|bash|sh|go\s+test|node|uv\s+run|poetry\s+run|pip(?:3)?)\b`)

func validateCommand(command string) error {
	if strings.ContainsAny(command, "\r\n") {
		return fmt.Errorf("command must be a single line")
	}
	if strings.Contains(command, "&&") || strings.Contains(command, "||") || strings.Contains(command, ";") ||
		strings.Contains(command, "|") || strings.Contains(command, ">") || strings.Contains(command, "<") ||
		strings.Contains(command, "`") || strings.Contains(command, "$(") {
		return fmt.Errorf("command contains unsupported shell composition")
	}
	if !allowedCommandRE.MatchString(command) {
		return fmt.Errorf("command executable is not allowed: %q", command)
	}
	return nil
}

func errorsAs(err error, target any) bool {
	type unwrapper interface{ Unwrap() error }
	for err != nil {
		if e, ok := err.(*httpStatusError); ok {
			if p, ok := target.(**httpStatusError); ok {
				*p = e
				return true
			}
		}
		u, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

var _ = strconv.Itoa
