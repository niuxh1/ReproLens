package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type PatchManager struct {
	Workspace string
}

type backupManifest struct {
	Files []backupFile `json:"files"`
}

type backupFile struct {
	Path string `json:"path"`
	Mode uint32 `json:"mode"`
}

func (m *PatchManager) Validate(diff string) ([]string, error) {
	if strings.TrimSpace(diff) == "" {
		return nil, fmt.Errorf("patch diff is empty")
	}
	if len(diff) > 2<<20 {
		return nil, fmt.Errorf("patch diff is too large")
	}
	lower := strings.ToLower(diff)
	for _, forbidden := range []string{"new file mode", "deleted file mode", "rename from", "rename to", "git binary patch", "binary files"} {
		if strings.Contains(lower, forbidden) {
			return nil, fmt.Errorf("unsupported patch operation: %s", forbidden)
		}
	}
	lines := strings.Split(diff, "\n")
	var paths []string
	seen := map[string]bool{}
	for i := 0; i < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "--- ") {
			continue
		}
		if i+1 >= len(lines) || !strings.HasPrefix(lines[i+1], "+++ ") {
			return nil, fmt.Errorf("malformed patch headers")
		}
		oldPath, err := patchHeaderPath(strings.TrimPrefix(lines[i], "--- "))
		if err != nil {
			return nil, err
		}
		newPath, err := patchHeaderPath(strings.TrimPrefix(lines[i+1], "+++ "))
		if err != nil {
			return nil, err
		}
		if oldPath != newPath {
			return nil, fmt.Errorf("renames are not supported")
		}
		if !seen[newPath] {
			seen[newPath] = true
			paths = append(paths, newPath)
		}
		i++
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("patch contains no file headers")
	}
	if !strings.Contains(diff, "@@ ") {
		return nil, fmt.Errorf("patch contains no hunks")
	}
	for _, rel := range paths {
		full, err := m.resolve(rel)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(full)
		if err != nil {
			return nil, fmt.Errorf("patch target %s: %w", rel, err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("patch target must be a regular file: %s", rel)
		}
	}
	return paths, nil
}

func (m *PatchManager) Apply(diff string) ([]string, error) {
	files, err := m.Validate(diff)
	if err != nil {
		return nil, err
	}
	backupDir, err := m.Backup(files)
	if err != nil {
		return nil, err
	}
	patchDir := filepath.Join(m.Workspace, ".reprolens")
	if err := os.MkdirAll(patchDir, 0o755); err != nil {
		return nil, err
	}
	patchPath := filepath.Join(patchDir, fmt.Sprintf("patch-%d.diff", time.Now().UnixNano()))
	if err := os.WriteFile(patchPath, []byte(diff), 0o644); err != nil {
		return nil, err
	}
	check := exec.Command("git", "-C", m.Workspace, "apply", "--check", "--whitespace=nowarn", patchPath)
	if out, err := check.CombinedOutput(); err != nil {
		_ = m.Restore(backupDir)
		return nil, fmt.Errorf("patch check failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	apply := exec.Command("git", "-C", m.Workspace, "apply", "--whitespace=nowarn", patchPath)
	if out, err := apply.CombinedOutput(); err != nil {
		_ = m.Restore(backupDir)
		return nil, fmt.Errorf("patch apply failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return files, nil
}

func (m *PatchManager) Backup(files []string) (string, error) {
	dir := filepath.Join(m.Workspace, ".reprolens", "backups", time.Now().UTC().Format("20060102T150405.000000000"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	manifest := backupManifest{}
	for _, rel := range files {
		full, err := m.resolve(rel)
		if err != nil {
			return "", err
		}
		info, err := os.Stat(full)
		if err != nil {
			return "", err
		}
		dest := filepath.Join(dir, "files", filepath.FromSlash(rel))
		if err := copyFile(full, dest, info.Mode().Perm()); err != nil {
			return "", err
		}
		manifest.Files = append(manifest.Files, backupFile{Path: rel, Mode: uint32(info.Mode().Perm())})
	}
	b, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o644); err != nil {
		return "", err
	}
	return dir, nil
}

func (m *PatchManager) Restore(backupDir string) error {
	b, err := os.ReadFile(filepath.Join(backupDir, "manifest.json"))
	if err != nil {
		return err
	}
	var manifest backupManifest
	if err := json.Unmarshal(b, &manifest); err != nil {
		return err
	}
	for _, f := range manifest.Files {
		source := filepath.Join(backupDir, "files", filepath.FromSlash(f.Path))
		dest, err := m.resolve(f.Path)
		if err != nil {
			return err
		}
		if err := copyFile(source, dest, os.FileMode(f.Mode)); err != nil {
			return err
		}
	}
	return nil
}

func (m *PatchManager) resolve(rel string) (string, error) {
	if strings.Contains(rel, "\\") || strings.ContainsRune(rel, '\x00') {
		return "", fmt.Errorf("invalid patch path %q", rel)
	}
	clean := path.Clean(rel)
	if clean == "." || strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("patch path escapes workspace: %q", rel)
	}
	if len(clean) >= 2 && clean[1] == ':' {
		return "", fmt.Errorf("drive-qualified path not allowed: %q", rel)
	}
	full := filepath.Join(m.Workspace, filepath.FromSlash(clean))
	root, err := filepath.Abs(m.Workspace)
	if err != nil {
		return "", err
	}
	full, err = filepath.Abs(full)
	if err != nil {
		return "", err
	}
	within, err := filepath.Rel(root, full)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("patch path escapes workspace: %q", rel)
	}
	if strings.HasPrefix(clean, ".reprolens/") || clean == ".reprolens" {
		return "", fmt.Errorf("patch cannot modify internal workspace metadata")
	}
	return full, nil
}

func patchHeaderPath(header string) (string, error) {
	header = strings.TrimSpace(header)
	if header == "/dev/null" {
		return "", fmt.Errorf("file creation/deletion is not supported")
	}
	if i := strings.IndexByte(header, '\t'); i >= 0 {
		header = header[:i]
	}
	if strings.HasPrefix(header, "a/") || strings.HasPrefix(header, "b/") {
		header = header[2:]
	}
	if header == "" || strings.Contains(header, "\\") {
		return "", fmt.Errorf("invalid patch path %q", header)
	}
	return header, nil
}
