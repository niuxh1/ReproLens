package demo

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

//go:embed assets
var assets embed.FS

var projectIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func Materialize(dataDir, projectID string) (string, string, error) {
	if !projectIDRE.MatchString(projectID) {
		return "", "", fmt.Errorf("invalid project id %q", projectID)
	}
	base, err := filepath.Abs(filepath.Join(dataDir, "demo-materialized", projectID))
	if err != nil {
		return "", "", err
	}
	paperPath := filepath.Join(base, "paper.md")
	repoPath := filepath.Join(base, "repo")
	files := map[string]string{
		"assets/paper.md":               paperPath,
		"assets/repo/README.md":         filepath.Join(repoPath, "README.md"),
		"assets/repo/run_experiment.py": filepath.Join(repoPath, "run_experiment.py"),
		"assets/repo/data.csv":          filepath.Join(repoPath, "data.csv"),
	}
	for embedded, dest := range files {
		data, err := assets.ReadFile(embedded)
		if err != nil {
			return "", "", err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return "", "", err
		}
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return "", "", err
		}
	}
	return paperPath, repoPath, nil
}
