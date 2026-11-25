package tools

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func CreateWorkspaceArchive(workspace, dest string) error {
	root, err := filepath.Abs(workspace)
	if err != nil {
		return err
	}
	info, err := os.Stat(root)
	if err != nil {
		return fmt.Errorf("stat workspace: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("workspace is not a directory")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	cleanup := func() {
		_ = tw.Close()
		_ = gz.Close()
		_ = out.Close()
	}
	var total int64
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		if d.IsDir() && shouldSkipRepoDir(d.Name()) {
			return filepath.SkipDir
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		if fi.IsDir() {
			hdr, err := tar.FileInfoHeader(fi, "")
			if err != nil {
				return err
			}
			hdr.Name = filepath.ToSlash(rel) + "/"
			return tw.WriteHeader(hdr)
		}
		if !fi.Mode().IsRegular() {
			return nil
		}
		total += fi.Size()
		if total > 1<<30 {
			return fmt.Errorf("workspace exceeds 1 GiB archive limit")
		}
		hdr, err := tar.FileInfoHeader(fi, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(tw, in)
		closeErr := in.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	if err != nil {
		cleanup()
		_ = os.Remove(dest)
		return err
	}
	if err := tw.Close(); err != nil {
		cleanup()
		return err
	}
	if err := gz.Close(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
