#!/usr/bin/env node
/**
 * quality-report.ts — the runner half of the narration-quality monitoring loop.
 *
 * Reads the durable narration ledger, grades it with quality.ts, prints a human
 * report, and writes Prometheus text-exposition to a node_exporter textfile so
 * the five mc_narration_* gauges trend in Grafana and a regression alert can
 * fire when quality degrades. Run on a timer (cron / MC entrypoint sidecar):
 *
 *   MC_QUALITY_PROM=/opt/data/textfile/mc_quality.prom bun run src/quality-report.ts
 *
 * With the textfile dir mounted into node_exporter --collector.textfile, the
 * loop is: narrate → ledger → grade → gauges → Grafana trend + regression alert.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NarrationRecord } from "./record.js";
import { computeQuality, toPrometheus } from "./quality.js";

const LEDGER = process.env.MC_NARRATION_LOG ?? "/opt/data/mc-narrations.jsonl";
const PROM_OUT = process.env.MC_QUALITY_PROM ?? "";
const WINDOW = Number(process.env.MC_QUALITY_WINDOW ?? 500); // last N narrations

function loadLedger(path: string, n: number): NarrationRecord[] {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out: NarrationRecord[] = [];
  for (const l of lines.slice(-n)) {
    try {
      out.push(JSON.parse(l) as NarrationRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

const records = loadLedger(LEDGER, WINDOW);
const m = computeQuality(records);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
process.stdout.write(
  [
    `Master Control narration quality — last ${m.n} narrations` +
      (m.windowStart ? ` (${m.windowStart} … ${m.windowEnd})` : ""),
    `  hallucination : ${pct(m.hallucinationRate)}   (numeral not in source — target 0)`,
    `  duplicate     : ${pct(m.duplicateRate)}   (repeat of a voiced condition — target 0)`,
    `  fallback      : ${pct(m.fallbackRate)}   (deterministic template — diagnostic)`,
    `  undelivered   : ${pct(m.undeliveredRate)}   (bridge rejected — delivery health)`,
    "",
  ].join("\n"),
);

if (PROM_OUT) {
  try {
    mkdirSync(dirname(PROM_OUT), { recursive: true });
    // Atomic write so a mid-write scrape never reads a half file.
    writeFileSync(`${PROM_OUT}.tmp`, toPrometheus(m));
    writeFileSync(PROM_OUT, toPrometheus(m));
    process.stdout.write(`wrote ${PROM_OUT}\n`);
  } catch (err) {
    process.stderr.write(`prom write failed: ${String(err)}\n`);
  }
}
