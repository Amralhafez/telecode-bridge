#!/usr/bin/env bash
# Linux/macOS launcher — runs from this script's own folder, uses node from PATH.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
exec node src/index.js >> logs/bridge-task.log 2>&1
