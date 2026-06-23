/**
 * narrator.ts — Master Control's run loop.
 *
 * Flow per RED TEAM architecture (deterministic gate; LLM phrasing only):
 *   poll ntfy (universal-exports + ghostmode-alerts)
 *     -> dedup vs on-disk seen-set
 *     -> evaluate() deterministic gate  (speak? security?)
 *     -> if security + public IP: GreyNoise validate, drop noise/riot/benign
 *     -> phrase() the survivors via MLX (static fallback)
 *     -> speak() through the Code:Talker bridge as "master-control"
 *
 * The narrator never executes alert text and holds no shell/file tools.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { evaluate, type NtfyAlert } from "./gate.js";
import { pollAll } from "./ntfy.js";
import { lookup, isRealThreat } from "./greynoise.js";
import { phrase } from "./phrase.js";
import { speak } from "./codetalker.js";

const SEEN_PATH = process.env.MC_SEEN_PATH ?? "/opt/data/mc-seen.json";
const POLL_SINCE = process.env.MC_POLL_SINCE ?? "5m";
const SEEN_MAX = 2000;

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  const arr = [...seen].slice(-SEEN_MAX);
  try {
    mkdirSync(dirname(SEEN_PATH), { recursive: true });
    writeFileSync(SEEN_PATH, JSON.stringify(arr));
  } catch {
    /* best-effort; a missed persist just risks re-announcing once */
  }
}

export interface TickResult {
  polled: number;
  fresh: number;
  spoken: number;
  swallowed: number;
}

/** One poll → judge → narrate cycle. Returns counts for logging. */
export async function tick(): Promise<TickResult> {
  const seen = loadSeen();
  const alerts = await pollAll(POLL_SINCE);
  const fresh = alerts.filter((a) => !seen.has(a.id));
  let spoken = 0;
  let swallowed = 0;

  for (const alert of fresh) {
    seen.add(alert.id);
    const decision = evaluate(alert);
    if (!decision.speak) {
      swallowed++;
      continue;
    }
    let note: string | undefined;
    if (decision.security && decision.ip) {
      const verdict = await lookup(decision.ip);
      if (verdict.classification === "internal") {
        note = `source ${decision.ip} is internal`;
      } else if (!isRealThreat(verdict)) {
        // GreyNoise says noise / riot / benign / unconfirmed → do not cry wolf.
        swallowed++;
        continue;
      } else {
        note = `GreyNoise confirms ${decision.ip} malicious`;
      }
    }
    const line = await phrase(alert, note);
    const ok = await speak(line);
    if (ok) spoken++;
    else swallowed++; // could not voice; counts as not-announced
  }

  saveSeen(seen);
  return { polled: alerts.length, fresh: fresh.length, spoken, swallowed };
}

/** Long-running daemon: tick every MC_INTERVAL_MS (default 120s). */
export async function daemon(): Promise<void> {
  const intervalMs = Number(process.env.MC_INTERVAL_MS ?? 120_000);
  // On boot, seed the seen-set from the recent window WITHOUT speaking, so a
  // restart does not replay a backlog of old alerts.
  const seen = loadSeen();
  for (const a of await pollAll(POLL_SINCE).catch(() => [] as NtfyAlert[])) seen.add(a.id);
  saveSeen(seen);
  log(`Master Control narrator online. Interval ${intervalMs}ms.`);
  for (;;) {
    try {
      const r = await tick();
      if (r.spoken || r.fresh) log(`tick: polled=${r.polled} fresh=${r.fresh} spoken=${r.spoken} swallowed=${r.swallowed}`);
    } catch (err) {
      log(`tick error: ${String(err)}`);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}
