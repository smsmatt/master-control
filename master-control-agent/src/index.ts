#!/usr/bin/env node
/**
 * Master Control agent — CLI entry. Modes modeled on moneypenny's entrypoint.
 *   daemon         long-running poll→judge→narrate loop (default)
 *   tick           one cycle, then exit (for external cron)
 *   session-begin  speak the session-start status line via the bridge
 */
import { daemon, tick } from "./narrator.js";
import { speak } from "./codetalker.js";
import { phrase } from "./phrase.js";

async function sessionBegin(): Promise<void> {
  // A synthetic "session start" event, phrased by the LLM (static fallback inside phrase()).
  const line = await phrase(
    {
      id: "session-begin",
      topic: "session",
      title: "Code:Talker session begin",
      message: "A Claude session has started. Give a one-line online status: watching universal-exports and ghostmode-alerts.",
      priority: 3,
      time: Math.floor(Date.now() / 1000),
      tags: [],
    },
    "session greeting; report online and what you are watching",
  );
  await speak(line);
}

const mode = process.argv[2] ?? "daemon";
switch (mode) {
  case "daemon":
    await daemon();
    break;
  case "tick": {
    const r = await tick();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    break;
  }
  case "session-begin":
    await sessionBegin();
    break;
  default:
    process.stderr.write(`Usage: master-control {daemon|tick|session-begin}\n`);
    process.exit(1);
}
