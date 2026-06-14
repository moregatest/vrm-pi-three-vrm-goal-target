#!/bin/sh
# Recreate the handless-termal run for THIS project's current location, so
# `node proof-c.mjs` can drive `ht run-round` against it. Safe to re-run.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
HT=/Users/tung/Codes/handless-termal/bin/ht
RUN="$HERE/proofs/handless-run"
python3 "$HT" new --base "$HERE/proofs" \
  --goal "Aria VRM character greets the user happily and waves, using the VRM tools" \
  --target-repo "$HERE/pi" --skills-dir . --skill AGENTS.md \
  --corpus-ref "$HERE/proofs/corpus/sessions" \
  --model "deepseek/deepseek-v4-flash" \
  --score-target 9 --k 3 --max-rounds 8 --run-id handless-run
python3 "$HT" corpus --run "$RUN" --current-version 1.0.0
echo "handless run ready at: $RUN"
