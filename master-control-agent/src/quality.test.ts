/**
 * quality.test.ts — grades of the narration-quality monitor. node:test to keep
 * tsc clean under types:["node"] (matches gate.test.ts / record.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeQuality, isFallback, toPrometheus } from "./quality.js";
import type { NarrationRecord } from "./record.js";

function rec(p: Partial<NarrationRecord>): NarrationRecord {
  return {
    ts: p.ts ?? "2026-07-01T00:00:00.000Z",
    id: p.id ?? "a1",
    topic: p.topic ?? "l",
    title: p.title ?? "verifieddit.com: DOWN",
    message: p.message,
    priority: p.priority ?? 4,
    security: p.security ?? false,
    note: p.note,
    line: p.line ?? "Master Control. verifieddit.com is down. Out.",
    phraseSource: p.phraseSource,
    delivered: p.delivered ?? true,
  };
}

test("empty ledger → all-zero metrics, no throw", () => {
  assert.deepEqual(computeQuality([]), {
    n: 0,
    hallucinationRate: 0,
    duplicateRate: 0,
    fallbackRate: 0,
    llmUnreachableRate: 0,
    undeliveredRate: 0,
  });
});

test("flags a fabricated numeral not in the source (the 902-checks class)", () => {
  const m = computeQuality([
    rec({ title: "database-dev: unhealthy", message: "1 container unhealthy", line: "Master Control. Database dev is down failing for 902 checks. Out." }),
  ]);
  assert.equal(m.hallucinationRate, 1);
});

test("a numeral copied verbatim from the source is NOT flagged", () => {
  const m = computeQuality([
    rec({ title: "3 containers unhealthy on a1", message: "3 containers are failing health checks", line: "Master Control. 3 containers unhealthy on a1. Out." }),
  ]);
  assert.equal(m.hallucinationRate, 0);
});

test("counts a content-key repeat as a duplicate", () => {
  const same = { title: "ca.trusteddit.com: DOWN", message: "unreachable for 5 minutes" };
  const m = computeQuality([
    rec({ ...same, id: "x1", line: "Master Control. ca.trusteddit.com is down. Out." }),
    rec({ ...same, id: "x2", line: "Master Control. ca.trusteddit.com is down. Out." }),
  ]);
  assert.equal(m.n, 2);
  assert.equal(m.duplicateRate, 0.5);
});

test("tracks fallback and undelivered rates", () => {
  const m = computeQuality([
    rec({ line: "Master Control. Alert, l. verifieddit.com: DOWN. Out.", delivered: false }),
  ]);
  assert.equal(m.fallbackRate, 1);
  assert.equal(m.undeliveredRate, 1);
});

test("isFallback recognises the template and not an LLM line", () => {
  assert.equal(isFallback("Master Control. Alert, l. verifieddit.com: DOWN. Out."), true);
  assert.equal(isFallback("Master Control. verifieddit.com is unreachable. Out."), false);
});

// --- separating a dead model from a working guard ---------------------------

test("an unreachable model raises llmUnreachableRate, not just fallbackRate", () => {
  const m = computeQuality([rec({ phraseSource: "unreachable" })]);
  assert.equal(m.fallbackRate, 1);
  assert.equal(m.llmUnreachableRate, 1);
});

test("a rejected line counts as fallback but leaves llmUnreachableRate at zero", () => {
  // The guard rejecting an ungrounded line is the system working. Reading it as
  // an outage would send an operator chasing a healthy dependency.
  const m = computeQuality([rec({ phraseSource: "rejected" })]);
  assert.equal(m.fallbackRate, 1);
  assert.equal(m.llmUnreachableRate, 0);
});

test("an LLM line that happens to look like the template is not counted as fallback", () => {
  const m = computeQuality([
    rec({ phraseSource: "llm", line: "Master Control. Alert, l. verifieddit.com: DOWN. Out." }),
  ]);
  assert.equal(m.fallbackRate, 0);
});

test("records written before phraseSource existed still grade by shape", () => {
  const m = computeQuality([rec({ line: "Master Control. Alert, l. verifieddit.com: DOWN. Out." })]);
  assert.equal(m.fallbackRate, 1);
  assert.equal(m.llmUnreachableRate, 0);
});

test("toPrometheus emits the gauges", () => {
  const out = toPrometheus(computeQuality([rec({})]));
  assert.ok(out.includes("mc_narration_graded_total 1"));
  assert.ok(out.includes("mc_narration_hallucination_rate 0"));
  assert.ok(out.includes("# TYPE mc_narration_duplicate_rate gauge"));
  assert.ok(out.includes("# TYPE mc_narration_llm_unreachable_rate gauge"));
});
