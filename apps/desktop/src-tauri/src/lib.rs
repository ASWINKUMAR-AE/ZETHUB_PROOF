//! Minimal Tauri 2 shell. Verification logic runs in the TypeScript backend;
//! the shell only hosts the desktop web UI and the local loopback API is
//! started separately (`npm run start` or the bundled launcher documented in
//! docs/windows.md). No native verification claims are made by this crate.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running ZetHub Proof");
}
