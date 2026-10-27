export type PlaybackStatus =
  "playing" | "paused" | "buffering" | "stopped" | "ad";
export interface Track {
  source: "soundcloud";
  id: string;
  title: string;
  artist: string;
  artwork: string | null;
  durationMs: number;
}
export interface PlaybackSnapshot {
  track: Track;
  positionMs: number;
  playbackRate: number;
  status: PlaybackStatus;
  observedAtMs: number;
  sequence: number;
  epoch: string;
}
export interface Word {
  text: string;
  startMs: number;
  endMs: number;
}
export interface LyricLine {
  text: string;
  startMs: number;
  endMs: number;
  words: Word[];
}
export interface Coverage {
  startMs: number;
  endMs: number;
}
export interface LyricsDocument {
  trackKey: string;
  source: "lrclib" | "whisper";
  sync: "plain" | "line" | "word" | "instrumental";
  lines: LyricLine[];
  plain: string;
  coverage: Coverage[];
  approximate: boolean;
}
export interface Candidate {
  id: number;
  title: string;
  artist: string;
  durationMs: number;
  synced: boolean;
  compatible: boolean;
}
export interface Settings {
  opacity: number;
  fontScale: number;
  offsetMs: number;
  locked: boolean;
  visible: boolean;
  width: number;
  height: number;
  x: number | null;
  y: number | null;
}
export interface ViewState {
  playback: PlaybackSnapshot | null;
  lyrics: LyricsDocument | null;
  candidates: Candidate[];
  lyricsStatus:
    | "idle"
    | "loading"
    | "ready"
    | "ambiguous"
    | "missing"
    | "offline"
    | "instrumental";
  connected: boolean;
  settings: Settings;
  ai: {
    status:
      | "unavailable"
      | "needsModel"
      | "downloading"
      | "ready"
      | "listening"
      | "processing"
      | "error";
    progress: number;
    message: string;
    lagMs: number;
  };
  error: string | null;
}
export const defaultSettings: Settings = {
  opacity: 0.88,
  fontScale: 1,
  offsetMs: 0,
  locked: true,
  visible: true,
  width: 340,
  height: 300,
  x: null,
  y: null,
};
export const initialState: ViewState = {
  playback: null,
  lyrics: null,
  candidates: [],
  lyricsStatus: "idle",
  connected: false,
  settings: defaultSettings,
  ai: { status: "needsModel", progress: 0, message: "", lagMs: 0 },
  error: null,
};
