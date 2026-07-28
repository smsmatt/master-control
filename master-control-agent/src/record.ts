/**
 * record.ts — durable narration ledger ("never lose a narration").
 *
 * Every line Master Control DECIDES to voice is appended here as JSONL,
 * independent of whether the Code:Talker bridge accepted it or any webview was
 * listening (ws_clients may be 0 — audio synthesised into an empty room). The
 * bridge separately mirrors *delivered* lines into the Matrix room; this ledger
 * additionally captures UNDELIVERED lines (bridge down / speak() failed), so an
 * ops narration is never silently lost. The path lives on the mounted
 * /opt/data volume, so the ledger survives container restarts.
 *
 * Best-effort and side-effect-only: a ledger write must never break the
 * narrate loop, so every operation is wrapped and never throws.
 */
import { appendFileSync, mkdirSync, statSync, renameSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Read env per-call (not at module load) so it stays testable.
function logPath(): string {
  return process.env.MC_NARRATION_LOG ?? "/opt/data/mc-narrations.jsonl";
}
function maxBytes(): number {
  return Number(process.env.MC_NARRATION_LOG_MAX_BYTES ?? 5_000_000);
}

export interface NarrationRecord {
  ts: string; // ISO timestamp
  id: string; // ntfy alert id (or synthetic, e.g. "session-begin")
  topic: string;
  title: string;
  message?: string; // source alert body — recorded so the quality monitor can ground numerals
  priority?: number; // source ntfy priority — for severity-accuracy grading
  security: boolean;
  ip?: string;
  note?: string;
  line: string; // the phrased line that was (or would have been) spoken
  delivered: boolean; // did the bridge accept the /speak?
}

/** Rotate the ledger to `<path>.1` once it crosses the size cap. */
function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size >= maxBytes()) renameSync(path, `${path}.1`);
  } catch {
    /* file may not exist yet — nothing to rotate */
  }
}

/** Append one narration to the durable ledger. Never throws. */
export function recordNarration(rec: NarrationRecord): void {
  const path = logPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(rec)}\n`);
  } catch {
    /* a missed ledger write must never break the narrate loop */
  }
}

/** Read the last `n` narrations from the live ledger (newest last). Never throws. */
export function readRecent(n = 50): NarrationRecord[] {
  try {
    const lines = readFileSync(logPath(), "utf8").trim().split("\n").filter(Boolean);
    const out: NarrationRecord[] = [];
    for (const l of lines.slice(-n)) {
      try {
        out.push(JSON.parse(l) as NarrationRecord);
      } catch {
        /* skip a malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
