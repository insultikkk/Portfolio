use serde::{Deserialize, Serialize};

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub source: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artwork: Option<String>,
    pub duration_ms: f64,
}
impl Track {
    pub fn key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.source,
            self.id,
            self.duration_ms.round() as i64
        )
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(self.source == "soundcloud", "Unsupported player");
        let url = url::Url::parse(&self.id)?;
        anyhow::ensure!(
            url.scheme() == "https"
                && url.host_str() == Some("soundcloud.com")
                && url.username().is_empty()
                && url.password().is_none(),
            "Invalid track URL"
        );
        anyhow::ensure!(
            !self.title.trim().is_empty()
                && self.title.len() <= 500
                && self.artist.len() <= 500
                && self.id.len() < 1500,
            "Invalid metadata"
        );
        anyhow::ensure!(
            self.duration_ms.is_finite()
                && self.duration_ms > 0.0
                && self.duration_ms <= 43_200_000.0,
            "Unknown track duration"
        );
        if let Some(art) = &self.artwork {
            let url = url::Url::parse(art)?;
            anyhow::ensure!(
                art.len() < 2000
                    && url.scheme() == "https"
                    && url.host_str().is_some_and(|h| h.ends_with(".sndcdn.com")),
                "Invalid artwork URL"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
    pub track: Track,
    pub position_ms: f64,
    pub playback_rate: f64,
    pub status: String,
    pub observed_at_ms: f64,
    pub sequence: u64,
    pub epoch: String,
}
impl PlaybackSnapshot {
    pub fn validate(&self) -> anyhow::Result<()> {
        self.track.validate()?;
        anyhow::ensure!(
            self.position_ms.is_finite()
                && self.position_ms >= 0.0
                && self.position_ms <= self.track.duration_ms + 1000.0,
            "Invalid position"
        );
        anyhow::ensure!(
            self.playback_rate.is_finite() && (0.25..=4.0).contains(&self.playback_rate),
            "Invalid rate"
        );
        anyhow::ensure!(
            ["playing", "paused", "buffering", "stopped", "ad"].contains(&self.status.as_str()),
            "Invalid state"
        );
        anyhow::ensure!(
            self.observed_at_ms.is_finite() && (now_ms() - self.observed_at_ms).abs() < 10_000.0,
            "Stale snapshot"
        );
        anyhow::ensure!(
            !self.epoch.is_empty() && self.epoch.len() < 100,
            "Invalid epoch"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub words: Vec<Word>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub start_ms: f64,
    pub end_ms: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDocument {
    pub track_key: String,
    pub source: String,
    pub sync: String,
    pub lines: Vec<LyricLine>,
    pub plain: String,
    pub coverage: Vec<Coverage>,
    pub approximate: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub duration_ms: f64,
    pub synced: bool,
    pub compatible: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub opacity: f64,
    pub font_scale: f64,
    pub offset_ms: f64,
    pub locked: bool,
    pub visible: bool,
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            opacity: 0.88,
            font_scale: 1.0,
            offset_ms: 0.0,
            locked: true,
            visible: true,
            width: 340.0,
            height: 300.0,
            x: None,
            y: None,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.opacity.is_finite() && (0.3..=1.0).contains(&self.opacity),
            "Invalid opacity"
        );
        anyhow::ensure!(
            self.font_scale.is_finite() && (0.75..=1.5).contains(&self.font_scale),
            "Invalid font size"
        );
        anyhow::ensure!(
            self.offset_ms.is_finite() && self.offset_ms.abs() <= 10_000.0,
            "Invalid timing offset"
        );
        anyhow::ensure!(
            self.width.is_finite()
                && (280.0..=720.0).contains(&self.width)
                && self.height.is_finite()
                && (240.0..=900.0).contains(&self.height),
            "Invalid window size"
        );
        anyhow::ensure!(
            self.x.is_none_or(f64::is_finite) && self.y.is_none_or(f64::is_finite),
            "Invalid coordinates"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub status: String,
    pub progress: f64,
    pub message: String,
    pub lag_ms: f64,
}
impl Default for AiStatus {
    fn default() -> Self {
        Self {
            status: "needsModel".into(),
            progress: 0.0,
            message: String::new(),
            lag_ms: 0.0,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    pub playback: Option<PlaybackSnapshot>,
    pub lyrics: Option<LyricsDocument>,
    pub candidates: Vec<Candidate>,
    pub lyrics_status: String,
    pub connected: bool,
    pub settings: Settings,
    pub ai: AiStatus,
    pub error: Option<String>,
}
impl Default for ViewState {
    fn default() -> Self {
        Self {
            playback: None,
            lyrics: None,
            candidates: vec![],
            lyrics_status: "idle".into(),
            connected: false,
            settings: Settings::default(),
            ai: AiStatus::default(),
            error: None,
        }
    }
}
