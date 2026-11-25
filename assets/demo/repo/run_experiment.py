import argparse
import sys

# Intentional bug for the ReproLens demo: the paper requires seed 42.
SEED = 0

parser = argparse.ArgumentParser()
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--data", default="data.csv")
args = parser.parse_args()

if args.seed != SEED:
    print(f"seed mismatch: expected {args.seed}, got {SEED}", file=sys.stderr)
    sys.exit(1)

print("accuracy=0.81")