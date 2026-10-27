const $ = (id) => document.getElementById(id);
async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  $("status").textContent = status.ready
    ? "Приложение подключено. Включите песню в SoundCloud."
    : "Откройте Still и вставьте токен из раздела «Подключение».";
  $("dot").classList.toggle("online", status.ready);
  $("track").textContent = status.track
    ? `${status.track.artist ? status.track.artist + " — " : ""}${status.track.title}`
    : "";
  $("capture").textContent = status.recording
    ? "Остановить распознавание"
    : "Распознавать эту вкладку";
  $("capture").dataset.recording = status.recording ? "true" : "false";
  if (status.error) $("error").textContent = status.error;
}
async function action(button, message) {
  button.disabled = true;
  $("error").textContent = "";
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (result?.error) throw new Error(result.error);
    await refresh();
  } catch (e) {
    $("error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
$("connect").onclick = () =>
  action($("connect"), { type: "configure", token: $("token").value.trim() });
$("capture").onclick = () =>
  action($("capture"), {
    type:
      $("capture").dataset.recording === "true"
        ? "capture-stop"
        : "capture-start",
  });
refresh();
setInterval(refresh, 1500);
