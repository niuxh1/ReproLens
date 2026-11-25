# Observatory UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the functional but basic ReproLens dashboard with a professional, responsive Observatory research workspace while preserving every existing operation.

**Architecture:** Keep the Fastify backend and vanilla ESM frontend. Separate design tokens/icons, static application shell, view rendering, and API-backed workflows. Add only a narrow project evidence endpoint for real PDF page preview.

**Tech Stack:** TypeScript, Fastify, semantic HTML, CSS custom properties, vanilla JavaScript, Lucide icons, Vitest, Playwright browser verification.

**Spec:** `docs/superpowers/specs/2026-11-25-observatory-ui-design.md`

## Global Constraints

- Existing project routes, JSON fields and state transitions remain compatible.
- No decorative stock imagery or fake metrics; every metric is derived from the Store.
- Body text >=14px, mobile targets >=44px, no horizontal overflow at 320px.
- API keys are masked and never logged.
- `prefers-reduced-motion` is supported.

---

### Task 1: Evidence preview contract

**Files:** `src/httpapi/server.ts`, `tests/httpapi.test.ts`.

- [ ] Write a failing test creating a demo, starting it, then asserting `GET /api/v1/projects/:id/evidence/:name` rejects `../secret`.
- [ ] Run `npm test -- tests/httpapi.test.ts` and verify route-not-found failure.
- [ ] Implement a route restricted to the project's `evidence_dir`, regular files only, `page-*.png` image response and log file response.
- [ ] Re-run the test and verify pass.

### Task 2: Design foundation and shell

**Files:** `public/index.html`, `public/tokens.css`, `public/icons.js`, `public/app.js`.

- [ ] Add explicit tokens for surfaces, ink, borders, type, space, radius and elevations.
- [ ] Replace text-symbol icons with one `icon(name)` helper backed by Lucide paths.
- [ ] Build the responsive semantic shell with skip link, collapsible navigation, breadcrumbs and global search.
- [ ] Implement icon-only accessible controls and keyboard focus styles.

### Task 3: Workspace, project list and project workspace

**Files:** `public/index.html`, `public/app.js`, `public/style.css`.

- [ ] Render real summary metrics and project rows.
- [ ] Implement the six-stage user-facing progress mapping.
- [ ] Implement workflow, PDF pages, run logs, and evidence tabs.
- [ ] Preserve create/start/select/confirm/approve/reject/stop/download operations.
- [ ] Add accessible page preview and run log drawers/dialogs.

### Task 4: Creation and settings workflows

**Files:** `public/index.html`, `public/app.js`, `public/style.css`.

- [ ] Convert creation to three labelled sections with a live readiness summary.
- [ ] Keep all uploads, runner fields, budget fields and CodeAgent options.
- [ ] Convert settings to grouped model, execution, CodeAgent, remote and platform forms.
- [ ] Preserve key masking, save and connectivity test behavior.

### Task 5: Responsive and visual QA

**Files:** `docs/observatory-*.png`, `README.md`.

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`.
- [ ] Launch the compiled app and verify complete browser workflow.
- [ ] Capture 1440, 1024, 390 and 320 widths and assert no horizontal overflow.
- [ ] Verify reduced motion, keyboard focus, dialogs, page previews and downloads.
- [ ] Update the README screenshots and interaction description.

## Self-review

Every visible existing capability maps to a concrete task. Added backend behavior is tested. No new dependencies are required for the production UI.
