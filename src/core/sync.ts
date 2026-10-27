import type { LyricLine, PlaybackSnapshot, LyricsDocument } from "./types";

/** Anchor every update to the player's clock; never accumulate rendering deltas. */
export function positionAt(
  snapshot: PlaybackSnapshot,
  nowMs: number,
  offsetMs = 0,
): number {
  const age = Math.max(0, nowMs - snapshot.observedAtMs);
  const elapsed =
    snapshot.status === "playing"
      ? Math.min(age, 2000) * snapshot.playbackRate
      : 0;
  return Math.max(
    0,
    Math.min(
      snapshot.track.durationMs,
      snapshot.positionMs + elapsed + offsetMs,
    ),
  );
}
export function activeLineAt(lines: LyricLine[], positionMs: number): number {
  let lo = 0,
    hi = lines.length - 1,
    found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].startMs <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Explicit ends preserve instrumental breaks and gaps in partial ASR results.
  return found >= 0 && positionMs < lines[found].endMs ? found : -1;
}
export function isCovered(doc: LyricsDocument, positionMs: number): boolean {
  return doc.coverage.some(
    (c) => positionMs >= c.startMs && positionMs < c.endMs,
  );
}
export function wordProgress(
  startMs: number,
  endMs: number,
  positionMs: number,
): number {
  return Math.max(
    0,
    Math.min(1, (positionMs - startMs) / Math.max(1, endMs - startMs)),
  );
}
export function formatTime(ms: number): string {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
