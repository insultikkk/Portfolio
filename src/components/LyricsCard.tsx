import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  AudioLines,
  GripHorizontal,
  LockKeyhole,
  Music2,
  Radio,
  Sparkles,
} from "lucide-react";
import {
  activeLineAt,
  positionAt,
  wordProgress,
  isCovered,
} from "../core/sync";
import type { LyricLine, ViewState } from "../core/types";
import { native } from "../bridge";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useArtworkTint } from "./useArtworkTint";

function Line({
  line,
  active,
  position,
}: {
  line: LyricLine;
  active: boolean;
  position: number;
}) {
  if (!active || !line.words.length) return <>{line.text || "···"}</>;
  return (
    <>
      {line.words.map((word, i) => (
        <span
          className="lyric-word"
          key={i}
          style={
            {
              "--fill": `${wordProgress(word.startMs, word.endMs, position) * 100}%`,
            } as CSSProperties
          }
        >
          {word.text}
        </span>
      ))}
    </>
  );
}
export function LyricsCard({
  state,
  preview = false,
  demo = false,
}: {
  state: ViewState;
  preview?: boolean;
  demo?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const current = useRef<HTMLParagraphElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(timer);
  }, []);
  const playback = state.playback;
  const doc = state.lyrics;
  const position = playback
    ? positionAt(playback, now, state.settings.offsetMs)
    : 0;
  const active =
    doc && doc.sync !== "plain" ? activeLineAt(doc.lines, position) : -1;
  const delayed =
    !!doc?.approximate &&
    ["processing", "listening"].includes(state.ai.status) &&
    active < 0 &&
    doc.lines.length > 0 &&
    doc.lines[doc.lines.length - 1].endMs <= position &&
    position - doc.lines[doc.lines.length - 1].endMs < 60000;
  const displayActive = delayed ? (doc?.lines.length || 1) - 1 : active;
  useEffect(() => {
    if (!current.current || !list.current) return;
    const line = current.current;
    const viewport = list.current;
    const center = () =>
      viewport.scrollTo({
        top: line.offsetTop - viewport.clientHeight / 2 + line.clientHeight / 2,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    const resize = new ResizeObserver(center);
    resize.observe(viewport);
    resize.observe(line);
    center();
    return () => resize.disconnect();
  }, [displayActive, doc?.trackKey, state.settings.fontScale]);
  const artwork = playback?.track.artwork;
  const tint = useArtworkTint(artwork);
  const disconnected = native && !state.connected && !!playback;
  const status = disconnected ? "stopped" : playback?.status;
  const hint = ["processing", "listening"].includes(state.ai.status)
    ? "Слушаем вокал…"
    : state.lyricsStatus === "loading"
      ? "Ищем слова для вашей песни…"
      : state.lyricsStatus === "offline"
        ? "Источник текстов недоступен"
        : state.lyricsStatus === "ambiguous"
          ? "Выберите запись в настройках"
          : state.lyricsStatus === "instrumental"
            ? "Здесь музыка говорит сама"
            : state.lyricsStatus === "missing"
              ? "Включите локальное распознавание"
              : "Включите песню в SoundCloud";
  return (
    <section
      className={`lyrics-card ${preview ? "is-preview" : ""} ${!state.settings.locked ? "is-editing" : ""}`}
      aria-label="Плавающий текст песни"
      style={
        {
          "--card-opacity": state.settings.opacity,
          "--font-scale": state.settings.fontScale,
          "--tint": tint,
        } as CSSProperties
      }
    >
      <div className="card-aura" />
      {!state.settings.locked && (
        <button
          className="drag-handle"
          title="Переместить окно"
          aria-label="Переместить окно"
          onPointerDown={() => {
            if (native && !preview) getCurrentWindow().startDragging();
          }}
        >
          <GripHorizontal size={16} />
        </button>
      )}
      <header className="lyric-track">
        <div className={`mini-cover ${artwork ? "" : "art-fallback"}`}>
          {artwork ? (
            <img src={artwork} alt="Обложка" />
          ) : (
            <span>
              st<span>ill.</span>
            </span>
          )}
        </div>
        <div className="lyric-track-info">
          <strong>{playback?.track.title || "Ваша музыка — рядом"}</strong>
          <span>
            {playback?.track.artist ||
              (playback ? "SoundCloud" : "Ждём подключение")}
          </span>
        </div>
        <div
          className={`equalizer ${status === "playing" ? "playing" : ""}`}
          aria-label={status === "playing" ? "Играет" : "Пауза"}
        >
          <i />
          <i />
          <i />
          <i />
        </div>
      </header>
      {status === "ad" ? (
        <div className="lyrics-empty">
          <Radio size={25} />
          <p>Скоро вернёмся к музыке</p>
          <span>Реклама · распознавание приостановлено</span>
        </div>
      ) : doc?.sync === "plain" ? (
        <div className="plain-lyrics">
          <p>{doc.plain}</p>
        </div>
      ) : doc?.lines.length ? (
        <div className="lyrics-viewport" ref={list}>
          <div className="lyric-spacer" />
          {doc.lines.map((line, i) => (
            <p
              ref={i === displayActive ? current : undefined}
              key={`${i}:${line.startMs}`}
              className={`lyric-line ${i === displayActive ? "active" : ""} ${i < displayActive ? "past" : ""}`}
            >
              <Line
                line={line}
                active={i === displayActive}
                position={position}
              />
            </p>
          ))}
          <div className="lyric-spacer" />
        </div>
      ) : (
        <div className="lyrics-empty">
          <Music2 size={27} />
          <p>{hint}</p>
          <span>
            {playback
              ? playback.track.title
              : "Откройте настройки через значок в трее"}
          </span>
        </div>
      )}
      <footer className="lyric-footer">
        <span>
          {doc?.approximate ? <Sparkles size={10} /> : <AudioLines size={10} />}
          {disconnected
            ? "Браузер отключён"
            : demo
              ? "Пример синхронизации"
              : doc?.approximate
                ? delayed
                  ? "ИИ · первый показ с задержкой"
                  : "ИИ · приблизительный текст"
                : doc?.sync === "plain"
                  ? "Текст без таймингов"
                  : doc?.sync === "instrumental"
                    ? "Инструментальная запись"
                    : doc
                      ? "Синхронизировано"
                      : "Live lyrics"}
        </span>
        {doc?.approximate && !isCovered(doc, position) && !delayed ? (
          <span>Участок не записан</span>
        ) : (
          <span className="card-mark">
            {state.settings.locked ? <LockKeyhole size={10} /> : "EDIT"}
          </span>
        )}
      </footer>
    </section>
  );
}
