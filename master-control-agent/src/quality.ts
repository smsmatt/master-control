/**
 * quality.ts — the Master Control narration-quality grader.
 *
 * This is the measurement half of the performance-monitoring loop that proves
 * the speech fed to the operator is IMPROVING (or regressing) over time. It
 * grades the durable narration ledger (record.ts) with the SAME deterministic
 * graders the offline eval harness validated, so a live number and a test-bench
 * number mean the same thing.
 *
 * Metrics are computed from the ledger alone (no labels required), so the loop
 * runs unattended:
 *   - hallucinationRate: fraction of spoken lines containing a numeral absent
 *     from the source alert (title+message). This is the "failing for 902
 *     checks" failure class; target 0.
 *   - duplicateRate: fraction of narrations whose content key was already voiced
 *     inside the window (repeat/"plethora" narration); target 0.
 *   - fallbackRate: fraction of lines that are the deterministic fallback
 *     template (LLM down or its output was rejected as ungrounded). Diagnostic,
 *     not inherently bad — a rising fallbackRate with a flat hallucinationRate
 *     means the grounding guard is doing its job.
 *   - undeliveredRate: fraction the bridge would not accept (delivery health).
 */
import type { NarrationRecord } from "./record.js";
import { numeralsGrounded } from "./phrase.js";
import { contentKey } from "./narrator.js";

export interface QualityMetrics {
  n: number; // narrations graded
  hallucinationRate: number;
  duplicateRate: number;
  fallbackRate: number;
  undeliveredRate: number;
  windowStart?: string;
  windowEnd?: string;
}

/** A line is the deterministic fallback if it matches the record.ts template shape. */
export function isFallback(line: string): boolean {
  return /^Master Control\. (Alert|Notice), .+\. .+\. Out\.$/.test(line.trim());
}

/** Grade a set of ledger records. Pure; safe on an empty set. */
export function computeQuality(records: NarrationRecord[]): QualityMetrics {
  const n = records.length;
  if (n === 0) {
    return { n: 0, hallucinationRate: 0, duplicateRate: 0, fallbackRate: 0, undeliveredRate: 0 };
  }

  let hallucinated = 0;
  let duplicate = 0;
  let fallback = 0;
  let undelivered = 0;
  const seenKeys = new Set<string>();

  for (const r of records) {
    const source = `${r.title} ${r.message ?? ""} ${r.note ?? ""}`;
    if (!numeralsGrounded(r.line, source)) hallucinated++;
    if (isFallback(r.line)) fallback++;
    if (!r.delivered) undelivered++;

    const key = contentKey({ topic: r.topic, title: r.title, message: r.message ?? "" } as never);
    if (seenKeys.has(key)) duplicate++;
    else seenKeys.add(key);
  }

  return {
    n,
    hallucinationRate: hallucinated / n,
    duplicateRate: duplicate / n,
    fallbackRate: fallback / n,
    undeliveredRate: undelivered / n,
    windowStart: records[0]?.ts,
    windowEnd: records[n - 1]?.ts,
  };
}

/** Render metrics as Prometheus text-exposition (for a node_exporter textfile collector). */
export function toPrometheus(m: QualityMetrics): string {
  const g = (name: string, help: string, value: number) =>
    `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
  return (
    g("mc_narration_graded_total", "Narrations graded in the current window", m.n) +
    g("mc_narration_hallucination_rate", "Fraction of lines with a numeral absent from the source alert", m.hallucinationRate) +
    g("mc_narration_duplicate_rate", "Fraction of lines repeating a content key already voiced in the window", m.duplicateRate) +
    g("mc_narration_fallback_rate", "Fraction of lines using the deterministic fallback template", m.fallbackRate) +
    g("mc_narration_undelivered_rate", "Fraction of narrations the bridge did not accept", m.undeliveredRate)
  );
}
