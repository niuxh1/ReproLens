# ReproLens Report: Grokfast 2024 real-case test

- Project ID: `proj_538a2614c15ec50f`
- State: `REPORTING`
- Paper: `C:\Users\ASUS\Desktop\vscode\aa\reprolens\examples\grokfast\paper.md`
- Repository: `C:\Users\ASUS\Desktop\vscode\aa\reprolens\.work\grokfast`
- Paper SHA-256: `29e5a42a0ea9b1d31fa6cd78010a206d4c8b853b5a875070c081de98e618126f`
- Generated: 2026-11-25T11:19:24Z

## Rule-based verdict

**PASS** — PASS: observed 900 vs expected 910 for iterations

- Expected: `910`
- Observed: `900`
- Tolerance: abs=`300`, rel=`0`
- Rule: `abs_error 10 <= 300`

## Claims

- `C1` Grokfast reaches 95% validation accuracy on the modular multiplication task in 910 optimization iterations (tolerance ±300). — expected `910` (abs tolerance `300`), source `C:\Users\ASUS\Desktop\vscode\aa\reprolens\examples\grokfast\paper.md:11`

## Experiment plan

- Claim `C1`: `python reproduce_grokfast.py` (image `python:3.11-slim`, seed `42`)

## Run history

| Attempt | Runner | Status | Exit | Duration (ms) | Stdout | Stderr |
|---:|---|---|---:|---:|---|---|
| 1 | local (unsafe) | succeeded | 0 | 43000 | `C:\Users\ASUS\Desktop\vscode\aa\reprolens\.work\grokfast-repro\data\projects\proj_538a2614c15ec50f\evidence\runs\run_e8f482fe72cc2e86\stdout.log` | `C:\Users\ASUS\Desktop\vscode\aa\reprolens\.work\grokfast-repro\data\projects\proj_538a2614c15ec50f\evidence\runs\run_e8f482fe72cc2e86\stderr.log` |

## Event log

- #1 project_created — project created
- #2 state_changed — initializing isolated workspace
- #3 repository_copied — repository copied into isolated workspace
- #4 state_changed — paper and repository ingested
- #5 state_changed — candidate claims extracted
- #6 claims_extracted — 1 measurable claims found
- #7 state_changed — claims selected; building experiment plans
- #8 plans_ready — 1 experiment plan(s) generated
- #9 state_changed — experiment plan confirmed by user
- #10 sandbox_ready — execution workspace prepared
- #11 state_changed — starting controlled execution
- #12 run_completed — run 1 finished with status succeeded
- #13 state_changed — experiment succeeded; verifying metric
- #14 verification_completed — claim C1 verdict: PASS
- #15 state_changed — all selected claims verified; generating report

## Evidence index

- paper: `C:\Users\ASUS\Desktop\vscode\aa\reprolens\examples\grokfast\paper.md`
- stderr: `C:\Users\ASUS\Desktop\vscode\aa\reprolens\.work\grokfast-repro\data\projects\proj_538a2614c15ec50f\evidence\runs\run_e8f482fe72cc2e86\stderr.log`
- stdout: `C:\Users\ASUS\Desktop\vscode\aa\reprolens\.work\grokfast-repro\data\projects\proj_538a2614c15ec50f\evidence\runs\run_e8f482fe72cc2e86\stdout.log`
