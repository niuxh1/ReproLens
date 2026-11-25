package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"reprolens/internal/domain"
)

var repoCommandRE = regexp.MustCompile(`(?i)^\s*(?:\$ )?(python(?:3)?|pytest|rscript|bash|sh|go\s+test|node|uv\s+run|poetry\s+run|pip(?:3)?)\b.+$`)

func ScanRepo(root string) (domain.RepoSummary, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return domain.RepoSummary{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return domain.RepoSummary{}, fmt.Errorf("stat repository: %w", err)
	}
	if !info.IsDir() {
		return domain.RepoSummary{}, fmt.Errorf("repository is not a directory")
	}
	summary := domain.RepoSummary{Root: abs, ScannedAt: time.Now().UTC()}
	seenCommands := map[string]bool{}
	count := 0
	err = filepath.WalkDir(abs, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == abs {
			return nil
		}
		rel, err := filepath.Rel(abs, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if shouldSkipRepoDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		count++
		if count <= 2000 {
			summary.Files = append(summary.Files, rel)
		}
		lower := strings.ToLower(rel)
		switch {
		case filepath.Base(lower) == "readme.md" || filepath.Base(lower) == "readme.rst" || filepath.Base(lower) == "readme.txt":
			if info, err := d.Info(); err == nil && info.Size() <= 2<<20 {
				if b, err := os.ReadFile(path); err == nil {
					summary.Readme = string(b)
				}
			}
		case filepath.Base(lower) == "requirements.txt" || strings.HasPrefix(lower, "requirements/") && strings.HasSuffix(lower, ".txt"):
			if info, err := d.Info(); err == nil && info.Size() <= 2<<20 {
				if b, err := os.ReadFile(path); err == nil {
					for _, line := range strings.Split(string(b), "\n") {
						line = strings.TrimSpace(line)
						if line != "" && !strings.HasPrefix(line, "#") && !strings.HasPrefix(line, "-") {
							summary.Requirements = append(summary.Requirements, line)
						}
					}
				}
			}
		case strings.HasPrefix(filepath.Base(lower), "license") || strings.HasPrefix(filepath.Base(lower), "copying"):
			if info, err := d.Info(); err == nil && info.Size() <= 2<<20 {
				if b, err := os.ReadFile(path); err == nil {
					summary.License = truncateText(string(b), 2000)
				}
			}
		}
		return nil
	})
	if err != nil {
		return domain.RepoSummary{}, err
	}
	for _, raw := range strings.Split(summary.Readme, "\n") {
		line := strings.TrimSpace(strings.Trim(raw, "`"))
		line = strings.TrimPrefix(line, "$ ")
		if repoCommandRE.MatchString(line) && !seenCommands[line] {
			seenCommands[line] = true
			summary.CommandCandidates = append(summary.CommandCandidates, line)
			if len(summary.CommandCandidates) >= 20 {
				break
			}
		}
	}
	return summary, nil
}

func truncateText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
