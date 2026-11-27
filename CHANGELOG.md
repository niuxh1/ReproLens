# Changelog

## 0.3.0 - 2026-11-27

### Added
- Durable operations with SQLite leases, owner-checked heartbeats, expiry recovery, idempotency request hashes, and conflict semantics.
- Project revision CAS, `ETag` / `If-Match`, and atomic state-transition/event commits.
- Claim provenance validation against PDF page text, with page numbers, quotes, table/figure labels, and mismatch blocking.
- Compound verification criteria (`eq/neq/gt/gte/lt/lte/between`, `all/any`) and run/plan/claim binding checks.
- Full-event report generation, event pagination metadata, and strict query parsing.
- Execution transcript search, stdout/stderr filters, copy/download, CodeAgent streaming, and auto-sized report iframe.
- ZIP package checksums, page/evidence hashes, package schema v3, and corrected workspace snapshot manifest size.
- Deterministic evidence-maturity assessment with hard caps for single runs and host-local execution.
- Main-agent Chinese report summary with model/source/timestamp metadata.
- Printable, responsive HTML report with CSP nonce and allowlist HTML sanitization.
- SSE replay via `Last-Event-ID`, multi-client subscriptions, heartbeats, terminal `done` events, and backpressure handling.
- Docker/SSH streaming output and nested `work_dir` support.
- Production build/start scripts, coverage gate, dependency audit, and cross-platform GitHub Actions CI.
- Security, contribution, and changelog documentation.

### Changed

- HTTP state conflicts now return `409` without mutating the project.
- Validation failures return structured `422` responses.
- Report evidence index excludes original-paper and page-image entries.
- Runtime execution surface is limited to `local`, `docker`, and `ssh`.

### Security

- Upgraded `@fastify/static`, `adm-zip`, `pdfjs-dist`, and `vitest`.
- Replaced regex-only report sanitization with `sanitize-html` allowlists.
- Added SSH host validation and remote work-directory containment checks.

## 0.2.0

- TypeScript migration, Observatory web console, deterministic workflow, PDF visual evidence, evidence ZIP, CodeAgent delegation, and local/Docker/SSH runners.