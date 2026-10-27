use crate::model::*;
use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// Publisher's checksum: ggml-org/whisper.cpp/models/README.md. Download the
// original, verify it, then quantize locally instead of trusting an unpinned mirror.
pub const SMALL_SHA1: &str = "55356645c2b361a969dfd0ef2c5a50d530afd8d5";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioHeader {
    pub track_key: String,
    pub epoch: String,
    pub start_ms: f64,
    pub playback_rate: f64,
    pub samples: usize,
}
#[derive(Clone)]
pub struct AudioChunk {
    pub header: AudioHeader,
    pub pcm: Vec<u8>,
}
pub fn needs_transcription(document: Option<&LyricsDocument>, chunk: &AudioChunk) -> bool {
    let Some(doc) = document.filter(|d| d.track_key == chunk.header.track_key) else {
        return true;
    };
    if doc.source == "lrclib" && matches!(doc.sync.as_str(), "line" | "word" | "instrumental") {
        return false;
    }
    !(doc.source == "whisper"
        && doc
            .coverage
            .iter()
            .any(|c| c.start_ms <= chunk.header.start_ms && c.end_ms >= chunk.end_ms()))
}
impl AudioChunk {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            (1..=160000).contains(&self.header.samples)
                && self.pcm.len() == self.header.samples * 2,
            "Invalid PCM length"
        );
        anyhow::ensure!(
            self.header.start_ms.is_finite()
                && self.header.start_ms >= 0.0
                && self.header.playback_rate.is_finite()
                && (0.25..=4.0).contains(&self.header.playback_rate),
            "Invalid audio timeline"
        );
        Ok(())
    }
    pub fn end_ms(&self) -> f64 {
        self.header.start_ms + self.header.samples as f64 / 16.0 * self.header.playback_rate
    }
}
#[derive(Serialize, Deserialize)]
pub struct WorkerRequest {
    pub samples: usize,
    pub language: String,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct WorkerResponse {
    pub lines: Vec<LyricLine>,
    pub error: Option<String>,
}

fn hash_file(path: &Path) -> Result<String> {
    let mut h = Sha256::new();
    let mut f = std::fs::File::open(path)?;
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}
pub fn model_path(data: &Path) -> PathBuf {
    data.join("models/ggml-small-q5_1.bin")
}
pub fn model_present(data: &Path) -> bool {
    model_path(data).is_file() && data.join("models/model.sha256").is_file()
}
pub fn verify_model(data: &Path) -> Result<PathBuf> {
    let p = model_path(data);
    let expected = std::fs::read_to_string(data.join("models/model.sha256"))?;
    anyhow::ensure!(
        expected.trim() == hash_file(&p)?,
        "Контрольная сумма модели не совпадает. Загрузите модель заново."
    );
    Ok(p)
}
pub fn binary_path(resources: &Path, name: &str) -> PathBuf {
    resources
        .join("binaries")
        .join(format!("{name}{}", if cfg!(windows) { ".exe" } else { "" }))
}
pub async fn install_model(
    data: &Path,
    resources: &Path,
    progress: impl Fn(f64, &str),
) -> Result<()> {
    let directory = data.join("models");
    std::fs::create_dir_all(&directory)?;
    let quantizer = binary_path(resources, "whisper-quantize");
    anyhow::ensure!(
        quantizer.is_file(),
        "Нет whisper-quantize. Соберите вспомогательные программы по инструкции README."
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()?;
    let response = client.get(MODEL_URL).send().await?.error_for_status()?;
    let total = response.content_length().unwrap_or(487601967);
    anyhow::ensure!(total <= 600_000_000, "Некорректный размер модели");
    let raw = directory.join("small.download");
    let mut file = std::fs::File::create(&raw)?;
    let mut hash = Sha1::new();
    let mut bytes = 0u64;
    let mut stream = response.bytes_stream();
    let mut reported = std::time::Instant::now();
    while let Some(part) = stream.next().await {
        let part = part?;
        bytes += part.len() as u64;
        anyhow::ensure!(bytes <= 600_000_000, "Модель превышает лимит размера");
        hash.update(&part);
        file.write_all(&part)?;
        if reported.elapsed() >= std::time::Duration::from_millis(250) {
            progress(
                (bytes as f64 / total as f64 * 0.85).min(0.85),
                "Загружаем многоязычную модель…",
            );
            reported = std::time::Instant::now();
        }
    }
    file.sync_all()?;
    drop(file);
    anyhow::ensure!(
        hex::encode(hash.finalize()) == SMALL_SHA1,
        "Не совпала контрольная сумма модели. Файл не будет использован."
    );
    progress(0.88, "Квантуем модель локально…");
    let output = directory.join("small.quantized.part");
    let mut command = tokio::process::Command::new(quantizer);
    command
        .arg(&raw)
        .arg(&output)
        .arg("q5_1")
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000 | 0x00004000); // no console, below-normal priority
    let status = command.status().await?;
    anyhow::ensure!(
        status.success() && output.metadata()?.len() > 1_000_000,
        "Квантование не удалось"
    );
    let digest = hash_file(&output)?;
    std::fs::rename(&output, model_path(data))?;
    std::fs::write(directory.join("model.sha256"), digest)?;
    // Only our verified temporary source is removed; the model is reproducible.
    std::fs::remove_file(raw)?;
    progress(1.0, "Модель готова");
    Ok(())
}
pub struct Worker {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
}
impl Worker {
    pub async fn spawn(data: &Path, resources: &Path) -> Result<Self> {
        let model = verify_model(data)?;
        let binary = binary_path(resources, "lyrics-whisper");
        anyhow::ensure!(binary.is_file(), "Не найден lyrics-whisper");
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg(model)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000 | 0x00004000);
        let mut child = cmd.spawn().context("Не удалось запустить Whisper")?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
        })
    }
    pub async fn transcribe(&mut self, chunk: &AudioChunk) -> Result<Vec<LyricLine>> {
        let mut header = serde_json::to_vec(&WorkerRequest {
            samples: chunk.header.samples,
            language: "auto".into(),
        })?;
        header.push(b'\n');
        self.input.write_all(&header).await?;
        self.input.write_all(&chunk.pcm).await?;
        self.input.flush().await?;
        let mut line = String::new();
        let size = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            self.output.read_line(&mut line),
        )
        .await??;
        anyhow::ensure!(
            size > 0 && size < 500_000,
            "Whisper завершился или вернул неверный результат"
        );
        let result: WorkerResponse = serde_json::from_str(&line)?;
        if let Some(err) = result.error {
            anyhow::bail!(err);
        }
        Ok(result.lines)
    }
    pub async fn stop(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

pub fn merge_chunk(
    existing: Option<LyricsDocument>,
    chunk: &AudioChunk,
    mut lines: Vec<LyricLine>,
    duration_ms: f64,
) -> LyricsDocument {
    let mut doc = existing
        .filter(|d| d.source == "whisper" && d.track_key == chunk.header.track_key)
        .unwrap_or_else(|| LyricsDocument {
            track_key: chunk.header.track_key.clone(),
            source: "whisper".into(),
            sync: "line".into(),
            lines: vec![],
            plain: String::new(),
            coverage: vec![],
            approximate: true,
        });
    let start = chunk.header.start_ms;
    let end = chunk.end_ms().min(duration_ms);
    for l in &mut lines {
        l.start_ms = start + l.start_ms * chunk.header.playback_rate;
        l.end_ms = (start + l.end_ms * chunk.header.playback_rate).min(end);
        l.words.clear();
    } // ASR token timings are approximate, not authoritative word timings.
    doc.lines
        .retain(|l| l.start_ms < start || l.start_ms >= end);
    doc.lines.extend(lines.into_iter().filter(|l| {
        l.start_ms.is_finite()
            && l.end_ms.is_finite()
            && l.start_ms >= start
            && l.start_ms < end
            && l.end_ms > l.start_ms
            && !l.text.trim().is_empty()
    }));
    doc.lines.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    doc.lines.dedup_by(|a, b| {
        a.text.trim() == b.text.trim() && (a.start_ms - b.start_ms).abs() < 1500.0
    });
    // Keep overlaps bounded, without stretching a recognized phrase across uncaptured gaps.
    crate::lyrics::finish_lines(&mut doc.lines, duration_ms);
    doc.coverage.push(Coverage {
        start_ms: start,
        end_ms: end,
    });
    doc.coverage
        .sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let mut coverage: Vec<Coverage> = vec![];
    for c in doc.coverage {
        if let Some(last) = coverage
            .last_mut()
            .filter(|last| c.start_ms <= last.end_ms + 1.0)
        {
            last.end_ms = last.end_ms.max(c.end_ms);
        } else {
            coverage.push(c);
        }
    }
    doc.coverage = coverage;
    doc.plain = doc
        .lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    doc
}
#[cfg(test)]
mod tests {
    use super::*;
    fn chunk(start: f64) -> AudioChunk {
        AudioChunk {
            header: AudioHeader {
                track_key: "song".into(),
                epoch: "a".into(),
                start_ms: start,
                playback_rate: 1.0,
                samples: 160000,
            },
            pcm: vec![0; 320000],
        }
    }
    #[test]
    fn rejects_inconsistent_pcm() {
        let mut c = chunk(0.0);
        assert!(c.validate().is_ok());
        c.pcm.pop();
        assert!(c.validate().is_err());
    }
    #[test]
    fn partial_capture_never_becomes_full_song() {
        let c = chunk(60000.0);
        let line = LyricLine {
            text: "Hello".into(),
            start_ms: 1000.0,
            end_ms: 2000.0,
            words: vec![],
        };
        let d = merge_chunk(None, &c, vec![line], 180000.0);
        assert_eq!(d.lines[0].start_ms, 61000.0);
        assert_eq!(d.coverage[0].start_ms, 60000.0);
        assert_eq!(d.coverage[0].end_ms, 70000.0);
        assert!(d.approximate);
    }
    #[test]
    fn speed_is_mapped_back_to_song_timeline() {
        let mut c = chunk(1000.0);
        c.header.playback_rate = 2.0;
        let d = merge_chunk(
            None,
            &c,
            vec![LyricLine {
                text: "A".into(),
                start_ms: 1000.0,
                end_ms: 2000.0,
                words: vec![],
            }],
            180000.0,
        );
        assert_eq!(d.lines[0].start_ms, 3000.0);
        assert_eq!(d.coverage[0].end_ms, 21000.0);
    }
    #[test]
    fn silence_keeps_coverage_without_fabricating_text() {
        let d = merge_chunk(None, &chunk(0.0), vec![], 180000.0);
        assert!(d.lines.is_empty());
        assert_eq!(d.coverage.len(), 1);
    }
    #[test]
    fn cached_or_authoritative_intervals_do_not_use_cpu_again() {
        let c = chunk(60000.0);
        let mut d = merge_chunk(None, &c, vec![], 180000.0);
        assert!(!needs_transcription(Some(&d), &c));
        assert!(needs_transcription(Some(&d), &chunk(65000.0)));
        d.source = "lrclib".into();
        d.sync = "line".into();
        d.coverage.clear();
        assert!(!needs_transcription(Some(&d), &c));
        d.sync = "plain".into();
        assert!(needs_transcription(Some(&d), &c));
        d.track_key = "different".into();
        d.sync = "word".into();
        assert!(needs_transcription(Some(&d), &c));
    }
}
