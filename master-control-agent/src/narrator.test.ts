/**
 * contentKey decides whether two alerts are "the same condition".
 *
 * The publishers mirror every asset alert to more than one topic on purpose:
 * ghostmode-alerts is the Phenom client view, universal-exports is the
 * operator's full view, and Master Control subscribes to both. That is correct
 * routing. It is not two events, and it must not be two announcements.
 *
 * With the topic in the key it was, so the re-announce cooldown could never
 * collapse the mirrors and every condition was spoken exactly twice. The ntfy
 * corpus for 2026-07-28 shows the shape precisely: 23 identical Dev NEST alerts
 * on ghostmode-alerts and the same 23 on universal-exports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentKey } from "./narrator.js";
import type { NtfyAlert } from "./gate.js";

function alert(over: Partial<NtfyAlert> = {}): NtfyAlert {
  return {
    id: "x",
    topic: "universal-exports",
    title: "Dev NEST: DOWN",
    message: "Dev NEST is DOWN (dev-nest.thephenom.app).\nProbe code: 200 (expected healthy).",
    priority: 5,
    time: 0,
    tags: [],
    ...over,
  };
}

test("the same condition mirrored to two topics is one condition", () => {
  const onClientView = alert({ id: "a", topic: "ghostmode-alerts" });
  const onOperatorView = alert({ id: "b", topic: "universal-exports" });
  assert.equal(contentKey(onClientView), contentKey(onOperatorView));
});

test("the same condition re-published under a new ntfy id is one condition", () => {
  assert.equal(contentKey(alert({ id: "first" })), contentKey(alert({ id: "second" })));
});

test("different conditions stay distinct", () => {
  assert.notEqual(
    contentKey(alert({ title: "Dev NEST: DOWN" })),
    contentKey(alert({ title: "DB - prod (RDS Postgres): DOWN" })),
  );
  assert.notEqual(
    contentKey(alert({ message: "Probe code: 200" })),
    contentKey(alert({ message: "Probe code: 503" })),
  );
});

test("a recovery is not the same condition as the outage it ends", () => {
  assert.notEqual(
    contentKey(alert({ title: "Dev NEST: DOWN" })),
    contentKey(alert({ title: "Dev NEST: RECOVERED" })),
  );
});

test("whitespace and case do not create a new condition", () => {
  assert.equal(
    contentKey(alert({ title: "Dev NEST: DOWN", message: "a  b\n c" })),
    contentKey(alert({ title: "dev nest: down", message: "a b c" })),
  );
});

test("the key survives an empty title or message", () => {
  assert.doesNotThrow(() => contentKey(alert({ title: "", message: "" })));
});
