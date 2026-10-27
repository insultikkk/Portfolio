import assert from "node:assert/strict";

export async function installFixture(context) {
  const audio = Buffer.alloc(44 + 16000 * 12 * 2);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  for (let i = 0; i < 16000 * 12; i++)
    audio.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * 3000),
      44 + i * 2,
    );
  await context.route("https://soundcloud.com/**", async (route) => {
    if (route.request().url().endsWith(".wav"))
      return route.fulfill({ contentType: "audio/wav", body: audio });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body><a class="playbackSoundBadge__titleLink" title="Artist - Song" href="https://soundcloud.com/artist/song">Artist - Song</a><a class="playbackSoundBadge__lightLink">UploadAccount</a><audio id="audio" src="https://soundcloud.com/fixture.wav"></audio><button onclick="document.getElementById('audio').play()">Play fixture</button><script>navigator.mediaSession.metadata=new MediaMetadata({title:'Artist - Song',artist:'UploadAccount'});</script></body></html>`,
    });
  });
}
export async function exerciseMedia(page, read) {
  async function until(predicate, label) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (predicate(await read())) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out: ${label}`);
  }
  await page.goto("https://soundcloud.com/artist/song");
  await page.getByRole("button", { name: "Play fixture" }).click();
  await until(
    (seen) => seen.some((s) => s.status === "playing"),
    "live playing snapshot",
  );
  const first = (await read()).find((s) => s.status === "playing");
  assert.equal(first.track.title, "Song");
  assert.equal(first.track.artist, "Artist");
  assert.equal(first.track.id, "https://soundcloud.com/artist/song");
  assert.equal(first.track.durationMs, 12000);
  await page.evaluate(() => document.getElementById("audio").pause());
  await until((seen) => seen.at(-1)?.status === "paused", "pause snapshot");
  const paused = (await read()).at(-1);
  await page.evaluate(() => {
    const audio = document.getElementById("audio");
    audio.currentTime = 6;
    return audio.play();
  });
  await until(
    (seen) =>
      seen.at(-1)?.status === "playing" && seen.at(-1)?.positionMs >= 6000,
    "seek snapshot",
  );
  const sought = (await read()).at(-1);
  assert.notEqual(sought.epoch, paused.epoch);
  assert.ok(paused.positionMs < 6000);
  const actual = await page.evaluate(() => ({
    position: document.getElementById("audio").currentTime * 1000,
    now: Date.now(),
  }));
  const estimate =
    sought.positionMs +
    (actual.now - sought.observedAtMs) * sought.playbackRate;
  assert.ok(
    Math.abs(estimate - actual.position) <= 300,
    `Media clock error ${Math.abs(estimate - actual.position)}ms`,
  );
  await page.evaluate(() => {
    const a = document.querySelector(".playbackSoundBadge__titleLink");
    a.title = "Unknown song";
    a.href = "https://soundcloud.com/uploader/unknown";
    a.textContent = "Unknown song";
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Unknown song",
      artist: "UploadAccount",
    });
  });
  await until(
    (seen) => seen.at(-1)?.track.title === "Unknown song",
    "SPA track change",
  );
  assert.equal((await read()).at(-1).track.artist, "");
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.className = "playbackTimeline__duration";
    marker.innerHTML = '<span aria-hidden="true">03:00</span>';
    document.body.append(marker);
  });
  await until(
    (seen) => seen.at(-1)?.status === "ad",
    "interstitial audio detection",
  );
  assert.equal((await read()).at(-1).track.durationMs, 180000);
}
