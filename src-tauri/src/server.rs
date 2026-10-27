use crate::{
    ai::{AudioChunk, AudioHeader},
    engine::Engine,
    model::PlaybackSnapshot,
};
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, time::timeout};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        protocol::WebSocketConfig,
        Message,
    },
};

pub const PORT: u16 = 18765;
struct SessionGuard {
    engine: Arc<Engine>,
    generation: u64,
}
impl Drop for SessionGuard {
    fn drop(&mut self) {
        if self.engine.client_generation.load(Ordering::SeqCst) == self.generation {
            self.engine.set_connected(false);
        }
    }
}
pub fn valid_origin(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}
pub fn authenticated_token(expected: &str, actual: &str) -> bool {
    expected.len() == 64
        && actual.len() == 64
        && bool::from(expected.as_bytes().ct_eq(actual.as_bytes()))
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ClientMessage {
    Auth {
        token: String,
    },
    Snapshot {
        snapshot: PlaybackSnapshot,
    },
    Ping,
    CaptureStart {
        #[serde(rename = "captureId")]
        capture_id: Option<String>,
    },
    CaptureStop {
        #[serde(rename = "captureId")]
        capture_id: Option<String>,
    },
    PlayerStopped,
    AudioStart {
        header: AudioHeader,
    },
}
pub async fn serve(engine: Arc<Engine>) -> Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, PORT)).await?;
    serve_listener(listener, engine).await
}
pub async fn serve_listener(listener: TcpListener, engine: Arc<Engine>) -> Result<()> {
    let port = listener.local_addr()?.port();
    let slots = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        let (stream, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let e = engine.clone();
        tokio::spawn(async move {
            let _slot = slot;
            let _ = connection(stream, e, port).await;
        });
    }
}
#[allow(clippy::result_large_err)] // The tungstenite API fixes the HTTP callback error type.
async fn connection(stream: tokio::net::TcpStream, e: Arc<Engine>, port: u16) -> Result<()> {
    let mut origin = String::new();
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(350000);
    config.max_frame_size = Some(350000);
    let mut socket = timeout(
        Duration::from_secs(5),
        accept_hdr_async_with_config(
            stream,
            |request: &Request,
             response: Response|
             -> std::result::Result<Response, ErrorResponse> {
                let o = request
                    .headers()
                    .get("origin")
                    .and_then(|h| h.to_str().ok())
                    .unwrap_or("");
                let host = request
                    .headers()
                    .get("host")
                    .and_then(|h| h.to_str().ok())
                    .unwrap_or("");
                if !valid_origin(o)
                    || !e.origin_allowed(o)
                    || host != format!("127.0.0.1:{port}")
                    || request.uri().path() != "/"
                {
                    return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(403)
                        .body(Some("Forbidden".into()))
                        .unwrap());
                }
                origin = o.to_string();
                Ok(response)
            },
            Some(config),
        ),
    )
    .await??;
    let first = timeout(Duration::from_secs(5), socket.next())
        .await?
        .context("Closed")??;
    anyhow::ensure!(
        first.is_text() && first.len() < 512,
        "Authentication required"
    );
    let ClientMessage::Auth { token } = serde_json::from_str(first.to_text()?)? else {
        anyhow::bail!("Authentication required")
    };
    if !authenticated_token(&e.token()?, &token) {
        socket
            .send(Message::Text(
                json!({"type":"error","message":"Неверный токен сопряжения"})
                    .to_string()
                    .into(),
            ))
            .await?;
        anyhow::bail!("Authentication failed");
    }
    e.bind_origin(&origin)?;
    let claimed = {
        let mut view = e.view.lock().unwrap();
        if view.connected {
            false
        } else {
            view.connected = true;
            true
        }
    };
    if !claimed {
        socket.send(Message::Text(json!({"type":"error","message":"Still уже подключён к другому браузеру. Отключите его расширение, чтобы сменить источник."}).to_string().into())).await?;
        anyhow::bail!("Another browser is already connected");
    }
    // A new authenticated connection never inherits permission to capture audio.
    e.stop_capture();
    let generation = e.client_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let _session = SessionGuard {
        engine: e.clone(),
        generation,
    };
    e.set_connected(true);
    socket
        .send(Message::Text(
            json!({"type":"ready","protocol":1}).to_string().into(),
        ))
        .await?;
    let mut controls = e.controls.subscribe();
    let mut pending: Option<AudioHeader> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut last_seen = std::time::Instant::now();
    let result:Result<()>=async{
        loop{
            tokio::select!{
                _=tick.tick()=>{if e.client_generation.load(Ordering::SeqCst)!=generation||last_seen.elapsed()>Duration::from_secs(12){break;}},
                command=controls.recv()=>{if let Ok(command)=command{socket.send(Message::Text(serde_json::to_string(&command)?.into())).await?;}},
                msg=socket.next()=>{
                    let Some(msg)=msg else{break};let msg=msg?;last_seen=std::time::Instant::now();
                    if e.client_generation.load(Ordering::SeqCst)!=generation{break;}
                    if let Message::Binary(bytes)=msg{
                        let result=if let Some(header)=pending.take(){e.queue_audio(AudioChunk{header,pcm:bytes.to_vec()})}else{Err(anyhow::anyhow!("Нет заголовка аудио"))};
                        let message=match result{Ok(())=>json!({"type":"audio-accepted"}),Err(err)=>json!({"type":"audio-rejected","message":err.to_string()})};socket.send(Message::Text(message.to_string().into())).await?;
                    }else if let Message::Text(text)=msg{
                        anyhow::ensure!(text.len()<=12000,"Message too large");
                        let parsed:ClientMessage=serde_json::from_str(&text)?;
                        let result=match parsed{
                            ClientMessage::Snapshot{snapshot}=>e.receive(snapshot),ClientMessage::Ping=>{socket.send(Message::Text(json!({"type":"pong"}).to_string().into())).await?;Ok(())},
                            ClientMessage::CaptureStart{capture_id}=>{let r=e.capture_start(capture_id.clone());let m=match &r{Ok(())=>json!({"type":"capture-ready","captureId":capture_id}),Err(err)=>json!({"type":"capture-error","captureId":capture_id,"message":err.to_string()})};socket.send(Message::Text(m.to_string().into())).await?;Ok(())},
                            ClientMessage::CaptureStop{capture_id}=>{e.stop_capture_from_client(capture_id.as_deref());Ok(())},
                            ClientMessage::PlayerStopped=>{pending=None;e.clear_player();Ok(())},
                            ClientMessage::AudioStart{header}=>{anyhow::ensure!(pending.is_none(),"Unexpected audio header");pending=Some(header);Ok(())},
                            ClientMessage::Auth{..}=>Err(anyhow::anyhow!("Already authenticated")),
                        };
                        if let Err(err)=result{socket.send(Message::Text(json!({"type":"error","message":err.to_string()}).to_string().into())).await?;}
                    }else if msg.is_close(){break;}
                }
            }
        }Ok(())
    }.await;
    let _ = socket.close(None).await;
    result
}
use anyhow::Context;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_web_origins_and_fake_extension_ids() {
        assert!(valid_origin(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
        ));
        for bad in [
            "https://soundcloud.com",
            "http://localhost",
            "chrome-extension://bad",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        ] {
            assert!(!valid_origin(bad));
        }
    }
    #[test]
    fn tokens_are_exact_and_nonempty() {
        let token = "a".repeat(64);
        assert!(authenticated_token(&token, &token));
        assert!(!authenticated_token(&token, &"b".repeat(64)));
        assert!(!authenticated_token("", ""));
    }
}
