# Real-Paper Test: Grokfast (2024)

## Case selection

- Paper: Lee et al. (2024), *Grokfast: Accelerated Grokking by Amplifying Slow Gradients*.
- arXiv: `2405.20233`.
- Official code: `https://github.com/ironjr/grokfast`, MIT License.
- Why this case: recent paper, official code, small synthetic task, one concrete numeric table cell, no private data, and a GPU-relevant Transformer training loop.
- Claim tested: Grokfast with the EMA configuration reaches 95% validation accuracy in about 910 optimization iterations on the modular multiplication Transformer task. Tolerance: ±300 iterations.

This is a single-claim reproduction, not a claim that the whole paper has been independently validated.

## Environment

- Windows host with WSL2 available.
- NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB.
- PyTorch `2.11.0+cu128`.
- CUDA runtime reported by PyTorch: `12.8`.
- `torch.cuda.is_available() == True`.
- A 4096×4096 CUDA matrix multiplication completed successfully.

## Reproduction harness

The harness is `examples/grokfast/reproduce_grokfast.py`. It:

1. prints the detected CUDA device;
2. invokes the official `main.py` with the README's Grokfast EMA configuration;
3. loads the official result file;
4. reports the first optimization iteration where validation accuracy reaches 95%.

It does not reimplement the algorithm or alter the metric.

Configuration used:

```text
--seed 0 --p 97 --budget 1000 --batch_size 512
--weight_decay 0.005 --filter ema --alpha 0.98 --lamb 2.0
```

## Result

```text
State: COMPLETED
GPU: true
Device: NVIDIA GeForce RTX 4060 Laptop GPU
Runtime: 43 seconds
Observed iterations to 95% validation accuracy: 900
Paper value: 910
Tolerance: ±300
Rule: abs_error 10 <= 300
Verdict: PASS
```

The official run also reported `max_val_acc=0.996993`.

## Evidence

- Report: `examples/grokfast/report.md`
- ZIP package: `examples/grokfast/evidence/grokfast-reproduction-package.zip`
- The ZIP contains `manifest.json`, `project.json`, `events.json`, `report.md`, and run stdout/stderr logs.

## Other validated execution paths

- **WSL SSH host**: real scp + ssh deployment to a non-root dropbear server; output included `SSH_DEPLOY_OK` and the WSL-visible RTX 4060.
- **CodeAgent**: a real Codex CLI invocation in a disposable workspace changed `accuracy=0.50` to `accuracy=0.81`, ran the acceptance command, and returned a git-compatible diff. The diff was not applied directly; it remained a proposal.

## Reproduce

```powershell
git clone --depth 1 https://github.com/ironjr/grokfast.git .work/grokfast
Copy-Item examples\grokfast\reproduce_grokfast.py .work\grokfast\reproduce_grokfast.py
```

Then use ReproLens with:

- paper: `examples/grokfast/paper.md`
- repo: `.work/grokfast`
- local runner with GPU enabled
- budget: one run, 900 seconds

The exact one-off runner is intentionally kept under `.work/` and is not part of the product API; the product path is the `Runner`, `Analyzer`, `CodeAgent`, and `Orchestrator` interfaces described in `docs/extension-points.md`.
## TypeScript / Web 验证补充

The current agent implementation is TypeScript. The same Grokfast evidence was produced by the Python reproduction harness and recorded through the ReproLens Runner / Orchestrator contract. The Web console can upload the original PDF, render every page to PNG, show the page count in the source index, and include the original PDF plus rendered pages in the downloadable evidence ZIP.

Browser smoke flow verified:

```text
new run -> ingest -> select claim -> plan -> seed-mismatch patch -> human approval -> retry -> PASS
```

Screenshots: `docs/ui-overview.png`, `docs/ui-new-run.png`, `docs/ui-settings.png`, `docs/ui-project-pass.png`.
