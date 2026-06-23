/**
 * record.test.ts — the durable narration ledger is the "never lose a narration"
 * guarantee, so its append + rotation behaviour is under test (TDD, SOP).
 *
 * Run: node --test (after build) or via the package test script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordNarration } from "./record.js";

test("appends every narration as valid JSONL, delivered or not", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-rec-"));
  const path = join(dir, "n.jsonl");
  process.env.MC_NARRATION_LOG = path;
  delete process.env.MC_NARRATION_LOG_MAX_BYTES;
  try {
    recordNarration({ ts: "t1", id: "a", topic: "universal-exports", title: "T", security: false, line: "hello", delivered: true });
    recordNarration({ ts: "t2", id: "b", topic: "ghostmode-alerts", title: "U", security: true, ip: "1.2.3.4", note: "n", line: "world", delivered: false });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const r2 = JSON.parse(lines[1]);
    assert.equal(r2.delivered, false); // the undelivered line is preserved — the whole point
    assert.equal(r2.ip, "1.2.3.4");
    assert.equal(r2.line, "world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotates to <path>.1 once the size cap is crossed", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-rec-"));
  const path = join(dir, "n.jsonl");
  process.env.MC_NARRATION_LOG = path;
  process.env.MC_NARRATION_LOG_MAX_BYTES = "10"; // tiny → first record forces a rotation on the next
  try {
    recordNarration({ ts: "t1", id: "a", topic: "x", title: "", security: false, line: "first-line-well-over-ten-bytes", delivered: true });
    recordNarration({ ts: "t2", id: "b", topic: "x", title: "", security: false, line: "second", delivered: true });
    assert.ok(existsSync(`${path}.1`), "rotated file should exist");
    const live = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(live.length, 1);
    assert.equal(JSON.parse(live[0]).id, "b"); // newest line is in the live ledger
  } finally {
    delete process.env.MC_NARRATION_LOG_MAX_BYTES;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never throws on an unwritable path", () => {
  process.env.MC_NARRATION_LOG = "/proc/nonexistent-dir/cannot-write.jsonl";
  try {
    assert.doesNotThrow(() =>
      recordNarration({ ts: "t", id: "a", topic: "x", title: "", security: false, line: "x", delivered: true }),
    );
  } finally {
    delete process.env.MC_NARRATION_LOG;
  }
});
