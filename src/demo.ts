import type { PlaybackSnapshot, LyricsDocument } from "./core/types";
const started = Date.now();
// Original demo lyrics, never confused with a connected player or published song.
const text = [
  "За окном просыпается город",
  "И меняет ночные цвета",
  "Я оставлю все лишние споры",
  "Пусть останется эта волна",
  "Мы поймаем мгновение света",
  "Между строчек обычного дня",
  "Пусть играет любимое лето",
  "Пока мир не торопит меня",
  "Тихий свет остаётся с нами",
  "И работа идёт в своём ритме",
];
export const demoKey = "soundcloud:https://soundcloud.com/still/demo:154000";
export function demoPlayback(): PlaybackSnapshot {
  return {
    track: {
      source: "soundcloud",
      id: "https://soundcloud.com/still/demo",
      title: "Тихий свет",
      artist: "Still Sessions",
      durationMs: 154000,
      artwork: null,
    },
    positionMs: 24000 + ((Date.now() - started) % 46000),
    playbackRate: 1,
    status: "playing",
    observedAtMs: Date.now(),
    sequence: Math.floor((Date.now() - started) / 500),
    epoch: "demo",
  };
}
export function demoDocument(): LyricsDocument {
  return {
    trackKey: demoKey,
    source: "lrclib",
    sync: "word",
    approximate: false,
    plain: text.join("\n"),
    coverage: [{ startMs: 0, endMs: 154000 }],
    lines: text.map((text, i) => {
      const startMs = i * 8000;
      const parts = text.split(" ");
      return {
        text,
        startMs,
        endMs: startMs + 8000,
        words: parts.map((word, j) => ({
          text: word + (j === parts.length - 1 ? "" : " "),
          startMs: startMs + (j * 8000) / parts.length,
          endMs: startMs + ((j + 1) * 8000) / parts.length,
        })),
      };
    }),
  };
}
