#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
fn main() {
    desktop::run();
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Still is a Windows desktop app. Use `npm run dev` for the browser preview, or `cargo test` for the portable core.");
}
