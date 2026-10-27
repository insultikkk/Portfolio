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
    const status = isAd
      ? "ad"
      : ["playing", "paused", "buffering", "stopped"].includes(p.status)
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
      : p.positionMs;
    if (
      !previous ||
      previous.key !== key ||
      previous.status !== status ||
      previous.playbackRate !== p.playbackRate ||
      Math.abs(predicted - p.positionMs) > 1500
    )
      epoch = crypto.randomUUID();
    const snapshot = {
      track,
      positionMs: Math.min(track.durationMs, Math.max(0, p.positionMs)),
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
