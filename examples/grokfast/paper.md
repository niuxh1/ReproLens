# Real Case: Grokfast (2024)

Paper: Lee et al. (2024), "Grokfast: Accelerated Grokking by Amplifying Slow Gradients".
arXiv: https://arxiv.org/abs/2405.20233
Official code: https://github.com/ironjr/grokfast (MIT License).

The official repository reports that Grokfast with the EMA filter reaches 95% validation accuracy
on the algorithmic modular-multiplication Transformer task in about 910 optimization iterations
(README table, Grokfast configuration: alpha=0.98, lambda=2.0, weight_decay=0.005).

Claim C1: Grokfast reaches 95% validation accuracy on the modular multiplication task in 910 optimization iterations (tolerance ±300).

Run: python reproduce_grokfast.py