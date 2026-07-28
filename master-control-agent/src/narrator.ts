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
import { pollAll, TOPICS } from "./ntfy.js";
import { lookup, isRealThreat } from "./greynoise.js";
import { phrase } from "./phrase.js";
import { speak } from "./codetalker.js";
import { recordNarration } from "./record.js";
import { seedControl, pollControl, type McStatus } from "./control.js";

const SEEN_PATH = process.env.MC_SEEN_PATH ?? "/opt/data/mc-seen.json";
const POLL_SINCE = process.env.MC_POLL_SINCE ?? "5m";
const SEEN_MAX = 2000;

// Content-based re-announce suppression. A persistently-firing monitor arrives
// each poll as a NEW ntfy id, so id-dedup alone re-voices it every ~120s (the
// "plethora of repeats"). Suppress by a stable CONTENT key with a cooldown:
// re-voice the same unresolved condition only on priority escalation or after
// MC_REANNOUNCE_MS. This is the primary fix for repeat narration.
const ANNOUNCED_PATH = process.env.MC_ANNOUNCED_PATH ?? "/opt/data/mc-announced.json";
const REANNOUNCE_MS = Number(process.env.MC_REANNOUNCE_MS ?? 4 * 3_600_000); // 4h
const ANNOUNCED_MAX = 2000;

interface Announcement {
  ts: number;
  priority: number;
}

/**
 * Stable content key — title+message, whitespace/case-normalised.
 *
 * Deliberately NOT keyed on topic. The publishers mirror each alert to more
 * than one topic on purpose (ghostmode-alerts is the client view,
 * universal-exports the operator's) and Master Control subscribes to both.
 * Including the topic made each mirror a distinct key, so the cooldown could
 * never collapse them and every condition was announced twice: the ntfy corpus
 * for 2026-07-28 shows 23 identical Dev NEST alerts on each of the two topics.
 * One condition, one announcement, wherever it was published.
 */
export function contentKey(a: NtfyAlert): string {
  return `${a.title}|${a.message}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function loadAnnounced(): Record<string, Announcement> {
  try {
    return JSON.parse(readFileSync(ANNOUNCED_PATH, "utf8")) as Record<string, Announcement>;
  } catch {
    return {};
  }
}

function saveAnnounced(map: Record<string, Announcement>): void {
  // Bound growth: keep the most-recent ANNOUNCED_MAX by timestamp.
  const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, ANNOUNCED_MAX);
  try {
    mkdirSync(dirname(ANNOUNCED_PATH), { recursive: true });
    writeFileSync(ANNOUNCED_PATH, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* best-effort; a missed persist just risks one extra re-announce */
  }
}

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
  undelivered: number; // approved + recorded but the bridge would not accept it (retried next tick)
  // Phrasing health. A tick can be perfectly "successful" on every count above
  // while every line came from the template because the model is unreachable.
  // That happened, for hours, invisibly. These two make it a number.
  fellBack: number; // lines that used the deterministic template
  llmUnreachable: number; // subset of fellBack where the model could not be reached
}

/** One poll → judge → narrate cycle. Returns counts for logging. */
export async function tick(): Promise<TickResult> {
  const seen = loadSeen();
  const announced = loadAnnounced();
  const alerts = await pollAll(POLL_SINCE);
  const fresh = alerts.filter((a) => !seen.has(a.id));
  let spoken = 0;
  let swallowed = 0;
  let undelivered = 0;
  let fellBack = 0;
  let llmUnreachable = 0;

  for (const alert of fresh) {
    const decision = evaluate(alert);
    if (!decision.speak) {
      seen.add(alert.id); // legitimately not voiced — never reconsider
      swallowed++;
      continue;
    }
    // Content-cooldown: same condition already voiced recently and not escalated → swallow.
    const key = contentKey(alert);
    const prev = announced[key];
    const escalated = prev !== undefined && alert.priority > prev.priority;
    if (prev !== undefined && !escalated && Date.now() - prev.ts < REANNOUNCE_MS) {
      seen.add(alert.id);
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
        seen.add(alert.id);
        swallowed++;
        continue;
      } else {
        note = `GreyNoise confirms ${decision.ip} malicious`;
      }
    }
    const { line, source: phraseSource } = await phrase(alert, note);
    if (phraseSource !== "llm") fellBack++;
    if (phraseSource === "unreachable") llmUnreachable++;
    const ok = await speak(line);
    // Durable ledger FIRST, independent of delivery: this is the "never lose a
    // narration" guarantee. A delivered line is also mirrored to Matrix by the
    // bridge; an undelivered one (bridge down / empty room) survives only here.
    recordNarration({
      ts: new Date().toISOString(),
      id: alert.id,
      topic: alert.topic,
      title: alert.title,
      message: alert.message,
      priority: alert.priority,
      security: Boolean(decision.security),
      ip: decision.ip,
      note,
      line,
      phraseSource,
      delivered: ok,
    });
    if (ok) {
      seen.add(alert.id); // delivered → done
      announced[key] = { ts: Date.now(), priority: alert.priority }; // start cooldown
      spoken++;
    } else {
      // NOT marked seen: a transient bridge outage gets retried next tick while
      // the alert is still inside the poll window, instead of vanishing.
      undelivered++;
    }
  }

  saveSeen(seen);
  saveAnnounced(announced);
  return { polled: alerts.length, fresh: fresh.length, spoken, swallowed, undelivered, fellBack, llmUnreachable };
}

/** Long-running daemon: tick every MC_INTERVAL_MS (default 120s). */
export async function daemon(): Promise<void> {
  const intervalMs = Number(process.env.MC_INTERVAL_MS ?? 120_000);
  // On boot, seed the seen-set from the recent window WITHOUT speaking, so a
  // restart does not replay a backlog of old alerts.
  const seen = loadSeen();
  for (const a of await pollAll(POLL_SINCE).catch(() => [] as NtfyAlert[])) seen.add(a.id);
  saveSeen(seen);
  await seedControl(); // don't replay a backlog of old directives on restart
  log(`Master Control narrator online. Interval ${intervalMs}ms.`);
  let last: TickResult | undefined;
  for (;;) {
    try {
      const r = await tick();
      last = r;
      if (r.spoken || r.fresh)
        log(
          `tick: polled=${r.polled} fresh=${r.fresh} spoken=${r.spoken} swallowed=${r.swallowed} ` +
            `undelivered=${r.undelivered} fellBack=${r.fellBack} llmUnreachable=${r.llmUnreachable}`,
        );
      // A dead phrasing model is not a tick failure, so it never raised anything.
      // Say it plainly, once per affected tick, at the level an operator reads.
      if (r.llmUnreachable > 0) log(`WARN: phrasing model unreachable for ${r.llmUnreachable} line(s); speaking from templates`);
    } catch (err) {
      log(`tick error: ${String(err)}`);
    }
    try {
      // Two-way presence: answer any operator directive on the control topic.
      const status: McStatus = { online: true, topics: TOPICS, last };
      const handled = await pollControl(status);
      if (handled) log(`control: answered ${handled} directive(s)`);
    } catch (err) {
      log(`control error: ${String(err)}`);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}
