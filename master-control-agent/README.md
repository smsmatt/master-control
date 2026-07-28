# Master Control agent

A **deterministic ops-narrator** for the SanMarcSoft / PAI voice channel, built on
this Pi-harness repo (TypeScript) and modeled on the moneypenny deploy pattern.

Master Control polls the ntfy ops feeds, **decides what to voice in pure code**,
validates suspected threats against GreyNoise, and speaks selectively through the
Code:Talker bridge as the `master-control` voice. It also greets on session begin.

## Why it's shaped this way (the red-team mandate)

A `/RedTeam` rejected running a heavyweight self-improving agent framework for this
job: untrusted ntfy text reaching a tool-armed quantized model is an injection-to-RCE
path, and delegating the speak/swallow judgement to a 14B fails silently. So here:

- The **speak/swallow decision is a pure function** (`src/gate.ts`), unit-tested.
  Untrusted alert text is never a command and never reaches a shell — there is no
  shell tool.
- The **LLM (local MLX Qwen3-14B) only phrases** a line the gate already approved
  (`src/phrase.ts`), with a deterministic static fallback if the model is down.
- **GreyNoise validates** before a security alert is voiced; private IPs are never
  sent off-box (`src/greynoise.ts`).

## Flow

```
ntfy(universal-exports, ghostmode-alerts) → dedup → gate.evaluate()
   → [security + public IP] greynoise.lookup() → drop noise/riot/benign
   → phrase() via MLX (static fallback) → codetalker.speak() as master-control
```

## Inbound (the Code:Talker bridge)

Master Control used to be a write-only client of the bridge's `POST /speak`; its
only inbound channel was the ntfy `mc-control` topic, polled every 120s. `src/listen.ts`
adds a real listener so push-to-talk reaches it directly. ntfy `mc-control` stays live
as the fallback channel.

| Endpoint | Auth | Notes |
|----------|------|-------|
| `GET /health` | none | The bridge's probe (`registerAgent`) sends no credentials and then calls `.json()` on the body, so this must be open and must return parseable JSON. |
| `POST /mcp` | `Bearer $MC_LISTEN_TOKEN` | JSON-RPC 2.0. `initialize` returns the session in the **`mcp-session-id` response header**, which is where the bridge reads it. Tool `respond` takes `{ message, from }`. |

The RED TEAM property is unchanged: this is a second transport onto the same
pure-code `handleDirective`, not a second handler. The directive text selects
status / threats / help and never drives a tool or a shell. The bridge wraps the
directive in an MHH preamble and a context brief, so the intent is parsed from
inside the payload rather than matched against the whole string.

To wire it up, Q sets `MASTER_CONTROL_AGENT_URL=http://10.0.0.12:7910` in
`/var/services/homes/matt/.codetalker-bridge.env` and flips Master Control's
`transport` to `"mcp"` in `bridge.ts`.

## Modes (`dist/index.js <mode>` / `entrypoint.sh <mode>`)

| Mode | Behaviour |
|------|-----------|
| `daemon` | Poll→judge→narrate loop every `MC_INTERVAL_MS` (default 120s). Seeds seen-set on boot so a restart never replays a backlog. |
| `tick` | One cycle, prints JSON counts, exits. For external cron. |
| `session-begin` | Speak the session-start status line through the bridge. |

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `MC_LLM_URL` | `http://ai.matthewstevens.org:8881` | MTPLX OpenAI-compatible endpoint (phrasing only). |
| `MC_LLM_MODEL` | `qwen3.5-9b-mtplx` | Phrasing model. MTPLX answers with whatever it has loaded rather than rejecting an unknown name, so a wrong value here never errors. |
| `MC_LLM_KEY` | — | MTPLX API key (`pass: sanmarcsoft/mtplx/api-key`). MTPLX returns 401 without it; unset means every line is a template. |
| `CODETALKER_BRIDGE_URL` | `http://10.0.0.12:7900` | Code:Talker bridge. |
| `NTFY_URL` | `http://127.0.0.1:8880` | ntfy server (a1 loopback). |
| `NTFY_TOPICS` | `universal-exports` | Feeds to poll. ghostmode-alerts mirrors the same conditions, so subscribing to both announced everything twice. |
| `NTFY_TOKEN` | — | ntfy bearer (read). From `pass`. |
| `GREYNOISE_API_KEY` | — | GreyNoise community key (`pass: greynoise/api-key`). |
| `MC_INTERVAL_MS` | `120000` | Daemon poll interval. |
| `MC_POLL_SINCE` | `5m` | ntfy lookback window per poll. |
| `MC_CONTROL_TOPIC` | `mc-control` | ntfy topic MC answers operator directives on. |
| `MC_LISTEN_TOKEN` | — | Bearer for the inbound MCP listener (`pass: sanmarcsoft/master-control/listener-token`). Empty means the listener does not open at all. |
| `MC_LISTEN_HOST` | `0.0.0.0` | Listener bind address. The bridge is on the default docker bridge network, so loopback is not reachable from it. |
| `MC_LISTEN_PORT` | `7910` | Listener port. |
| `MC_SEEN_PATH` | `/opt/data/mc-seen.json` | Dedup store (mount a volume). |
| `MC_ANNOUNCED_PATH` | `/opt/data/mc-announced.json` | Content-key cooldown store. |
| `MC_REANNOUNCE_MS` | `14400000` (4h) | Re-voice an unresolved condition only after this, or on priority escalation. |
| `MC_NARRATION_LOG` | `/opt/data/mc-narrations.jsonl` | Durable narration ledger. |
| `MC_NARRATION_LOG_MAX_BYTES` | `5000000` | Ledger rotation threshold. |

The `OLLAMA_*` names this table used to list are gone; nothing here has run on
Ollama for some time.

## Build, test, run

```bash
bun add -d @types/node@22 typescript@5   # or npm i -D
bunx tsc -p tsconfig.json                # typecheck + emit dist/
node --test dist/*.test.js               # the gate. Scoped to *.test.js on purpose:
                                         # `node --test dist/` also picks up index.js,
                                         # whose top-level switch starts the daemon, so
                                         # the run never terminates.
node dist/index.js tick                  # one cycle
```

## Deploy (on a1)

Build the image on **ai.matthewstevens.org** (never on a1), push to
`applepublicdotcom/master-control-agent:testing`, then on a1:

```bash
mkdir -p ~/master-control/data
cp master-control-agent/docker-compose.master-control.yml ~/master-control/
cp master-control-agent/master-control.env.example ~/master-control/master-control.env
# populate NTFY_TOKEN + GREYNOISE_API_KEY + MC_LLM_KEY from pass
cd ~/master-control && docker compose -f docker-compose.master-control.yml up -d
docker logs -f master-control
```

The boot banner prints `key=set` or `key=MISSING`, never the value. `MISSING`
means the phrasing model will 401 and every line will be the template.

Compose hardening (already set): `cap_drop: ALL`, `no-new-privileges`, 256M. No
`cpus:` limit: the DSM kernel on a1 lacks the CPU CFS scheduler, so setting one
makes `docker compose up` fail with "NanoCPUs can not be set".
limits. Trip a priority-5 ntfy alert on `universal-exports` → MC speaks within ~2m;
a priority-2 routine ping → silence.
