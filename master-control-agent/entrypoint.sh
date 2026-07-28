#!/bin/bash
# Master Control entrypoint. Modes: daemon (default) | tick | session-begin.
set -e
MODE="${1:-daemon}"
echo "=== Master Control (${MODE}) ==="
# Defaults here MUST track the ones in the code they describe (ntfy.ts,
# phrase.ts). They drifted once already and the banner spent months reporting a
# model the agent was not using.
# Presence only, never the value: a banner is the wrong place for a secret.
if [ -n "${MC_LLM_KEY:-}" ]; then LLM_KEY_STATE="set"; else LLM_KEY_STATE="MISSING (lines will be templates)"; fi
echo "ntfy:   ${NTFY_URL:-http://127.0.0.1:8880} topics=${NTFY_TOPICS:-universal-exports}"
echo "llm:    ${MC_LLM_URL:-http://ai.matthewstevens.org:8881} (${MC_LLM_MODEL:-qwen3.5-9b-mtplx}) key=${LLM_KEY_STATE}"
echo "bridge: ${CODETALKER_BRIDGE_URL:-http://10.0.0.12:7900}"
exec node dist/index.js "$MODE"
