import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initialState, type ViewState, type Settings } from "./core/types";
import { demoDocument, demoPlayback } from "./demo";

export const native = isTauri();
let preview: ViewState = {
  ...initialState,
  playback: demoPlayback(),
  lyrics: demoDocument(),
  lyricsStatus: "ready",
};
const watchers = new Set<(state: ViewState) => void>();
export async function subscribe(
  callback: (state: ViewState) => void,
): Promise<() => void> {
  if (native) {
    const unlisten = await listen<ViewState>("state", (event) =>
      callback(event.payload),
    );
    try {
      callback(await invoke<ViewState>("get_state"));
    } catch (e) {
      unlisten();
      throw e;
    }
    return unlisten;
  }
  callback(preview);
  watchers.add(callback);
  const timer = window.setInterval(() => {
    preview = { ...preview, playback: demoPlayback() };
    watchers.forEach((w) => w(preview));
  }, 500);
  return () => {
    clearInterval(timer);
    watchers.delete(callback);
  };
}
export async function saveSettings(settings: Settings) {
  if (native) return invoke("save_settings", { settings });
  preview = { ...preview, settings };
  watchers.forEach((w) => w(preview));
}
export async function command<T = void>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!native)
    throw new Error(
      "Эта функция доступна в Windows-приложении. Здесь показана демонстрация интерфейса.",
    );
  return invoke<T>(name, args);
}
export async function openLink(url: string) {
  if (native) return invoke("open_external", { url });
  window.open(url, "_blank", "noopener,noreferrer");
}
