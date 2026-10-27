use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use still_core::{engine::Engine, model::*, server};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

async fn setup() -> (
    Arc<Engine>,
    String,
    tokio::task::JoinHandle<()>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let (engine, _) = Engine::new(dir.path().to_path_buf(), dir.path().to_path_buf()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    let e = engine.clone();
    let task = tokio::spawn(async move {
        server::serve_listener(listener, e).await.unwrap();
    });
    (engine, url, task, dir)
}
fn request(url: &str, origin: &str) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut req = url.into_client_request().unwrap();
    req.headers_mut().insert("origin", origin.parse().unwrap());
    req
}
const ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
#[tokio::test]
async fn websocket_requires_extension_origin_and_exact_token() {
    let (e, url, task, _dir) = setup().await;
    assert!(connect_async(request(&url, "https://soundcloud.com"))
        .await
        .is_err());
    let (mut bad, _) = connect_async(request(&url, ORIGIN)).await.unwrap();
    bad.send(Message::Text(
        json!({"type":"auth","token":"b".repeat(64)})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    assert!(bad
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("Неверный токен"));
    assert!(!e.state().connected);
    let (mut client, _) = connect_async(request(&url, ORIGIN)).await.unwrap();
    client
        .send(Message::Text(
            json!({"type":"auth","token":e.token().unwrap()})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert!(client
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("ready"));
    assert!(e.state().connected);
    client
        .send(Message::Text(json!({"type":"ping"}).to_string().into()))
        .await
        .unwrap();
    assert!(client
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("pong"));
    e.rotate_token().unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!e.state().connected);
    task.abort();
}
#[tokio::test]
async fn cache_backed_playback_and_audio_rejection_are_real_protocol_operations() {
    let (e, url, task, _dir) = setup().await;
    let track = Track {
        source: "soundcloud".into(),
        id: "https://soundcloud.com/artist/song".into(),
        title: "Song".into(),
        artist: "Artist".into(),
        artwork: None,
        duration_ms: 180000.0,
    };
    let doc = LyricsDocument {
        track_key: track.key(),
        source: "lrclib".into(),
        sync: "line".into(),
        lines: vec![LyricLine {
            text: "Hello".into(),
            start_ms: 1000.0,
            end_ms: 3000.0,
            words: vec![],
        }],
        plain: "Hello".into(),
        coverage: vec![Coverage {
            start_ms: 0.0,
            end_ms: 180000.0,
        }],
        approximate: false,
    };
    e.store.lock().unwrap().save_lyrics(&doc).unwrap();
    let (mut client, _) = connect_async(request(&url, ORIGIN)).await.unwrap();
    client
        .send(Message::Text(
            json!({"type":"auth","token":e.token().unwrap()})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    client.next().await.unwrap().unwrap();
    let snapshot = PlaybackSnapshot {
        track,
        position_ms: 2000.0,
        playback_rate: 1.0,
        status: "playing".into(),
        observed_at_ms: now_ms(),
        sequence: 1,
        epoch: "test-epoch".into(),
    };
    client
        .send(Message::Text(
            json!({"type":"snapshot","snapshot":snapshot})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while e.state().lyrics.is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(e.state().lyrics.unwrap().plain, "Hello");
    assert_eq!(e.state().playback.unwrap().position_ms, 2000.0);
    client
        .send(Message::Binary(vec![0; 10].into()))
        .await
        .unwrap();
    assert!(client
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("audio-rejected"));
    assert!(e.choose(1, "old-track").is_err());
    client
        .send(Message::Text(
            json!({"type":"capture-start", "captureId":"request-a"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let response: serde_json::Value =
        serde_json::from_str(client.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(response["type"], "capture-error");
    assert_eq!(response["captureId"], "request-a");
    // A living browser connection must not keep a removed song alive. Ping is
    // an ordering barrier proving that player-stopped was consumed first.
    client
        .send(Message::Text(
            json!({"type":"player-stopped"}).to_string().into(),
        ))
        .await
        .unwrap();
    client
        .send(Message::Text(json!({"type":"ping"}).to_string().into()))
        .await
        .unwrap();
    let reply = client.next().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(reply.to_text().unwrap()).unwrap()["type"],
        "pong"
    );
    assert!(e.state().connected);
    assert!(e.state().playback.is_none());
    assert!(e.state().lyrics.is_none());
    assert_eq!(e.state().lyrics_status, "idle");
    task.abort();
}
