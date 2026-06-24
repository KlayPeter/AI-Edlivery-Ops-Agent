#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PROJECT_ROOT"

CONFIG="${DELIVERY_OPS_CONFIG:-config/config.example.json}"
TASK="${1:-}"

if [[ -z "$TASK" ]]; then
  echo "Usage: scripts/run.sh {standup-push|standup-second-remind|standup-mark-missing|standup-summary|daily-summary|dashboard|overdue-scan}"
  exit 1
fi

python3 -m delivery_ops_bridge.cli --config "$CONFIG" job "$TASK"
