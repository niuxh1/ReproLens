package tools

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"reprolens/internal/domain"
)

const maxPaperBytes = 80 << 20

func ParsePaper(path string) (domain.Paper, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return domain.Paper{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return domain.Paper{}, fmt.Errorf("stat paper: %w", err)
	}
	if info.Size() > maxPaperBytes {
		return domain.Paper{}, fmt.Errorf("paper exceeds size limit")
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return domain.Paper{}, err
	}
	ext := strings.ToLower(filepath.Ext(abs))
	var text string
	switch ext {
	case ".md", ".markdown", ".txt", ".rst":
		text = string(raw)
	case ".docx":
		text, err = extractDocx(raw)
	case ".pdf":
		text, err = extractPDF(abs)
	default:
		return domain.Paper{}, fmt.Errorf("unsupported paper format %q", ext)
	}
	if err != nil {
		return domain.Paper{}, err
	}
	text = strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	if text == "" {
		return domain.Paper{}, fmt.Errorf("paper contains no extractable text")
	}
	sum := sha256.Sum256(raw)
	return domain.Paper{
		Title:      paperTitle(text),
		Text:       text,
		SourcePath: abs,
		SHA256:     hex.EncodeToString(sum[:]),
		ParsedAt:   time.Now().UTC(),
	}, nil
}

type docxDocument struct {
	Body struct {
		Paragraphs []struct {
			Runs []struct {
				Text string `xml:"t"`
			} `xml:"r"`
		} `xml:"p"`
	} `xml:"body"`
}

func extractDocx(raw []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return "", fmt.Errorf("open docx: %w", err)
	}
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		data, readErr := io.ReadAll(io.LimitReader(rc, maxPaperBytes))
		_ = rc.Close()
		if readErr != nil {
			return "", readErr
		}
		var doc docxDocument
		if err := xml.Unmarshal(data, &doc); err != nil {
			return "", fmt.Errorf("decode docx XML: %w", err)
		}
		lines := make([]string, 0, len(doc.Body.Paragraphs))
		for _, p := range doc.Body.Paragraphs {
			var b strings.Builder
			for _, r := range p.Runs {
				b.WriteString(r.Text)
			}
			lines = append(lines, b.String())
		}
		return strings.Join(lines, "\n"), nil
	}
	return "", fmt.Errorf("docx has no word/document.xml")
}

func extractPDF(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pdftotext", "-layout", path, "-")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("PDF extraction timed out")
		}
		return "", fmt.Errorf("PDF extraction requires pdftotext: %v %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func paperTitle(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		line = strings.TrimLeft(line, "# ")
		if len(line) > 180 {
			line = line[:180]
		}
		return line
	}
	return "Untitled paper"
}
