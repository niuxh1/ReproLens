# Grokfast Real-Case Test

- Paper: Lee et al. (2024), *Grokfast: Accelerated Grokking by Amplifying Slow Gradients*.
- arXiv: `2405.20233`.
- Official code: `ironjr/grokfast` (MIT).
- Claim: the EMA Grokfast configuration reaches 95% validation accuracy in about 910 optimization iterations on the modular multiplication Transformer task.

Setup:

```powershell
git clone --depth 1 https://github.com/ironjr/grokfast.git .work/grokfast
Copy-Item examples\grokfast\reproduce_grokfast.py .work\grokfast\reproduce_grokfast.py
```

The harness calls the repository's existing `main.py` and reads its saved result file. It does not
alter the training logic or evaluation metric. The run is configured with a 1000-iteration budget
so it can stop after the paper's reported 95% milestone.