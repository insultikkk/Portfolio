use anyhow::{Context, Result};
use std::io::{self, BufRead, Read, Write};
use still_core::{
    ai::{WorkerRequest, WorkerResponse},
    model::LyricLine,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn main() {
    if let Err(err) = run() {
        eprintln!("Whisper worker: {err}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let path = std::env::args().nth(1).context("Model path is required")?;
    let mut params = WhisperContextParameters::default();
    params.use_gpu(false);
    let context = WhisperContext::new_with_params(&path, params)?;
    let mut state = context.create_state()?;
    let mut input = io::BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    loop {
        let mut header = String::new();
        if input.read_line(&mut header)? == 0 {
            break;
        }
        anyhow::ensure!(header.len() < 1000, "Invalid header");
        let request: WorkerRequest = serde_json::from_str(&header)?;
        anyhow::ensure!(
            (1..=160000).contains(&request.samples),
            "Invalid sample count"
        );
        let mut bytes = vec![0u8; request.samples * 2];
        input.read_exact(&mut bytes)?;
        let mut audio: Vec<f32> = bytes
            .chunks_exact(2)
            .map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0)
            .collect();
        let result = (|| -> Result<Vec<LyricLine>> {
            // Reject silence before ASR; avoid common hallucinations over empty input.
            let rms = (audio.iter().map(|s| s * s).sum::<f32>() / audio.len() as f32).sqrt();
            if rms < 0.003 {
                return Ok(vec![]);
            }
            // Whisper needs a minimum input window. Padding is inference-only:
            // the parent retains the actual sample count for cache coverage.
            audio.resize(audio.len().max(16000), 0.0);
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            let threads =
                std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(1, 4));
            params.set_n_threads(threads as i32);
            params.set_language(None);
            params.set_translate(false);
            params.set_no_context(true);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            params.set_print_special(false);
            state.full(params, &audio)?;
            let mut lines = Vec::new();
            for segment in state.as_iter() {
                let text = segment.to_str_lossy()?.trim().to_string();
                let probabilities: Vec<f32> = (0..segment.n_tokens())
                    .filter_map(|i| segment.get_token(i))
                    .map(|t| t.token_probability())
                    .collect();
                let probability =
                    probabilities.iter().sum::<f32>() / (probabilities.len().max(1) as f32);
                if segment.no_speech_probability() > 0.6
                    || probability < 0.3
                    || text.is_empty()
                    || text.starts_with('[')
                    || text.starts_with('(')
                {
                    continue;
                }
                lines.push(LyricLine {
                    text,
                    start_ms: segment.start_timestamp() as f64 * 10.0,
                    end_ms: segment.end_timestamp() as f64 * 10.0,
                    words: vec![],
                });
            }
            Ok(lines)
        })();
        let response = match result {
            Ok(lines) => WorkerResponse { lines, error: None },
            Err(err) => WorkerResponse {
                lines: vec![],
                error: Some(err.to_string()),
            },
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
