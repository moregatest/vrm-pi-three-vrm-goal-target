// Standalone autonomous VRM desktop pet.
// A background thread samples the system every 2s, runs the pure rules engine,
// and emits `vrm-event`s to the webview (the three-vrm runtime reacts). Two
// Tauri commands expose runtime VRM swapping.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod rules;
mod sensors;

use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Where the `.vrm` files live. Built app: bundled resource; dev: project public/.
fn avatars_dir(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        for cand in [
            res.join("avatars"),
            res.join("public").join("avatars"),
            res.join("_up_").join("public").join("avatars"), // Tauri maps "../" to "_up_"
        ] {
            if cand.is_dir() {
                return cand;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/avatars")
}

#[tauri::command]
fn list_avatars(app: AppHandle) -> Vec<String> {
    let dir = avatars_dir(&app);
    let mut names = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.to_lowercase().ends_with(".vrm") {
                names.push(n);
            }
        }
    }
    names.sort();
    names
}

#[tauri::command]
fn load_avatar(app: AppHandle, name: String) {
    let _ = app.emit(
        "vrm-event",
        serde_json::json!({ "type": "load", "url": format!("/avatars/{}", name) }),
    );
}

fn emit_json(app: &AppHandle, v: serde_json::Value) {
    let _ = app.emit("vrm-event", v);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_avatars, load_avatar])
        .setup(|app| {
            let handle = app.handle().clone();
            thread::spawn(move || {
                let mut sensors = sensors::Sensors::new();
                let mut mem = rules::RuleMemory::default();

                // a friendly boot greeting
                thread::sleep(Duration::from_millis(1500));
                emit_json(&handle, serde_json::json!({"type":"expression","emotion":"happy"}));
                emit_json(&handle, serde_json::json!({"type":"motion","motion":"wave"}));
                emit_json(&handle, serde_json::json!({"type":"say","text":"Hi! I'll keep an eye on your system."}));

                // autonomous loop: sense -> decide -> act
                loop {
                    thread::sleep(Duration::from_secs(2));
                    let st = sensors.sample();
                    for action in rules::decide(st, &mut mem) {
                        let _ = handle.emit("vrm-event", &action);
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running VRM Pet");
}
