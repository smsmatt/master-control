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

## Modes (`dist/index.js <mode>` / `entrypoint.sh <mode>`)

| Mode | Behaviour |
|------|-----------|
| `daemon` | Poll→judge→narrate loop every `MC_INTERVAL_MS` (default 120s). Seeds seen-set on boot so a restart never replays a backlog. |
| `tick` | One cycle, prints JSON counts, exits. For external cron. |
| `session-begin` | Speak the session-start status line through the bridge. |

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `OLLAMA_URL` | `http://ai.matthewstevens.org:8881` | MLX OpenAI-compatible endpoint (phrasing only). |
| `OLLAMA_MODEL` | `mlx-community/Qwen3-14B-4bit-AWQ` | Phrasing model. |
| `CODETALKER_BRIDGE_URL` | `http://10.0.0.12:7900` | Code:Talker bridge. |
| `NTFY_URL` | `http://127.0.0.1:8880` | ntfy server (a1 loopback). |
| `NTFY_TOPICS` | `universal-exports,ghostmode-alerts` | Feeds to poll. |
| `NTFY_TOKEN` | — | ntfy bearer (read). From `pass`. |
| `GREYNOISE_API_KEY` | — | GreyNoise community key (`pass: greynoise/api-key`). |
| `MC_INTERVAL_MS` | `120000` | Daemon poll interval. |
| `MC_SEEN_PATH` | `/opt/data/mc-seen.json` | Dedup store (mount a volume). |

## Build, test, run

```bash
bun add -d @types/node@22 typescript@5   # or npm i -D
bunx tsc -p tsconfig.json                # typecheck + emit dist/
node --test dist/                        # gate tests (or: bun test src/gate.test.ts)
node dist/index.js tick                  # one cycle
```

## Deploy (on a1)

Build the image on **ai.matthewstevens.org** (never on a1), push to
`applepublicdotcom/master-control-agent:testing`, then on a1:

```bash
mkdir -p ~/master-control/data
cp master-control-agent/docker-compose.master-control.yml ~/master-control/
cp master-control-agent/master-control.env.example ~/master-control/master-control.env
# populate NTFY_TOKEN + GREYNOISE_API_KEY from pass
cd ~/master-control && docker compose -f docker-compose.master-control.yml up -d
docker logs -f master-control
```

Compose hardening (already set): `cap_drop: ALL`, `no-new-privileges`, 256M/0.5cpu
limits. Trip a priority-5 ntfy alert on `universal-exports` → MC speaks within ~2m;
a priority-2 routine ping → silence.
