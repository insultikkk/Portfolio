(() => {
  let sequence = 0;
  let epoch = crypto.randomUUID();
  let previous = null;
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== "still:media:v1"
    )
      return;
    const p = event.data.payload;
    if (
      !p ||
      !Number.isFinite(p.positionMs) ||
      !Number.isFinite(p.durationMs) ||
      p.durationMs <= 0 ||
      !Number.isFinite(p.playbackRate) ||
      !Number.isFinite(p.observedAtMs) ||
      Math.abs(Date.now() - p.observedAtMs) > 10000
    )
      return;
    const link = document.querySelector(".playbackSoundBadge__titleLink");
    if (!link) return;
    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (
      url.origin !== "https://soundcloud.com" ||
      url.pathname.split("/").filter(Boolean).length !== 2
    )
      return;
    url.search = "";
    url.hash = "";
    const uploader =
      document
        .querySelector(".playbackSoundBadge__lightLink")
        ?.textContent?.trim() || "";
    let title =
      link.getAttribute("title")?.trim() ||
      link.textContent?.trim() ||
      p.title ||
      "";
    let artist =
      typeof p.artist === "string" && p.artist !== uploader ? p.artist : "";
    const split = title.match(/^(.{1,160}?)\s+[–—-]\s+(.{1,300})$/u);
    if (split) {
      artist = split[1].trim();
      title = split[2].trim();
    }
    title = title.slice(0, 500);
    artist = artist.slice(0, 500);
    if (!title) return;
    let artwork = p.artwork;
    if (!artwork) {
      const style = document.querySelector(
        ".playbackSoundBadge__avatar .image__full",
      )?.style.backgroundImage;
      artwork = style?.match(/url\(["']?(.*?)["']?\)/)?.[1] || null;
    }
    try {
      const image = new URL(artwork);
      if (
        image.protocol !== "https:" ||
        !image.hostname.endsWith(".sndcdn.com")
      )
        artwork = null;
    } catch {
      artwork = null;
    }
    const durationText = document
      .querySelector('.playbackTimeline__duration span[aria-hidden="true"]')
      ?.textContent?.trim();
    const timeParts = durationText?.split(":").map(Number);
    const expectedDuration =
      timeParts?.length >= 2 && timeParts.every(Number.isFinite)
        ? timeParts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000
        : 0;
    const isAd =
      !!document.querySelector(
        '.playControls .playbackSoundBadge--ad, .playControls [data-testid="ad-player"], .playControls .playbackSoundBadge__ad',
      ) ||
      /^(advertisement|advert|реклама)$/i.test(title) ||
      (expectedDuration > 0 &&
        Math.abs(expectedDuration - p.durationMs) > 3000);
    // SoundCloud's controls can pause or seek before the underlying media
    // element reflects the new state. Keep its precise clock when they agree.
    const playControl = document.querySelector("button.playControls__play");
    const pausedByPlayer =
      p.status === "playing" &&
      playControl &&
      !playControl.classList.contains("playing");
    const elapsed = document
      .querySelector(".playbackTimeline__progressWrapper")
      ?.getAttribute("aria-valuenow");
    const timelineMs = elapsed ? Number(elapsed) * 1000 : NaN;
    const positionMs =
      !isAd &&
      Number.isFinite(timelineMs) &&
      (pausedByPlayer || Math.abs(timelineMs - p.positionMs) > 1500)
        ? timelineMs
        : p.positionMs;
    const status = isAd
      ? "ad"
      : !pausedByPlayer && ["playing", "buffering", "stopped"].includes(p.status)
        ? p.status
        : "paused";
    const track = {
      source: "soundcloud",
      id: url.href.replace(/\/$/, ""),
      title,
      artist,
      artwork,
      durationMs: Math.round(
        isAd && expectedDuration > 0 ? expectedDuration : p.durationMs,
      ),
    };
    const key = `${track.id}:${track.durationMs}`;
    const now = p.observedAtMs;
    const predicted = previous
      ? previous.positionMs +
        (previous.status === "playing"
          ? (now - previous.observedAtMs) * previous.playbackRate
          : 0)
      : positionMs;
    if (
      !previous ||
      previous.key !== key ||
      previous.status !== status ||
      previous.playbackRate !== p.playbackRate ||
      Math.abs(predicted - positionMs) > 1500
    )
      epoch = crypto.randomUUID();
    const snapshot = {
      track,
      positionMs: Math.min(track.durationMs, Math.max(0, positionMs)),
      playbackRate: p.playbackRate,
      status,
      observedAtMs: now,
      sequence: ++sequence,
      epoch,
    };
    previous = { ...snapshot, key };
    chrome.runtime
      .sendMessage({ type: "media-snapshot", snapshot })
      .catch(() => {});
  });
})();
