package tools

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var workspaceIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Workspace struct {
	ProjectRoot string
	Root        string
	EvidenceDir string
	ArtifactDir string
}

func NewWorkspace(dataDir, projectID string) (*Workspace, error) {
	if !workspaceIDRE.MatchString(projectID) {
		return nil, fmt.Errorf("invalid project id %q", projectID)
	}
	base, err := filepath.Abs(filepath.Join(dataDir, "projects", projectID))
	if err != nil {
		return nil, err
	}
	w := &Workspace{
		ProjectRoot: base,
		Root:        filepath.Join(base, "workspace"),
		EvidenceDir: filepath.Join(base, "evidence"),
		ArtifactDir: filepath.Join(base, "artifacts"),
	}
	for _, dir := range []string{w.Root, w.EvidenceDir, w.ArtifactDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create workspace directory: %w", err)
		}
	}
	return w, nil
}

func (w *Workspace) ResolvePath(relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", fmt.Errorf("absolute path not allowed: %s", relative)
	}
	clean := filepath.Clean(relative)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace: %s", relative)
	}
	full, err := filepath.Abs(filepath.Join(w.Root, clean))
	if err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(w.Root)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootAbs, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace: %s", relative)
	}
	return full, nil
}

func (w *Workspace) EvidencePath(name string) (string, error) {
	if filepath.IsAbs(name) {
		return "", fmt.Errorf("absolute evidence path not allowed")
	}
	clean := filepath.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("evidence path escapes directory")
	}
	full := filepath.Join(w.EvidenceDir, clean)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", err
	}
	return full, nil
}

func (w *Workspace) CopyRepo(source string) error {
	sourceAbs, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(sourceAbs)
	if err != nil {
		return fmt.Errorf("stat repository: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("repository is not a directory: %s", sourceAbs)
	}
	const maxFiles = 20000
	const maxBytes = int64(2 << 30)
	var count int
	var total int64
	return filepath.WalkDir(sourceAbs, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == sourceAbs {
			return nil
		}
		rel, err := filepath.Rel(sourceAbs, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			if shouldSkipRepoDir(d.Name()) {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(w.Root, rel), 0o755)
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink not allowed in repository: %s", rel)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		count++
		if count > maxFiles {
			return fmt.Errorf("repository exceeds %d files", maxFiles)
		}
		total += info.Size()
		if total > maxBytes {
			return fmt.Errorf("repository exceeds size limit")
		}
		return copyFile(path, filepath.Join(w.Root, rel), info.Mode().Perm())
	})
}

func copyFile(source, dest string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func shouldSkipRepoDir(name string) bool {
	switch strings.ToLower(name) {
	case ".git", ".hg", ".svn", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode", "dist", "build":
		return true
	default:
		return false
	}
}
