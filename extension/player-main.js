// No credentials cross this page-world bridge. Only standard media properties.
(() => {
  const seen = new WeakSet();
  let media = null;
  let buffering = false;
  let positionState = null;
  const register = (element) => {
    if (!(element instanceof HTMLMediaElement) || seen.has(element)) return;
    seen.add(element);
    for (const name of [
      "play",
      "playing",
      "pause",
      "waiting",
      "stalled",
      "seeking",
      "seeked",
      "ratechange",
      "ended",
      "loadedmetadata",
    ]) {
      element.addEventListener(name, () => {
        if (name === "play" || name === "playing") media = element;
        if (element !== media) return;
        if (["waiting", "stalled", "seeking"].includes(name)) buffering = true;
        if (["playing", "seeked", "pause", "ended"].includes(name))
          buffering = false;
        publish();
      });
    }
  };
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    register(this);
    media = this;
    return originalPlay.apply(this, args);
  };
  document.addEventListener(
    "play",
    (e) => {
      register(e.target);
      media = e.target;
    },
    true,
  );
  if (globalThis.MediaSession?.prototype?.setPositionState) {
    const original = MediaSession.prototype.setPositionState;
    MediaSession.prototype.setPositionState = function (state) {
      const result = original.call(this, state);
      positionState =
        state && Number.isFinite(state.position)
          ? { ...state, observed: performance.now() }
          : null;
      return result;
    };
  }
  function publish() {
    const metadata = navigator.mediaSession?.metadata;
    const real = media && Number.isFinite(media.duration) && media.duration > 0;
    const state = navigator.mediaSession?.playbackState;
    const fallback = positionState && Number.isFinite(positionState.duration);
    if (!real && !fallback) return;
    const status = real
      ? buffering
        ? "buffering"
        : media.ended
          ? "stopped"
          : media.paused
            ? "paused"
            : "playing"
      : state === "playing"
        ? "playing"
        : "paused";
    const rate = real ? media.playbackRate : positionState.playbackRate || 1;
    const position = real
      ? media.currentTime
      : positionState.position +
        (state === "playing"
          ? ((performance.now() - positionState.observed) / 1000) * rate
          : 0);
    window.postMessage(
      {
        channel: "still:media:v1",
        payload: {
          title: metadata?.title || "",
          artist: metadata?.artist || "",
          artwork: metadata?.artwork?.at(-1)?.src || null,
          positionMs: Math.max(0, position * 1000),
          durationMs: (real ? media.duration : positionState.duration) * 1000,
          playbackRate: rate,
          status,
          observedAtMs: Date.now(),
          precise: !!real,
        },
      },
      location.origin,
    );
  }
  setInterval(publish, 500);
})();
