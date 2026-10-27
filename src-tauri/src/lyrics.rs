use crate::model::*;
use serde::Deserialize;

pub fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn variants(s: &str) -> Vec<&'static str> {
    let text = format!(" {} ", normalize(s));
    [
        "remix",
        "live",
        "acoustic",
        "instrumental",
        "sped up",
        "slowed",
        "nightcore",
        "edit",
        "cover",
        "mix",
    ]
    .into_iter()
    .filter(|v| text.contains(&format!(" {v} ")))
    .collect()
}
pub fn compatible(track: &Track, title: &str, duration_ms: f64) -> bool {
    variants(&track.title) == variants(title) && (duration_ms - track.duration_ms).abs() <= 2500.0
}
fn time(tag: &str) -> Option<f64> {
    let (minutes, seconds) = tag.split_once(':')?;
    let m: u32 = minutes.parse().ok()?;
    let s: f64 = seconds.replace(':', ".").parse().ok()?;
    (s.is_finite() && (0.0..60.0).contains(&s)).then_some(m as f64 * 60_000.0 + s * 1000.0)
}

pub fn parse_lrc(input: &str, duration_ms: f64) -> Vec<LyricLine> {
    let mut out = vec![];
    let mut offset = 0.0;
    for line in input.lines() {
        if let Some(s) = line
            .trim()
            .strip_prefix("[offset:")
            .and_then(|s| s.strip_suffix(']'))
        {
            offset = s
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && v.abs() < 60000.0)
                .unwrap_or(0.0);
        }
    }
    for raw in input.lines().take(5000) {
        let mut rest = raw.trim();
        let mut stamps = vec![];
        while let Some(r) = rest.strip_prefix('[') {
            let Some(end) = r.find(']') else { break };
            let Some(t) = time(&r[..end]) else { break };
            stamps.push((t + offset).max(0.0));
            rest = &r[end + 1..];
        }
        for start_ms in stamps {
            // Empty timed lines are retained to terminate vocals during breaks.
            if start_ms < duration_ms {
                out.push(LyricLine {
                    text: rest.trim().into(),
                    start_ms,
                    end_ms: duration_ms,
                    words: vec![],
                });
            }
        }
    }
    finish_lines(&mut out, duration_ms);
    out
}
pub fn finish_lines(lines: &mut [LyricLine], duration_ms: f64) {
    lines.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    for i in 0..lines.len() {
        let next = lines.get(i + 1).map_or(duration_ms, |l| l.start_ms);
        lines[i].end_ms = lines[i]
            .end_ms
            .min(next)
            .min(duration_ms)
            .max(lines[i].start_ms);
        let line = &mut lines[i];
        for word in &mut line.words {
            word.end_ms = word.end_ms.min(line.end_ms);
        }
        // Inferred line boundaries apply to words too. Invalid annotations fall
        // back to the full line text rather than highlighting outside the line.
        if line.words.iter().any(|w| {
            !w.start_ms.is_finite()
                || !w.end_ms.is_finite()
                || w.start_ms < line.start_ms
                || w.end_ms <= w.start_ms
        }) {
            line.words.clear();
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FileDoc {
    version: String,
    metadata: FileMeta,
    lines: Vec<FileLine>,
    plain: Option<String>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct FileMeta {
    offset_ms: f64,
    instrumental: bool,
}
#[derive(Deserialize)]
struct FileLine {
    text: String,
    start_ms: f64,
    end_ms: Option<f64>,
    #[serde(default)]
    words: Vec<FileWord>,
}
#[derive(Deserialize)]
struct FileWord {
    text: String,
    start_ms: f64,
    end_ms: Option<f64>,
}
pub fn from_lyricsfile(input: &str, track: &Track) -> Option<LyricsDocument> {
    if input.len() > 500_000 {
        return None;
    }
    let file: FileDoc = serde_yaml::from_str(input).ok()?;
    if file.version != "1.0" || file.lines.len() > 5000 || !file.metadata.offset_ms.is_finite() {
        return None;
    }
    if file.metadata.instrumental {
        return Some(instrumental(track));
    }
    let offset = file.metadata.offset_ms;
    let mut lines = Vec::new();
    for line in file.lines {
        if !line.start_ms.is_finite()
            || line.start_ms + offset < 0.0
            || line.start_ms + offset >= track.duration_ms
        {
            continue;
        }
        let end = line
            .end_ms
            .filter(|v| v.is_finite())
            .unwrap_or(track.duration_ms)
            + offset;
        let mut words: Vec<Word> =
            line.words
                .iter()
                .enumerate()
                .filter_map(|(i, w)| {
                    let next = line.words.get(i + 1).map_or(end - offset, |n| n.start_ms);
                    let end_ms = w.end_ms.unwrap_or(next) + offset;
                    (w.start_ms.is_finite() && end_ms.is_finite() && end_ms > w.start_ms + offset)
                        .then(|| Word {
                            text: w.text.clone(),
                            start_ms: w.start_ms + offset,
                            end_ms,
                        })
                })
                .collect();
        words.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
        // Only use timing when the words reproduce the displayed lyric, not a partial annotation.
        if normalize(&words.iter().map(|w| w.text.as_str()).collect::<String>())
            != normalize(&line.text)
        {
            if normalize(
                &words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            ) == normalize(&line.text)
            {
                let last = words.len().saturating_sub(1);
                for (i, word) in words.iter_mut().enumerate() {
                    if i < last && !word.text.ends_with(char::is_whitespace) {
                        word.text.push(' ');
                    }
                }
            } else {
                words.clear();
            }
        }
        lines.push(LyricLine {
            text: line.text,
            start_ms: line.start_ms + offset,
            end_ms: end,
            words,
        });
    }
    finish_lines(&mut lines, track.duration_ms);
    if lines.is_empty() {
        return None;
    }
    let word_sync = lines.iter().any(|l| !l.words.is_empty());
    let plain = file.plain.unwrap_or_else(|| {
        lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    });
    Some(LyricsDocument {
        track_key: track.key(),
        source: "lrclib".into(),
        sync: if word_sync { "word" } else { "line" }.into(),
        lines,
        plain,
        coverage: vec![Coverage {
            start_ms: 0.0,
            end_ms: track.duration_ms,
        }],
        approximate: false,
    })
}
pub fn instrumental(track: &Track) -> LyricsDocument {
    LyricsDocument {
        track_key: track.key(),
        source: "lrclib".into(),
        sync: "instrumental".into(),
        lines: vec![],
        plain: String::new(),
        coverage: vec![Coverage {
            start_ms: 0.0,
            end_ms: track.duration_ms,
        }],
        approximate: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn track() -> Track {
        Track {
            source: "soundcloud".into(),
            id: "https://soundcloud.com/artist/song".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            artwork: None,
            duration_ms: 180000.0,
        }
    }
    #[test]
    fn lrc_multiple_stamps_and_empty_breaks() {
        let l = parse_lrc(
            "[ar:Artist]\n[00:01.50][00:20.123]Hello\n[00:05.000]\n[00:10.00]World",
            180000.0,
        );
        assert_eq!(l.len(), 4);
        assert_eq!(l[0].start_ms, 1500.0);
        assert_eq!(l[0].end_ms, 5000.0);
        assert!(l[1].text.is_empty());
        assert_eq!(l[3].start_ms, 20123.0);
    }
    #[test]
    fn global_offset_and_bad_input() {
        let l = parse_lrc("[00:01]One\n[offset:250]\n[00:99]bad\n[NaN:x]bad", 5000.0);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].start_ms, 1250.0);
    }
    #[test]
    fn preserve_recording_variants() {
        let t = track();
        assert!(!compatible(&t, "Song (Remix)", 180000.0));
        assert!(!compatible(&t, "Song", 190000.0));
        assert!(compatible(&t, "Song", 181000.0));
    }
    #[test]
    fn lyricsfile_words() {
        let raw="version: '1.0'\nmetadata: {}\nlines:\n  - text: Hello world\n    start_ms: 1000\n    end_ms: 3000\n    words:\n      - {text: 'Hello ', start_ms: 1000}\n      - {text: world, start_ms: 2000}\n";
        let doc = from_lyricsfile(raw, &track()).unwrap();
        assert_eq!(doc.sync, "word");
        assert_eq!(doc.lines[0].words[0].end_ms, 2000.0);
    }
    #[test]
    fn unsupported_yaml_is_not_trusted() {
        assert!(from_lyricsfile("version: '9.0'\nlines: []", &track()).is_none());
    }
    #[test]
    fn word_end_is_bounded_by_the_next_line_without_explicit_ends() {
        let raw = "version: '1.0'\nlines:\n  - text: Hello world\n    start_ms: 1000\n    words:\n      - {text: 'Hello ', start_ms: 1000}\n      - {text: world, start_ms: 2000}\n  - {text: Next, start_ms: 3000}\n";
        let doc = from_lyricsfile(raw, &track()).unwrap();
        let line = &doc.lines[0];
        assert_eq!(line.end_ms, 3000.0);
        assert_eq!(line.words[1].end_ms, line.end_ms);
        let progress =
            (2500.0 - line.words[1].start_ms) / (line.words[1].end_ms - line.words[1].start_ms);
        assert_eq!(progress, 0.5);
    }
    #[test]
    fn words_cannot_extend_past_an_explicit_or_inferred_line_end() {
        let raw = "version: '1.0'\nmetadata: {offset_ms: 200}\nlines:\n  - text: Hello\n    start_ms: 1000\n    end_ms: 2500\n    words: [{text: Hello, start_ms: 1000, end_ms: 9000}]\n  - text: Invalid\n    start_ms: 3000\n    end_ms: 4000\n    words: [{text: Invalid, start_ms: 4500, end_ms: 5000}]\n";
        let doc = from_lyricsfile(raw, &track()).unwrap();
        assert_eq!(doc.lines[0].words[0].end_ms, 2700.0);
        assert!(doc.lines[1].words.is_empty());
        assert_eq!(doc.lines[1].text, "Invalid");
    }
}
