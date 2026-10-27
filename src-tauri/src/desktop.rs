use std::{sync::Arc, time::Duration};
use still_core::{
    engine::Engine,
    model::{Settings, ViewState},
    server,
};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn get_state(engine: tauri::State<'_, Arc<Engine>>) -> ViewState {
    engine.state()
}
#[tauri::command]
fn pairing_token(engine: tauri::State<'_, Arc<Engine>>) -> Result<String, String> {
    engine.token().map_err(|e| e.to_string())
}
#[tauri::command]
fn rotate_token(engine: tauri::State<'_, Arc<Engine>>) -> Result<String, String> {
    engine.rotate_token().map_err(|e| e.to_string())
}
#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    engine: tauri::State<'_, Arc<Engine>>,
    mut settings: Settings,
) -> Result<(), String> {
    remember_position(&app, &mut settings);
    engine.save_settings(settings).map_err(|e| e.to_string())?;
    apply_overlay(&app, &engine.state().settings).map_err(|e| e.to_string())
}
#[tauri::command]
fn choose_lyrics(
    engine: tauri::State<'_, Arc<Engine>>,
    id: u64,
    track_key: String,
) -> Result<(), String> {
    engine.choose(id, &track_key).map_err(|e| e.to_string())
}
#[tauri::command]
async fn retry_lyrics(engine: tauri::State<'_, Arc<Engine>>) -> Result<(), String> {
    engine.inner().retry();
    Ok(())
}
#[tauri::command]
async fn download_model(engine: tauri::State<'_, Arc<Engine>>) -> Result<(), String> {
    engine.inner().download_model().map_err(|e| e.to_string())
}
#[tauri::command]
fn stop_capture(engine: tauri::State<'_, Arc<Engine>>) {
    engine.stop_capture();
}
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("soundcloud.com" | "genius.com"))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Недопустимая ссылка".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
fn apply_overlay(app: &tauri::AppHandle, settings: &Settings) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("overlay") {
        w.set_always_on_top(true)?;
        w.set_skip_taskbar(true)?;
        w.set_ignore_cursor_events(settings.locked)?;
        w.set_focusable(!settings.locked)?;
        let current = w.inner_size()?.to_logical::<f64>(w.scale_factor()?);
        if (current.width - settings.width).abs() > 1.0
            || (current.height - settings.height).abs() > 1.0
        {
            w.set_size(LogicalSize::new(settings.width, settings.height))?;
        }
        // TOOLWINDOW keeps it out of Alt+Tab, NOACTIVATE preserves the working app's focus.
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::*;
            let hwnd = w.hwnd()?.0 as _;
            let mut flags = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            flags = (flags | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize);
            if settings.locked {
                flags |= WS_EX_NOACTIVATE as isize;
            } else {
                flags &= !(WS_EX_NOACTIVATE as isize);
            }
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, flags);
        }
        if settings.visible {
            w.show()?;
        } else {
            w.hide()?;
        }
    }
    Ok(())
}
fn show_settings(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
fn change_setting(app: &tauri::AppHandle, change: impl FnOnce(&mut Settings)) {
    let e = app.state::<Arc<Engine>>();
    let mut s = e.state().settings;
    remember_position(app, &mut s);
    change(&mut s);
    if let Err(err) = e.save_settings(s.clone()) {
        e.error(err);
    } else if let Err(err) = apply_overlay(app, &s) {
        e.error(err);
    }
}
fn remember_position(app: &tauri::AppHandle, settings: &mut Settings) {
    if let Some(w) = app.get_webview_window("overlay") {
        if let Ok(position) = w.outer_position() {
            settings.x = Some(position.x as f64);
            settings.y = Some(position.y as f64);
        }
    }
}
fn tray_image() -> tauri::image::Image<'static> {
    let mut rgba = vec![0; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let i = (y * 32 + x) * 4;
            let inside = (x as i32 - 16).pow(2) + (y as i32 - 16).pow(2) < 225;
            let wave = inside
                && [8, 13, 18, 23].iter().any(|&a| {
                    x >= a
                        && x < a + 2
                        && (y as i32 - 16).abs() < if a == 13 || a == 18 { 9 } else { 5 }
                });
            rgba[i..i + 4].copy_from_slice(if wave {
                &[23, 16, 10, 255]
            } else if inside {
                &[255, 122, 26, 255]
            } else {
                &[0, 0, 0, 0]
            });
        }
    }
    tauri::image::Image::new_owned(rgba, 32, 32)
}
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyL) {
                        change_setting(app, |s| s.visible = !s.visible);
                    }
                    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyE) {
                        change_setting(app, |s| s.locked = !s.locked);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_state,
            pairing_token,
            rotate_token,
            save_settings,
            choose_lyrics,
            retry_lyrics,
            download_model,
            stop_capture,
            open_external
        ])
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            // Development builds share the same resource layout as the installer.
            let resources = if resources.join("binaries").exists() {
                resources
            } else {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            };
            let (engine, rx) = Engine::new(app.path().app_data_dir()?, resources)?;
            let handle = app.handle().clone();
            engine.on_change(move |state| {
                let _ = handle.emit("state", state);
            });
            app.manage(engine.clone());
            let s = engine.state().settings;
            let overlay = WebviewWindowBuilder::new(
                app,
                "overlay",
                WebviewUrl::App("index.html?window=overlay".into()),
            )
            .title("Still Lyrics")
            .inner_size(s.width, s.height)
            .min_inner_size(280.0, 240.0)
            .max_inner_size(720.0, 900.0)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            .resizable(false)
            .effects(
                tauri::window::EffectsBuilder::new()
                    .effect(tauri::window::Effect::Acrylic)
                    .color(tauri::window::Color(12, 12, 12, 160))
                    .build(),
            )
            .build()?;
            let mut positioned = s.clone();
            if let Some(monitor) = overlay.primary_monitor()? {
                let scale = monitor.scale_factor();
                let size = monitor.size();
                let origin = monitor.position();
                // Restore only if part of the card remains on a connected display.
                let fits = overlay.available_monitors()?.iter().any(|m| {
                    let p = m.position();
                    let z = m.size();
                    let dpi = m.scale_factor();
                    s.x.zip(s.y).is_some_and(|(x, y)| {
                        x + s.width * dpi > p.x as f64 + 50.0
                            && x < p.x as f64 + z.width as f64 - 50.0
                            && y + s.height * dpi > p.y as f64 + 50.0
                            && y < p.y as f64 + z.height as f64 - 50.0
                    })
                });
                if !fits {
                    positioned.x =
                        Some(origin.x as f64 + size.width as f64 - (s.width + 24.0) * scale);
                    positioned.y =
                        Some(origin.y as f64 + (size.height as f64 - s.height * scale) / 2.0);
                    engine.save_settings(positioned.clone())?;
                }
            }
            if let (Some(x), Some(y)) = (positioned.x, positioned.y) {
                overlay.set_position(PhysicalPosition::new(x as i32, y as i32))?;
            }
            apply_overlay(app.handle(), &positioned)?;
            let (settings_width, settings_height) = overlay
                .primary_monitor()?
                .map(|m| {
                    let size = m.size().to_logical::<f64>(m.scale_factor());
                    (
                        (size.width - 80.0).clamp(720.0, 1120.0),
                        (size.height - 100.0).clamp(540.0, 860.0),
                    )
                })
                .unwrap_or((1000.0, 740.0));
            WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
                .title("Still — Live Lyrics")
                .inner_size(settings_width, settings_height)
                .min_inner_size(720.0, 540.0)
                .center()
                .build()?;
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };
            let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
            let toggle = MenuItem::with_id(
                app,
                "toggle",
                "Показать / скрыть · Ctrl+Alt+L",
                true,
                None::<&str>,
            )?;
            let edit = MenuItem::with_id(
                app,
                "edit",
                "Переместить / закрепить · Ctrl+Alt+E",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &toggle, &edit, &quit])?;
            TrayIconBuilder::new()
                .icon(tray_image())
                .tooltip("Still — слова рядом")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => show_settings(app),
                    "toggle" => change_setting(app, |s| s.visible = !s.visible),
                    "edit" => change_setting(app, |s| s.locked = !s.locked),
                    "quit" => {
                        change_setting(app, |_| {});
                        app.state::<Arc<Engine>>().stop_capture();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_settings(tray.app_handle());
                    }
                })
                .build(app)?;
            for shortcut in ["Ctrl+Alt+L", "Ctrl+Alt+E"] {
                if let Err(err) = app.global_shortcut().register(shortcut) {
                    engine.error(format!(
                        "Не удалось зарегистрировать {shortcut}: {err}. Используйте значок в трее."
                    ));
                }
            }
            let e = engine.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = server::serve(e.clone()).await {
                    e.error(format!("Не удалось открыть локальное подключение: {err}"));
                }
            });
            tauri::async_runtime::spawn(engine.clone().audio_loop(rx));
            // Geometry changes are coalesced; dragging does not write SQLite every pixel.
            let e = engine.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    if let Some(w) = handle.get_webview_window("overlay") {
                        let s = e.state().settings;
                        if !s.locked {
                            if let Ok(p) = w.outer_position() {
                                if s.x != Some(p.x as f64) || s.y != Some(p.y as f64) {
                                    let _ = e.save_settings(Settings {
                                        x: Some(p.x as f64),
                                        y: Some(p.y as f64),
                                        ..s
                                    });
                                }
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "settings" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    builder
        .run(tauri::generate_context!())
        .expect("Не удалось запустить Still");
}
