use crate::{
    ai::{self, AudioChunk},
    model::*,
    provider::{auto_match, ApiTrack, Lrclib, LyricsProvider},
    store::Store,
};
use anyhow::Result;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{broadcast, mpsc};
type StateListener = Box<dyn Fn(ViewState) + Send + Sync>;

#[derive(Clone, serde::Serialize)]
pub struct ControlMessage {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "captureId", skip_serializing_if = "Option::is_none")]
    capture_id: Option<String>,
}
pub struct AudioJob {
    chunk: AudioChunk,
    track: Track,
    generation: u64,
}

pub struct Engine {
    pub view: Mutex<ViewState>,
    pub store: Mutex<Store>,
    pub data_dir: PathBuf,
    pub resources: PathBuf,
    provider: Lrclib,
    candidates: Mutex<Vec<ApiTrack>>,
    pub controls: broadcast::Sender<ControlMessage>,
    pub client_generation: AtomicU64,
    lookup_generation: AtomicU64,
    audio_tx: mpsc::Sender<AudioJob>,
    audio_enabled: AtomicBool,
    capture_generation: AtomicU64,
    audio_session: Mutex<Option<String>>,
    installing: AtomicBool,
    audio_cancel: tokio::sync::Notify,
    audio_activity: tokio::sync::Notify,
    processing_end: Mutex<Option<(String, String, f64)>>,
    notify: Mutex<Option<StateListener>>,
}
impl Engine {
    pub fn new(
        data_dir: PathBuf,
        resources: PathBuf,
    ) -> Result<(Arc<Self>, mpsc::Receiver<AudioJob>)> {
        std::fs::create_dir_all(&data_dir)?;
        let store = Store::open(&data_dir.join("still.sqlite"))?;
        store.token()?;
        let settings = store.get::<Settings>("settings")?.unwrap_or_default();
        settings.validate()?;
        let mut view = ViewState {
            settings,
            ..Default::default()
        };
        if ai::model_present(&data_dir) {
            view.ai.status = "ready".into();
        }
        if !ai::binary_path(&resources, "lyrics-whisper").is_file() {
            view.ai.status = "unavailable".into();
            view.ai.message =
                "Для ИИ нужны локальные вспомогательные программы. См. README.".into();
        }
        let (audio_tx, rx) = mpsc::channel(3);
        let (controls, _) = broadcast::channel(16);
        Ok((
            Arc::new(Self {
                view: Mutex::new(view),
                store: Mutex::new(store),
                data_dir,
                resources,
                provider: Lrclib::new()?,
                candidates: Mutex::new(vec![]),
                controls,
                client_generation: AtomicU64::new(0),
                lookup_generation: AtomicU64::new(0),
                audio_tx,
                audio_enabled: AtomicBool::new(false),
                capture_generation: AtomicU64::new(0),
                audio_session: Mutex::new(None),
                installing: AtomicBool::new(false),
                audio_cancel: tokio::sync::Notify::new(),
                audio_activity: tokio::sync::Notify::new(),
                processing_end: Mutex::new(None),
                notify: Mutex::new(None),
            }),
            rx,
        ))
    }
    pub fn on_change(&self, callback: impl Fn(ViewState) + Send + Sync + 'static) {
        *self.notify.lock().unwrap() = Some(Box::new(callback));
    }
    pub fn state(&self) -> ViewState {
        self.view.lock().unwrap().clone()
    }
    pub fn emit(&self) {
        let v = self.state();
        if let Some(cb) = &*self.notify.lock().unwrap() {
            cb(v);
        }
    }
    pub fn error(&self, msg: impl ToString) {
        self.view.lock().unwrap().error = Some(msg.to_string());
        self.emit();
    }
    pub fn set_connected(&self, connected: bool) {
        self.view.lock().unwrap().connected = connected;
        if !connected {
            self.stop_capture();
        }
        self.emit();
    }
    pub fn save_settings(&self, settings: Settings) -> Result<()> {
        settings.validate()?;
        self.store.lock().unwrap().set("settings", &settings)?;
        self.view.lock().unwrap().settings = settings;
        self.emit();
        Ok(())
    }
    pub fn token(&self) -> Result<String> {
        self.store.lock().unwrap().token()
    }
    pub fn rotate_token(&self) -> Result<String> {
        let token = self.store.lock().unwrap().rotate_token()?;
        self.client_generation.fetch_add(1, Ordering::SeqCst);
        self.set_connected(false);
        Ok(token)
    }
    pub fn bind_origin(&self, origin: &str) -> Result<()> {
        let s = self.store.lock().unwrap();
        let mut origins = s
            .get::<Vec<String>>("extension_origins")?
            .unwrap_or_default();
        if !origins.iter().any(|o| o == origin) {
            anyhow::ensure!(
                origins.len() < 4,
                "Сначала сбросьте подключение в настройках"
            );
            origins.push(origin.into());
            s.set("extension_origins", &origins)?;
        }
        Ok(())
    }
    pub fn origin_allowed(&self, origin: &str) -> bool {
        self.store
            .lock()
            .unwrap()
            .get::<Vec<String>>("extension_origins")
            .ok()
            .flatten()
            .is_none_or(|o| o.is_empty() || o.iter().any(|s| s == origin))
    }
    pub fn receive(self: &Arc<Self>, snapshot: PlaybackSnapshot) -> Result<()> {
        snapshot.validate()?;
        let processing = self.processing_end.lock().unwrap().clone();
        let changed;
        let epoch_changed;
        {
            let mut view = self.view.lock().unwrap();
            if let Some(old) = &view.playback {
                if old.epoch == snapshot.epoch && old.sequence >= snapshot.sequence {
                    return Ok(());
                }
            }
            changed = view
                .playback
                .as_ref()
                .is_none_or(|p| p.track.key() != snapshot.track.key());
            epoch_changed = view
                .playback
                .as_ref()
                .is_some_and(|p| p.epoch != snapshot.epoch);
            view.playback = Some(snapshot.clone());
            view.connected = true;
            if self.audio_enabled.load(Ordering::SeqCst) {
                if epoch_changed {
                    view.ai.status = "listening".into();
                    view.ai.lag_ms = 0.0;
                    view.ai.message = if snapshot.status == "playing" {
                        "Слушаем новый участок песни"
                    } else {
                        "Ожидаем продолжения воспроизведения"
                    }
                    .into();
                } else if let Some((key, epoch, end)) = &processing {
                    if *key == snapshot.track.key() && *epoch == snapshot.epoch {
                        view.ai.lag_ms = (snapshot.position_ms - end).max(0.0);
                    }
                }
            }
            if changed {
                view.lyrics = None;
                view.candidates.clear();
                view.lyrics_status = "loading".into();
                view.error = None;
            }
        }
        // Already accepted audio belongs to its recorded timeline, not to the
        // current playhead. Pauses/seeks must not discard the final fragment.
        self.audio_activity.notify_one();
        if changed {
            self.candidates.lock().unwrap().clear();
        }
        self.emit();
        if changed {
            self.lookup(snapshot.track);
        }
        Ok(())
    }
    pub fn clear_player(&self) {
        {
            let mut view = self.view.lock().unwrap();
            self.lookup_generation.fetch_add(1, Ordering::SeqCst);
            view.playback = None;
            view.lyrics = None;
            view.candidates.clear();
            view.lyrics_status = "idle".into();
            view.error = None;
        }
        self.candidates.lock().unwrap().clear();
        self.stop_capture_from_client(None);
    }
    fn lookup_is_current(&self, view: &ViewState, track: &Track, generation: u64) -> bool {
        self.lookup_generation.load(Ordering::SeqCst) == generation
            && view
                .playback
                .as_ref()
                .is_some_and(|p| p.track.key() == track.key())
    }
    pub fn lookup(self: &Arc<Self>, track: Track) {
        let generation = self.lookup_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = self.clone();
        tokio::spawn(async move {
            let cache = this.store.lock().unwrap().lyrics(&track.key());
            match cache {
                Ok(Some(doc)) => {
                    let mut view = this.view.lock().unwrap();
                    if this.lookup_is_current(&view, &track, generation) {
                        view.lyrics_status = if doc.sync == "instrumental" {
                            "instrumental"
                        } else {
                            "ready"
                        }
                        .into();
                        view.lyrics = Some(doc);
                        drop(view);
                        this.emit();
                    }
                    return;
                }
                Err(e) => this.error(format!("Не удалось прочитать кэш: {e}")),
                _ => {}
            }
            let result = this.provider.search(&track).await;
            if this.lookup_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            match result {
                Ok(rows) => {
                    let chosen = auto_match(&track, &rows).map(|r| r.document(&track));
                    *this.candidates.lock().unwrap() = rows.clone();
                    if let Some(doc) = chosen {
                        this.publish_document(doc);
                    } else {
                        let mut view = this.view.lock().unwrap();
                        if !this.lookup_is_current(&view, &track, generation) {
                            return;
                        }
                        view.candidates = rows.iter().map(|r| r.candidate(&track)).collect();
                        view.lyrics_status = if rows.is_empty() {
                            "missing"
                        } else {
                            "ambiguous"
                        }
                        .into();
                        drop(view);
                        this.emit();
                    }
                }
                Err(_) => {
                    let mut view = this.view.lock().unwrap();
                    if !this.lookup_is_current(&view, &track, generation) {
                        return;
                    }
                    view.lyrics_status = "offline".into();
                    drop(view);
                    this.emit();
                }
            }
        });
    }
    pub fn retry(self: &Arc<Self>) {
        let t = self.state().playback.map(|p| p.track);
        if let Some(t) = t {
            self.view.lock().unwrap().lyrics_status = "loading".into();
            self.emit();
            self.lookup(t);
        }
    }
    pub fn choose(&self, id: u64, track_key: &str) -> Result<()> {
        let t = self.state().playback.context("Нет активного трека")?.track;
        anyhow::ensure!(
            t.key() == track_key,
            "Песня уже сменилась. Выберите запись ещё раз."
        );
        let doc = self
            .candidates
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.id == id)
            .context("Результат устарел")?
            .document(&t);
        self.publish_document(doc);
        Ok(())
    }
    pub fn publish_document(&self, doc: LyricsDocument) {
        // A completed chunk from the previous song still belongs in its cache.
        if let Err(err) = self.store.lock().unwrap().save_lyrics(&doc) {
            self.error(format!("Не удалось сохранить текст: {err}"));
        }
        let authoritative =
            doc.source == "lrclib" && matches!(doc.sync.as_str(), "line" | "word" | "instrumental");
        let mut view = self.view.lock().unwrap();
        if view
            .playback
            .as_ref()
            .is_none_or(|p| p.track.key() != doc.track_key)
        {
            return;
        }
        view.lyrics_status = if doc.sync == "instrumental" {
            "instrumental"
        } else {
            "ready"
        }
        .into();
        view.lyrics = Some(doc);
        view.candidates.clear();
        if authoritative && self.audio_enabled.load(Ordering::SeqCst) {
            view.ai.status = "listening".into();
            view.ai.lag_ms = 0.0;
            view.ai.message = "Для этой записи есть готовый текст · ИИ в ожидании".into();
        }
        drop(view);
        if authoritative {
            self.audio_activity.notify_one();
        }
        self.emit();
    }
    pub fn capture_start(&self, capture_id: Option<String>) -> Result<()> {
        anyhow::ensure!(
            capture_id
                .as_ref()
                .is_none_or(|id| !id.is_empty() && id.len() <= 100),
            "Неверный идентификатор захвата"
        );
        anyhow::ensure!(
            ai::binary_path(&self.resources, "lyrics-whisper").is_file(),
            "Сначала соберите локальный Whisper worker по инструкции README"
        );
        anyhow::ensure!(
            ai::model_present(&self.data_dir),
            "Сначала загрузите модель в приложении Still"
        );
        anyhow::ensure!(self.state().playback.is_some(), "Сначала включите трек");
        let mut session = self.audio_session.lock().unwrap();
        anyhow::ensure!(
            !self.audio_enabled.load(Ordering::SeqCst),
            "Захват уже запущен"
        );
        *session = capture_id;
        self.capture_generation.fetch_add(1, Ordering::SeqCst);
        self.audio_enabled.store(true, Ordering::SeqCst);
        drop(session);
        let mut v = self.view.lock().unwrap();
        v.ai.status = "listening".into();
        v.ai.message = "Слушаем только вкладку SoundCloud".into();
        drop(v);
        self.emit();
        Ok(())
    }
    pub fn stop_capture(&self) {
        self.stop_capture_inner(true, None);
    }
    pub fn stop_capture_from_client(&self, capture_id: Option<&str>) {
        self.stop_capture_inner(false, capture_id);
    }
    fn stop_capture_inner(&self, notify_client: bool, capture_id: Option<&str>) {
        let mut session = self.audio_session.lock().unwrap();
        if capture_id.is_some() && session.as_deref() != capture_id {
            return;
        }
        let old_id = session.take();
        self.capture_generation.fetch_add(1, Ordering::SeqCst);
        self.audio_enabled.store(false, Ordering::SeqCst);
        self.audio_cancel.notify_one();
        *self.processing_end.lock().unwrap() = None;
        if notify_client {
            let _ = self.controls.send(ControlMessage {
                kind: "stop-capture".into(),
                capture_id: old_id,
            });
        }
        drop(session);
        let mut v = self.view.lock().unwrap();
        if ["listening", "processing"].contains(&v.ai.status.as_str()) {
            v.ai.status = "ready".into();
            v.ai.message.clear();
        }
        drop(v);
        self.emit();
    }
    pub fn queue_audio(&self, chunk: AudioChunk) -> Result<()> {
        chunk.validate()?;
        let _session = self.audio_session.lock().unwrap();
        anyhow::ensure!(
            self.audio_enabled.load(Ordering::SeqCst),
            "Распознавание выключено"
        );
        let p = self.state().playback.context("Нет активного трека")?;
        anyhow::ensure!(
            p.track.key() == chunk.header.track_key
                && p.epoch == chunk.header.epoch
                && p.status == "playing",
            "Устаревший аудиофрагмент"
        );
        anyhow::ensure!(
            (p.playback_rate - chunk.header.playback_rate).abs() < 0.001
                && chunk.end_ms() <= p.track.duration_ms + 1000.0
                && chunk.end_ms() <= p.position_ms + 3000.0,
            "Неверная позиция аудио"
        );
        if !ai::needs_transcription(self.state().lyrics.as_ref(), &chunk) {
            return Ok(());
        }
        let job = AudioJob {
            chunk,
            track: p.track,
            generation: self.capture_generation.load(Ordering::SeqCst),
        };
        if self.audio_tx.try_send(job).is_err() {
            let mut v = self.view.lock().unwrap();
            v.ai.message =
                "Компьютер не успевает. Пропускаем фрагмент, чтобы не накапливать задержку.".into();
            v.ai.lag_ms = 30000.0;
            drop(v);
            self.emit();
            anyhow::bail!("Очередь распознавания заполнена");
        }
        Ok(())
    }
    pub fn download_model(self: &Arc<Self>) -> Result<()> {
        anyhow::ensure!(
            !self.installing.swap(true, Ordering::SeqCst),
            "Модель уже загружается"
        );
        let this = self.clone();
        self.view.lock().unwrap().ai.status = "downloading".into();
        self.emit();
        tokio::spawn(async move {
            let result = ai::install_model(&this.data_dir, &this.resources, |progress, message| {
                let mut v = this.view.lock().unwrap();
                v.ai.progress = progress;
                v.ai.message = message.into();
                drop(v);
                this.emit();
            })
            .await;
            let mut v = this.view.lock().unwrap();
            match result {
                Ok(()) => {
                    v.ai.status = "ready".into();
                    v.ai.message = "Модель готова. Включите распознавание в расширении.".into();
                }
                Err(err) => {
                    v.ai.status = "error".into();
                    v.ai.message = format!("Не удалось подготовить модель: {err}");
                }
            }
            drop(v);
            this.installing.store(false, Ordering::SeqCst);
            this.emit();
        });
        Ok(())
    }
    fn job_is_current(&self, job: &AudioJob) -> bool {
        self.audio_enabled.load(Ordering::SeqCst)
            && self.capture_generation.load(Ordering::SeqCst) == job.generation
    }
    fn finish_audio_job(&self, job: &AudioJob, lines: Vec<LyricLine>) -> Result<bool> {
        // Serialize committing a result against explicit Stop/new capture.
        let session = self.audio_session.lock().unwrap();
        if !self.job_is_current(job) {
            return Ok(false);
        }
        let old = self
            .store
            .lock()
            .unwrap()
            .lyrics(&job.chunk.header.track_key)?;
        if !ai::needs_transcription(old.as_ref(), &job.chunk) {
            return Ok(false);
        }
        let doc = ai::merge_chunk(old, &job.chunk, lines, job.track.duration_ms);
        self.publish_document(doc);
        let mut view = self.view.lock().unwrap();
        if let Some(p) = &view.playback {
            if p.track.key() == job.track.key() && p.epoch == job.chunk.header.epoch {
                let lag = (p.position_ms - job.chunk.end_ms()).max(0.0);
                view.ai.lag_ms = lag;
                view.ai.message = "ИИ-текст приблизительный · первый показ с задержкой".into();
            }
        }
        view.ai.status = "listening".into();
        drop(view);
        drop(session);
        self.emit();
        Ok(true)
    }
    pub async fn audio_loop(self: Arc<Self>, mut rx: mpsc::Receiver<AudioJob>) {
        let mut worker: Option<ai::Worker> = None;
        loop {
            let job = tokio::select! {
                biased;
                _=self.audio_cancel.notified()=>{
                    if let Some(w)=worker.as_mut(){w.stop().await;}
                    worker=None;
                    *self.processing_end.lock().unwrap()=None;
                    continue;
                },
                job=rx.recv()=>{let Some(job)=job else{break};job},
                _=self.audio_activity.notified()=>{
                    let state = self.state();
                    let idle = state.playback.as_ref().is_none_or(|p| p.status != "playing")
                        || state.lyrics.as_ref().is_some_and(|d| d.source == "lrclib" && d.sync != "plain");
                    if rx.is_empty() && idle {
                        if let Some(w) = worker.as_mut() { w.stop().await; }
                        worker = None;
                    }
                    continue;
                },
            };
            if !self.job_is_current(&job) {
                continue;
            }
            let chunk = &job.chunk;
            let cached = self
                .store
                .lock()
                .unwrap()
                .lyrics(&chunk.header.track_key)
                .ok()
                .flatten();
            if !ai::needs_transcription(cached.as_ref(), chunk) {
                continue;
            }
            *self.processing_end.lock().unwrap() = Some((
                chunk.header.track_key.clone(),
                chunk.header.epoch.clone(),
                chunk.end_ms(),
            ));
            {
                let mut v = self.view.lock().unwrap();
                v.ai.status = "processing".into();
                v.ai.lag_ms = v
                    .playback
                    .as_ref()
                    .filter(|p| p.track.key() == job.track.key() && p.epoch == chunk.header.epoch)
                    .map_or(0.0, |p| (p.position_ms - chunk.end_ms()).max(0.0));
            }
            self.emit();
            if worker.is_none() {
                match ai::Worker::spawn(&self.data_dir, &self.resources).await {
                    Ok(w) => worker = Some(w),
                    Err(err) => {
                        if self.job_is_current(&job) {
                            self.ai_error(err);
                        }
                        continue;
                    }
                }
            }
            let result = tokio::select! {
                biased;
                _=self.audio_cancel.notified()=>None,
                result=worker.as_mut().unwrap().transcribe(chunk)=>Some(result),
            };
            let Some(result) = result else {
                if let Some(w) = worker.as_mut() {
                    w.stop().await;
                }
                worker = None;
                *self.processing_end.lock().unwrap() = None;
                continue;
            };
            *self.processing_end.lock().unwrap() = None;
            match result {
                Ok(lines) => {
                    if let Err(err) = self.finish_audio_job(&job, lines) {
                        self.error(err);
                    }
                }
                Err(err) => {
                    if let Some(w) = worker.as_mut() {
                        w.stop().await;
                    }
                    worker = None;
                    if self.job_is_current(&job) {
                        self.ai_error(err);
                    }
                }
            }
        }
        if let Some(w) = worker.as_mut() {
            w.stop().await;
        }
    }
    fn ai_error(&self, err: impl ToString) {
        self.stop_capture();
        let mut v = self.view.lock().unwrap();
        v.ai.status = "error".into();
        v.ai.message = err.to_string();
        drop(v);
        self.emit();
    }
}
use anyhow::Context;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::AudioHeader;

    fn setup() -> (Arc<Engine>, mpsc::Receiver<AudioJob>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let (engine, rx) = Engine::new(dir.path().into(), dir.path().into()).unwrap();
        // Simulate an approved session only; these tests do not run Whisper or
        // replace production model/signature verification.
        *engine.audio_session.lock().unwrap() = Some("capture-a".into());
        engine.audio_enabled.store(true, Ordering::SeqCst);
        engine.capture_generation.store(1, Ordering::SeqCst);
        (engine, rx, dir)
    }
    fn snapshot() -> PlaybackSnapshot {
        PlaybackSnapshot {
            track: Track {
                source: "soundcloud".into(),
                id: "https://soundcloud.com/artist/song".into(),
                title: "Song".into(),
                artist: "Artist".into(),
                artwork: None,
                duration_ms: 184000.0,
            },
            position_ms: 184000.0,
            playback_rate: 1.0,
            status: "playing".into(),
            observed_at_ms: now_ms(),
            sequence: 1,
            epoch: "playing".into(),
        }
    }
    fn tail(snapshot: &PlaybackSnapshot, samples: usize) -> AudioChunk {
        AudioChunk {
            header: AudioHeader {
                track_key: snapshot.track.key(),
                epoch: snapshot.epoch.clone(),
                start_ms: snapshot.position_ms - samples as f64 / 16.0,
                playback_rate: snapshot.playback_rate,
                samples,
            },
            pcm: vec![0; samples * 2],
        }
    }
    fn phrase() -> Vec<LyricLine> {
        vec![LyricLine {
            text: "Last phrase".into(),
            start_ms: 0.0,
            end_ms: 1000.0,
            words: vec![],
        }]
    }
    #[test]
    fn accepted_tail_survives_pause_seek_end_and_track_change() {
        for boundary in ["paused", "seek", "stopped", "track"] {
            let (engine, mut rx, _dir) = setup();
            let old = snapshot();
            engine.view.lock().unwrap().playback = Some(old.clone());
            engine.queue_audio(tail(&old, 128000)).unwrap();
            let job = rx.try_recv().unwrap();
            let mut next = old.clone();
            next.epoch = boundary.into();
            next.sequence += 1;
            if boundary == "track" {
                next.track.id = "https://soundcloud.com/artist/next".into();
                next.position_ms = 1000.0;
            } else if boundary == "seek" {
                next.position_ms = 1000.0;
            } else {
                next.status = boundary.into();
            }
            // Model the receive boundary without triggering a network lookup.
            engine.view.lock().unwrap().playback = Some(next.clone());
            assert!(
                engine.finish_audio_job(&job, phrase()).unwrap(),
                "{boundary}"
            );
            let cached = engine
                .store
                .lock()
                .unwrap()
                .lyrics(&old.track.key())
                .unwrap()
                .unwrap();
            assert_eq!(cached.coverage[0].start_ms, 176000.0);
            assert_eq!(cached.coverage[0].end_ms, 184000.0);
            assert_eq!(cached.lines[0].start_ms, 176000.0);
            assert_eq!(engine.state().playback.unwrap().epoch, boundary);
            if boundary == "track" {
                assert!(engine.state().lyrics.is_none());
            } else {
                assert_eq!(engine.state().lyrics.unwrap().track_key, old.track.key());
            }
        }
    }
    #[test]
    fn subsecond_tail_uses_actual_samples_not_worker_padding_for_coverage() {
        let (engine, mut rx, _dir) = setup();
        let s = snapshot();
        engine.view.lock().unwrap().playback = Some(s.clone());
        engine.queue_audio(tail(&s, 8000)).unwrap();
        let job = rx.try_recv().unwrap();
        engine.finish_audio_job(&job, phrase()).unwrap();
        let doc = engine.state().lyrics.unwrap();
        assert_eq!(doc.coverage[0].start_ms, 183500.0);
        assert_eq!(doc.coverage[0].end_ms, 184000.0);
        assert_eq!(doc.lines[0].end_ms, 184000.0);
    }
    #[test]
    fn explicit_stop_cancels_old_results_even_after_a_new_capture() {
        let (engine, mut rx, _dir) = setup();
        let s = snapshot();
        engine.view.lock().unwrap().playback = Some(s.clone());
        engine.queue_audio(tail(&s, 128000)).unwrap();
        let job = rx.try_recv().unwrap();
        engine.stop_capture_from_client(Some("capture-a"));
        assert!(!engine.finish_audio_job(&job, phrase()).unwrap());
        assert!(engine.queue_audio(tail(&s, 128000)).is_err());
        *engine.audio_session.lock().unwrap() = Some("capture-b".into());
        engine.capture_generation.fetch_add(1, Ordering::SeqCst);
        engine.audio_enabled.store(true, Ordering::SeqCst);
        engine.stop_capture_from_client(Some("capture-a"));
        assert!(engine.audio_enabled.load(Ordering::SeqCst));
        assert!(!engine.finish_audio_job(&job, phrase()).unwrap());
        assert!(engine
            .store
            .lock()
            .unwrap()
            .lyrics(&s.track.key())
            .unwrap()
            .is_none());
    }
    #[test]
    fn accepted_old_audio_does_not_replace_authoritative_lyrics() {
        let (engine, mut rx, _dir) = setup();
        let s = snapshot();
        engine.view.lock().unwrap().playback = Some(s.clone());
        engine.queue_audio(tail(&s, 128000)).unwrap();
        let job = rx.try_recv().unwrap();
        engine.publish_document(crate::lyrics::instrumental(&s.track));
        assert!(!engine.finish_audio_job(&job, phrase()).unwrap());
        assert_eq!(engine.state().lyrics.unwrap().sync, "instrumental");
    }
    #[tokio::test]
    async fn player_removed_invalidates_pending_cache_lookup_and_stops_capture() {
        let (engine, _rx, _dir) = setup();
        let s = snapshot();
        engine
            .store
            .lock()
            .unwrap()
            .save_lyrics(&crate::lyrics::instrumental(&s.track))
            .unwrap();
        engine.receive(s).unwrap();
        engine.clear_player();
        // Allow the pending cache task to run after the source was removed.
        tokio::task::yield_now().await;
        let view = engine.state();
        assert!(view.connected);
        assert!(view.playback.is_none());
        assert!(view.lyrics.is_none());
        assert!(view.candidates.is_empty());
        assert_eq!(view.lyrics_status, "idle");
        assert!(!engine.audio_enabled.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn playback_epoch_change_does_not_cancel_an_accepted_audio_job() {
        let (engine, mut rx, _dir) = setup();
        let s = snapshot();
        engine
            .store
            .lock()
            .unwrap()
            .save_lyrics(&ai::merge_chunk(
                None,
                &tail(&s, 8000),
                vec![],
                s.track.duration_ms,
            ))
            .unwrap();
        engine.view.lock().unwrap().playback = Some(s.clone());
        engine.queue_audio(tail(&s, 128000)).unwrap();
        let job = rx.try_recv().unwrap();
        let mut paused = s;
        paused.epoch = "paused".into();
        paused.sequence += 1;
        paused.status = "paused".into();
        engine.receive(paused).unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            engine.audio_cancel.notified()
        )
        .await
        .is_err());
        assert!(engine.finish_audio_job(&job, phrase()).unwrap());
        assert_eq!(engine.state().lyrics.unwrap().coverage[0].end_ms, 184000.0);
    }
}
