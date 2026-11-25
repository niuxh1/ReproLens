"""Minimal reproduction harness for the official Grokfast repository.

The harness runs the repository's existing main.py with the configuration
reported in the README, then reads the saved result file and reports the first
optimization iteration at which validation accuracy reaches 95%.

It does not reimplement or modify the training algorithm.
"""
import glob
import os
import subprocess
import sys

import torch

os.environ.setdefault("MPLBACKEND", "Agg")

label = "reprolens"
cmd = [
    sys.executable,
    "main.py",
    "--label", label,
    "--seed", "0",
    "--p", "97",
    "--budget", "1000",
    "--batch_size", "512",
    "--lr", "1e-3",
    "--beta1", "0.9",
    "--beta2", "0.98",
    "--weight_decay", "0.005",
    "--filter", "ema",
    "--alpha", "0.98",
    "--lamb", "2.0",
]
print("device=" + ("cuda" if torch.cuda.is_available() else "cpu"), flush=True)
if torch.cuda.is_available():
    print("gpu=" + torch.cuda.get_device_name(0), flush=True)
subprocess.run(cmd, check=True)
files = sorted(glob.glob(f"results/res_{label}*.pt"), key=os.path.getmtime)
if not files:
    raise SystemExit("Grokfast result file was not produced")
result = torch.load(files[-1], map_location="cpu", weights_only=False)
iterations = list(result["its"])
values = [float(v) for v in result["val_acc"]]
reached = next((i for i, value in enumerate(values) if value >= 0.95), None)
if reached is None:
    print("iterations=999999")
    print(f"max_val_acc={max(values):.6f}")
else:
    print(f"iterations={int(iterations[reached])}")
    print(f"max_val_acc={max(values):.6f}")