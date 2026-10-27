import { describe, it, expect } from "vitest";
import { positionAt, activeLineAt, isCovered, wordProgress } from "./sync";
import type { PlaybackSnapshot, LyricLine, LyricsDocument } from "./types";

const snapshot: PlaybackSnapshot = {
  track: {
    source: "soundcloud",
    id: "https://soundcloud.com/test/song",
    title: "Song",
    artist: "Artist",
    artwork: null,
    durationMs: 240000,
  },
  positionMs: 10000,
  playbackRate: 1,
  status: "playing",
  observedAtMs: 1000,
  epoch: "a",
  sequence: 1,
};
const lines: LyricLine[] = [
  { text: "A", startMs: 1000, endMs: 2000, words: [] },
  { text: "B", startMs: 3000, endMs: 4000, words: [] },
];
describe("player anchored synchronization", () => {
  it("interpolates and handles playback speed", () => {
    expect(positionAt(snapshot, 1250)).toBe(10250);
    expect(positionAt({ ...snapshot, playbackRate: 1.5 }, 1250)).toBe(10375);
  });
  it("freezes on pause, buffering, ads and stale connection", () => {
    for (const status of ["paused", "buffering", "ad"] as const)
      expect(positionAt({ ...snapshot, status }, 1600)).toBe(10000);
    expect(positionAt(snapshot, 4001)).toBe(12000);
  });
  it("uses a new seek anchor immediately and applies offset", () => {
    expect(
      positionAt(
        { ...snapshot, positionMs: 90000, observedAtMs: 1500 },
        1600,
        -200,
      ),
    ).toBe(89900);
  });
  it("does not accumulate drift over a full song", () => {
    for (let ms = 0; ms < 235000; ms += 137) {
      const anchor = Math.floor(ms / 500) * 500;
      expect(
        Math.abs(
          positionAt(
            { ...snapshot, positionMs: anchor, observedAtMs: anchor },
            ms,
          ) - ms,
        ),
      ).toBeLessThanOrEqual(1);
    }
  });
  it("does not highlight before vocals or across gaps", () => {
    expect(activeLineAt(lines, 900)).toBe(-1);
    expect(activeLineAt(lines, 1000)).toBe(0);
    expect(activeLineAt(lines, 2500)).toBe(-1);
    expect(activeLineAt(lines, 3500)).toBe(1);
    expect(activeLineAt(lines, 4000)).toBe(-1);
  });
  it("distinguishes partial capture from complete coverage", () => {
    const doc = {
      coverage: [{ startMs: 60000, endMs: 70000 }],
    } as LyricsDocument;
    expect(isCovered(doc, 0)).toBe(false);
    expect(isCovered(doc, 65000)).toBe(true);
  });
  it("clamps word progress", () => {
    expect(wordProgress(1000, 2000, 500)).toBe(0);
    expect(wordProgress(1000, 2000, 1500)).toBe(0.5);
    expect(wordProgress(1000, 2000, 2500)).toBe(1);
  });
});
