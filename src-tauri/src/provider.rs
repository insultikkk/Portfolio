use crate::{lyrics::*, model::*};
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTrack {
    pub id: u64,
    #[serde(default, alias = "name")]
    pub track_name: String,
    #[serde(default)]
    pub artist_name: String,
    pub duration: f64,
    #[serde(default)]
    pub instrumental: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
    pub lyricsfile: Option<String>,
}
impl ApiTrack {
    pub fn candidate(&self, t: &Track) -> Candidate {
        Candidate {
            id: self.id,
            title: self.track_name.clone(),
            artist: self.artist_name.clone(),
            duration_ms: self.duration * 1000.0,
            synced: matches!(self.document(t).sync.as_str(), "line" | "word"),
            compatible: compatible(t, &self.track_name, self.duration * 1000.0),
        }
    }
    pub fn document(&self, t: &Track) -> LyricsDocument {
        if self.instrumental {
            return instrumental(t);
        }
        if let Some(doc) = self
            .lyricsfile
            .as_deref()
            .and_then(|s| from_lyricsfile(s, t))
        {
            return doc;
        }
        let lines = self
            .synced_lyrics
            .as_deref()
            .map(|s| parse_lrc(s, t.duration_ms))
            .unwrap_or_default();
        LyricsDocument {
            track_key: t.key(),
            source: "lrclib".into(),
            sync: if lines.is_empty() { "plain" } else { "line" }.into(),
            plain: self.plain_lyrics.clone().unwrap_or_else(|| {
                lines
                    .iter()
                    .map(|l| l.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            }),
            coverage: if lines.is_empty() {
                vec![]
            } else {
                vec![Coverage {
                    start_ms: 0.0,
                    end_ms: t.duration_ms,
                }]
            },
            lines,
            approximate: false,
        }
    }
}
#[async_trait]
pub trait LyricsProvider: Send + Sync {
    async fn search(&self, track: &Track) -> Result<Vec<ApiTrack>>;
}
pub struct Lrclib {
    client: reqwest::Client,
}
impl Lrclib {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .user_agent("Still-Live-Lyrics/0.1.0 (personal desktop companion)")
                .timeout(std::time::Duration::from_secs(15))
                .build()?,
        })
    }
    async fn request(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Option<serde_json::Value>> {
        let response = self
            .client
            .get(format!("https://lrclib.net/api/{path}"))
            .query(query)
            .send()
            .await
            .context("LRCLIB недоступен")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = response
            .error_for_status()
            .context("LRCLIB вернул ошибку")?;
        let mut stream = response.bytes_stream();
        let mut buf = Vec::new();
        while let Some(part) = stream.next().await {
            let part = part?;
            anyhow::ensure!(
                buf.len() + part.len() <= 1_500_000,
                "Ответ LRCLIB слишком большой"
            );
            buf.extend_from_slice(&part);
        }
        Ok(Some(serde_json::from_slice(&buf)?))
    }
}
#[async_trait]
impl LyricsProvider for Lrclib {
    async fn search(&self, t: &Track) -> Result<Vec<ApiTrack>> {
        if !t.artist.is_empty() {
            if let Some(value) = self
                .request(
                    "get",
                    &[
                        ("track_name", t.title.clone()),
                        ("artist_name", t.artist.clone()),
                        ("duration", (t.duration_ms / 1000.0).to_string()),
                    ],
                )
                .await?
            {
                if let Ok(exact) = serde_json::from_value::<ApiTrack>(value) {
                    if normalize(&exact.track_name) == normalize(&t.title)
                        && normalize(&exact.artist_name) == normalize(&t.artist)
                        && compatible(t, &exact.track_name, exact.duration * 1000.0)
                    {
                        return Ok(vec![exact]);
                    }
                }
            }
        }
        let mut query = vec![("track_name", t.title.clone())];
        if !t.artist.is_empty() {
            query.push(("artist_name", t.artist.clone()));
        }
        let Some(value) = self.request("search", &query).await? else {
            return Ok(vec![]);
        };
        let rows = value.as_array().context("Некорректный ответ LRCLIB")?;
        let mut tracks: Vec<ApiTrack> = rows
            .iter()
            .filter_map(|value| serde_json::from_value(value.clone()).ok())
            .collect();
        tracks.retain(|r| {
            r.duration.is_finite()
                && r.duration > 0.0
                && (!r.track_name.is_empty())
                && (r.instrumental
                    || r.plain_lyrics.is_some()
                    || r.synced_lyrics.is_some()
                    || r.lyricsfile.is_some())
        });
        tracks.sort_by_key(|r| {
            (
                !compatible(t, &r.track_name, r.duration * 1000.0),
                r.synced_lyrics.is_none(),
            )
        });
        tracks.truncate(12);
        Ok(tracks)
    }
}
pub fn auto_match<'a>(t: &Track, rows: &'a [ApiTrack]) -> Option<&'a ApiTrack> {
    if t.artist.trim().is_empty() {
        return None;
    }
    let matches: Vec<_> = rows
        .iter()
        .filter(|r| {
            normalize(&r.track_name) == normalize(&t.title)
                && normalize(&r.artist_name) == normalize(&t.artist)
                && compatible(t, &r.track_name, r.duration * 1000.0)
        })
        .collect();
    (matches.len() == 1).then(|| matches[0])
}
#[cfg(test)]
mod tests {
    use super::*;
    fn t() -> Track {
        Track {
            source: "soundcloud".into(),
            id: "https://soundcloud.com/a/song".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            duration_ms: 180000.0,
            artwork: None,
        }
    }
    fn row() -> ApiTrack {
        serde_json::from_str(r#"{"id":1,"trackName":"Song","artistName":"Artist","duration":180,"syncedLyrics":"[00:01]Hello"}"#).unwrap()
    }
    #[test]
    fn only_unambiguous_exact_versions_auto_select() {
        assert!(auto_match(&t(), &[row()]).is_some());
        let mut r = row();
        r.track_name = "Song (Live)".into();
        assert!(auto_match(&t(), &[r]).is_none());
        assert!(auto_match(&t(), &[row(), row()]).is_none());
        let mut t = t();
        t.artist.clear();
        assert!(auto_match(&t, &[row()]).is_none());
    }
    #[test]
    fn plain_and_instrumental_remain_distinct() {
        let mut r = row();
        r.synced_lyrics = None;
        r.plain_lyrics = Some("Hello".into());
        assert_eq!(r.document(&t()).sync, "plain");
        r.instrumental = true;
        assert_eq!(r.document(&t()).sync, "instrumental");
    }
}
