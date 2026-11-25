package tools

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"reprolens/internal/domain"
)

func BuildReport(project *domain.Project, events []domain.Event) (domain.Report, error) {
	if project == nil {
		return domain.Report{}, fmt.Errorf("project is nil")
	}
	now := time.Now().UTC()
	summary := "No rule-based verification has been recorded."
	if project.Verification != nil {
		summary = fmt.Sprintf("%s: observed %.6g vs expected %.6g for %s",
			project.Verification.Verdict, project.Verification.Observed, project.Verification.Expected, project.Verification.Metric)
	}
	report := domain.Report{
		ID:          "report_" + project.ID,
		GeneratedAt: now,
		Summary:     summary,
		Evidence:    reportEvidence(project),
	}
	report.Markdown = renderReportMarkdown(project, events, report)
	return report, nil
}

func ExportPackage(project *domain.Project, report domain.Report, events []domain.Event) (string, error) {
	if project == nil {
		return "", fmt.Errorf("project is nil")
	}
	if project.EvidenceDir == "" {
		return "", fmt.Errorf("project evidence directory is empty")
	}
	exportsDir := filepath.Join(project.EvidenceDir, "exports")
	if err := os.MkdirAll(exportsDir, 0o755); err != nil {
		return "", err
	}
	name := sanitizeFileName(project.ID) + "-reprolens-" + time.Now().UTC().Format("20060102T150405") + ".zip"
	dest := filepath.Join(exportsDir, name)
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	zw := zip.NewWriter(f)
	closeWithError := func(err error) (string, error) {
		_ = zw.Close()
		_ = f.Close()
		return "", err
	}
	manifest := map[string]any{
		"schema_version": 1,
		"project_id":     project.ID,
		"name":           project.Name,
		"state":          project.State,
		"generated_at":   report.GeneratedAt,
		"snapshot":       project.Verification,
		"patch":          project.Patch,
		"run_count":      len(project.Runs),
		"report_summary": report.Summary,
	}
	if err := addZipJSON(zw, "manifest.json", manifest); err != nil {
		return closeWithError(err)
	}
	if err := addZipJSON(zw, "project.json", project); err != nil {
		return closeWithError(err)
	}
	if err := addZipJSON(zw, "events.json", events); err != nil {
		return closeWithError(err)
	}
	if err := addZipBytes(zw, "report.md", []byte(report.Markdown)); err != nil {
		return closeWithError(err)
	}
	if project.Patch != nil && strings.TrimSpace(project.Patch.Diff) != "" {
		if err := addZipBytes(zw, "patch.diff", []byte(project.Patch.Diff)); err != nil {
			return closeWithError(err)
		}
	}
	seen := map[string]bool{}
	for _, run := range project.Runs {
		for _, path := range []string{run.StdoutPath, run.StderrPath} {
			if path == "" || seen[path] {
				continue
			}
			seen[path] = true
			rel, err := filepath.Rel(project.EvidenceDir, path)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				continue
			}
			if err := addZipFile(zw, filepath.ToSlash(filepath.Join("evidence", rel)), path); err != nil {
				return closeWithError(err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		_ = f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return dest, nil
}

func renderReportMarkdown(project *domain.Project, events []domain.Event, report domain.Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# ReproLens Report: %s\n\n", project.Name)
	fmt.Fprintf(&b, "- Project ID: `%s`\n", project.ID)
	fmt.Fprintf(&b, "- State: `%s`\n", project.State)
	fmt.Fprintf(&b, "- Paper: `%s`\n", project.PaperPath)
	fmt.Fprintf(&b, "- Repository: `%s`\n", project.RepoPath)
	if project.Paper.SHA256 != "" {
		fmt.Fprintf(&b, "- Paper SHA-256: `%s`\n", project.Paper.SHA256)
	}
	fmt.Fprintf(&b, "- Generated: %s\n\n", report.GeneratedAt.Format(time.RFC3339))

	b.WriteString("## Rule-based verdict\n\n")
	if project.Verification == nil {
		b.WriteString("No verification was recorded.\n\n")
	} else {
		v := project.Verification
		fmt.Fprintf(&b, "**%s** — %s\n\n", v.Verdict, report.Summary)
		fmt.Fprintf(&b, "- Expected: `%.8g`\n", v.Expected)
		fmt.Fprintf(&b, "- Observed: `%.8g`\n", v.Observed)
		fmt.Fprintf(&b, "- Tolerance: abs=`%g`, rel=`%g`\n", v.Tolerance.Abs, v.Tolerance.Rel)
		fmt.Fprintf(&b, "- Rule: `%s`\n", v.Rule)
		if v.Note != "" {
			fmt.Fprintf(&b, "- Note: %s\n", v.Note)
		}
		b.WriteString("\n")
	}

	if len(project.Claims) > 0 {
		b.WriteString("## Claims\n\n")
		for _, c := range project.Claims {
			fmt.Fprintf(&b, "- `%s` %s — expected `%g` (abs tolerance `%g`), source `%s:%d`\n",
				c.ID, c.Text, c.ExpectedValue, c.Tolerance.Abs, c.Source.Path, c.Source.Line)
		}
		b.WriteString("\n")
	}
	if len(project.Plans) > 0 {
		b.WriteString("## Experiment plan\n\n")
		for _, p := range project.Plans {
			fmt.Fprintf(&b, "- Claim `%s`: `%s` (image `%s`, seed `%d`)\n", p.ClaimID, p.Command, p.Image, p.Seed)
		}
		b.WriteString("\n")
	}
	if len(project.Runs) > 0 {
		b.WriteString("## Run history\n\n")
		b.WriteString("| Attempt | Runner | Provider | GPU | Status | Exit | Duration (ms) | Stdout | Stderr |\n")
		b.WriteString("|---:|---|---|:---:|---|---:|---:|---|---|\n")
		for _, run := range project.Runs {
			fmt.Fprintf(&b, "| %d | %s | %s | %v | %s | %d | %d | `%s` | `%s` |\n",
				run.Attempt, run.Runner, run.Provider, run.GPU, run.Status, run.ExitCode, run.DurationMS, run.StdoutPath, run.StderrPath)
		}
		b.WriteString("\n")
	}
	if project.Patch != nil {
		b.WriteString("## Human patch approval\n\n")
		fmt.Fprintf(&b, "- Status: `%s`\n", project.Patch.Status)
		if project.Patch.ApprovedBy != "" {
			fmt.Fprintf(&b, "- Approved by: `%s`\n", project.Patch.ApprovedBy)
		} else {
			b.WriteString("- Approved by: not recorded\n")
		}
		if project.Patch.AppliedAt != nil {
			fmt.Fprintf(&b, "- Applied at: %s\n", project.Patch.AppliedAt.Format(time.RFC3339))
		}
		fmt.Fprintf(&b, "- Diagnosis: %s — %s\n", project.Patch.Diagnosis.FailureClass, project.Patch.Diagnosis.RootCause)
		if project.Patch.CodeAgent != "" {
			fmt.Fprintf(&b, "- Code agent: `%s`", project.Patch.CodeAgent)
			if project.Patch.CodeAgentVersion != "" {
				fmt.Fprintf(&b, " (%s)", project.Patch.CodeAgentVersion)
			}
			b.WriteString("\n")
			if project.Patch.CodeAgentLogPath != "" {
				fmt.Fprintf(&b, "- Code agent log: `%s`\n", project.Patch.CodeAgentLogPath)
			}
			if project.Patch.CodeAgentSummary != "" {
				fmt.Fprintf(&b, "- Code agent summary: %s\n", project.Patch.CodeAgentSummary)
			}
		}
		b.WriteString("\n```diff\n")
		b.WriteString(strings.TrimSpace(project.Patch.Diff))
		b.WriteString("\n```\n\n")
	}
	if len(events) > 0 {
		b.WriteString("## Event log\n\n")
		for _, ev := range events {
			fmt.Fprintf(&b, "- #%d %s — %s\n", ev.Seq, ev.Type, ev.Message)
		}
		b.WriteString("\n")
	}
	if len(report.Evidence) > 0 {
		b.WriteString("## Evidence index\n\n")
		for _, ev := range report.Evidence {
			fmt.Fprintf(&b, "- %s: `%s`\n", ev.Kind, ev.Path)
		}
	}
	return b.String()
}

func reportEvidence(project *domain.Project) []domain.EvidenceRef {
	var out []domain.EvidenceRef
	seen := map[string]bool{}
	add := func(kind, path string) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		out = append(out, domain.EvidenceRef{Kind: kind, Path: path})
	}
	add("paper", project.PaperPath)
	for _, run := range project.Runs {
		add("stdout", run.StdoutPath)
		add("stderr", run.StderrPath)
	}
	if project.Patch != nil {
		add("patch", project.Patch.ID)
		add("code_agent_log", project.Patch.CodeAgentLogPath)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Kind < out[j].Kind })
	return out
}

func addZipJSON(zw *zip.Writer, name string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return addZipBytes(zw, name, b)
}

func addZipBytes(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

func addZipFile(zw *zip.Writer, name, source string) error {
	f, err := os.Open(source)
	if err != nil {
		return err
	}
	defer f.Close()
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, f)
	return err
}

func sanitizeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return "project"
	}
	return b.String()
}
