use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::time::Duration;
use still_core::{engine::Engine, server};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

#[tokio::test]
async fn another_browser_cannot_steal_the_active_session_and_disconnect_releases_it() {
    let directory = tempfile::tempdir().unwrap();
    let (engine, _) = Engine::new(
        directory.path().to_path_buf(),
        directory.path().to_path_buf(),
    )
    .unwrap();
    let token = engine.token().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    let e = engine.clone();
    let task = tokio::spawn(server::serve_listener(listener, e));
    let request = || {
        let mut r = url.as_str().into_client_request().unwrap();
        r.headers_mut().insert(
            "origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
                .parse()
                .unwrap(),
        );
        r
    };
    let auth = || Message::Text(json!({"type":"auth","token":token}).to_string().into());
    let (mut first, _) = connect_async(request()).await.unwrap();
    first.send(auth()).await.unwrap();
    assert!(first
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("ready"));
    let generation = engine
        .client_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let (mut second, _) = connect_async(request()).await.unwrap();
    second.send(auth()).await.unwrap();
    assert!(second
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("другому браузеру"));
    assert_eq!(
        generation,
        engine
            .client_generation
            .load(std::sync::atomic::Ordering::SeqCst)
    );
    first
        .send(Message::Text(json!({"type":"ping"}).to_string().into()))
        .await
        .unwrap();
    assert!(first
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("pong"));
    first.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while engine.state().connected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let (mut third, _) = connect_async(request()).await.unwrap();
    third.send(auth()).await.unwrap();
    assert!(third
        .next()
        .await
        .unwrap()
        .unwrap()
        .to_text()
        .unwrap()
        .contains("ready"));
    third.close(None).await.unwrap();
    task.abort();
    let _ = task.await;
}
