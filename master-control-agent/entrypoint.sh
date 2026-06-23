#!/bin/bash
# Master Control entrypoint. Modes: daemon (default) | tick | session-begin.
set -e
MODE="${1:-daemon}"
echo "=== Master Control (${MODE}) ==="
echo "ntfy:   ${NTFY_URL:-http://127.0.0.1:8880} topics=${NTFY_TOPICS:-universal-exports,ghostmode-alerts}"
echo "llm:    ${OLLAMA_URL:-http://ai.matthewstevens.org:8881} (${OLLAMA_MODEL:-mlx-community/Qwen3-14B-4bit-AWQ})"
echo "bridge: ${CODETALKER_BRIDGE_URL:-http://10.0.0.12:7900}"
exec node dist/index.js "$MODE"
