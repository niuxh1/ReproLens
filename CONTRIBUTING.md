# Contributing

## Development setup

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

The supported runtime is Node.js 22.13+; Node.js 24 LTS is recommended.

## Quality gates

Before opening a pull request:

```powershell
npm run typecheck
npm test
npm run test:coverage
npm run build
node --check public\app.js
git diff --check
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

## Architecture rules

- Final `PASS / DIFFERENT / INSUFFICIENT_EVIDENCE / FAILED` is computed only by `src/tools/verify.ts`.
- Analyzer and CodeAgent outputs are proposals; they cannot overwrite the rule verdict.
- CodeAgent patches require safety validation and explicit human approval.
- Do not add a new Runner without updating the Runner contract, capability checks, evidence manifest, and tests.
- Keep the platform surface limited to `local`, `docker`, and `ssh`.
- Never commit `.env`, `data/`, `.work/`, secrets, or user evidence.

## Pull request checklist

- [ ] New behavior has tests.
- [ ] Error paths and cancellation are covered.
- [ ] User-facing text is Chinese where appropriate.
- [ ] No secret, absolute host path, or private evidence appears in a report or fixture.
- [ ] README/API docs are updated for contract changes.
- [ ] `npm run check` passes.