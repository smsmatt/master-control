/**
 * The grounding guard is what stops Master Control inventing facts aloud.
 *
 * It rejected a line whose digits were absent from the source, which the model
 * learned to walk around by spelling the numbers out. From the narration ledger:
 * "nearly fifty thousand seconds of failed probes" and "eight thousand
 * consecutive checks", both spoken from a record whose message field was empty.
 * The digit-only regex saw no digits, found nothing to check, and passed it.
 *
 * The system prompt already says "copy any number exactly as written, never
 * convert it to words". Nothing enforced it. These tests do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { numeralsGrounded } from "./phrase.js";

// --- digits, the original guard ---------------------------------------------

test("a digit present in the source is grounded", () => {
  assert.equal(numeralsGrounded("Master Control. 3 containers unhealthy. Out.", "3 containers unhealthy"), true);
});

test("a digit absent from the source is rejected", () => {
  assert.equal(numeralsGrounded("Master Control. Failing for 902 checks. Out.", "Database dev is down"), false);
});

test("a line with no numbers at all is grounded", () => {
  assert.equal(numeralsGrounded("Master Control. Endpoint unreachable. Out.", "endpoint unreachable"), true);
});

// --- word numerals, the bypass ----------------------------------------------

test("a spelled-out number absent from the source is rejected", () => {
  assert.equal(numeralsGrounded("Master Control. Eight thousand consecutive checks. Out.", ""), false);
});

test("the exact ledger line that got through is rejected", () => {
  assert.equal(
    numeralsGrounded("Master Control. Nearly fifty thousand seconds of failed probes. Out.", ""),
    false,
  );
});

test("a magnitude word alone is enough to reject", () => {
  assert.equal(numeralsGrounded("Master Control. Millions of requests blocked. Out.", "requests blocked"), false);
});

test("a small spelled-out number is still a claim", () => {
  assert.equal(numeralsGrounded("Master Control. Three databases are down. Out.", "database is down"), false);
});

test("a spelled-out number IS allowed when the source spells it too", () => {
  assert.equal(
    numeralsGrounded("Master Control. Three containers unhealthy. Out.", "three containers unhealthy"),
    true,
  );
});

test("a spelled-out number is allowed when the source has the digit", () => {
  assert.equal(numeralsGrounded("Master Control. Three containers unhealthy. Out.", "3 containers unhealthy"), true);
});

test("a digit is allowed when the source spells the number", () => {
  assert.equal(numeralsGrounded("Master Control. 3 containers unhealthy. Out.", "three containers unhealthy"), true);
});

// --- words that merely look numeric -----------------------------------------

test("ordinary prose containing 'one' as a pronoun is not a fabricated number", () => {
  // "no one", "one of", "someone" must not trip the guard and force the fallback
  // on every second line. The guard exists to catch invented counts.
  assert.equal(numeralsGrounded("Master Control. No one is on call. Out.", "nobody on call"), true);
  assert.equal(numeralsGrounded("Master Control. Someone forced a push. Out.", "forced push"), true);
});

test("the word 'a' and 'an' are not counted as the number one", () => {
  assert.equal(numeralsGrounded("Master Control. A container is unhealthy. Out.", "container unhealthy"), true);
});

test("case does not matter on either side", () => {
  assert.equal(numeralsGrounded("Master Control. THREE nodes are down. Out.", "Three nodes are down"), true);
});

// --- the guard must not become so strict it silences real alerts ------------

test("a full real alert phrased faithfully passes", () => {
  const source =
    "4 containers unhealthy on local. 4 containers are failing Docker health checks on local for >5m.";
  const line = "Master Control. 4 containers are failing health checks on local. Out.";
  assert.equal(numeralsGrounded(line, source), true);
});

test("a decimal is matched against the source verbatim", () => {
  assert.equal(numeralsGrounded("Master Control. Latency 1.5 seconds. Out.", "latency 1.5s"), true);
  assert.equal(numeralsGrounded("Master Control. Latency 2.5 seconds. Out.", "latency 1.5s"), false);
});
