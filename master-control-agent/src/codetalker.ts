/**
 * codetalker.ts — speak a line through the PAI Code:Talker bridge as
 * the "master-control" voice. Verified contract:
 *   POST /speak {voice_id, text, voice_enabled:true} -> 200 {ok, id, audio:"queued"}
 */
const BRIDGE_URL = process.env.CODETALKER_BRIDGE_URL ?? "http://10.0.0.12:7900";

export async function speak(text: string, voiceId = "master-control"): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: voiceId, text, voice_enabled: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const d = (await res.json()) as { ok?: boolean };
    return Boolean(d.ok);
  } catch {
    return false;
  }
}
