use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_open_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .blocking_pick_file();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
async fn show_save_dialog(
    app: tauri::AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file().add_filter("Markdown", &["md"]);
    if let Some(name) = default_name {
        builder = builder.set_file_name(name);
    }
    let path = builder.blocking_save_file();
    Ok(path.map(|p| p.to_string()))
}

// ─── Claude Code session integration ────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ChunkEvent {
    Delta { text: String },
    Done,
    Error { message: String },
    Cancelled,
}

struct ChildHandle {
    child: Mutex<Option<std::process::Child>>,
    cancelled: AtomicBool,
}

#[derive(Default)]
struct ChildRegistry(Mutex<HashMap<String, Arc<ChildHandle>>>);

fn claude_projects_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

#[derive(Serialize)]
struct SessionSummary {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "jsonlPath")]
    jsonl_path: String,
    cwd: String,
    title: Option<String>,
    #[serde(rename = "lastUsed")]
    last_used: u64,
}

#[derive(Serialize)]
struct SessionPreview {
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "recentAssistantMessages")]
    recent_assistant_messages: Vec<String>,
}

#[derive(Deserialize)]
struct JsonlRecord {
    #[serde(rename = "type")]
    rec_type: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    message: Option<serde_json::Value>,
}

#[tauri::command]
fn list_claude_sessions() -> Result<Vec<SessionSummary>, String> {
    let dir = claude_projects_dir()?;
    let mut summaries: Vec<SessionSummary> = Vec::new();

    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(summaries),
        Err(e) => return Err(e.to_string()),
    };

    for project_entry in read.flatten() {
        if !project_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let project_path = project_entry.path();
        let session_iter = match std::fs::read_dir(&project_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in session_iter.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let last_used = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let (session_id, cwd, title) = scan_session_head(&path).unwrap_or((
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string(),
                String::new(),
                None,
            ));

            summaries.push(SessionSummary {
                session_id,
                jsonl_path: path.to_string_lossy().to_string(),
                cwd,
                title,
                last_used,
            });
        }
    }

    summaries.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    summaries.truncate(50);
    Ok(summaries)
}

fn scan_session_head(path: &std::path::Path) -> Option<(String, String, Option<String>)> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    let mut bytes_read: usize = 0;
    for line in reader.lines().map_while(Result::ok) {
        bytes_read += line.len();
        if let Ok(rec) = serde_json::from_str::<JsonlRecord>(&line) {
            if session_id.is_none() {
                session_id = rec.session_id;
            }
            if cwd.is_none() {
                if let Some(c) = rec.cwd {
                    if !c.is_empty() {
                        cwd = Some(c);
                    }
                }
            }
            if title.is_none() && rec.rec_type.as_deref() == Some("ai-title") {
                title = rec.ai_title;
            }
        }
        if session_id.is_some() && cwd.is_some() && title.is_some() {
            break;
        }
        if bytes_read > 65_536 {
            break;
        }
    }
    Some((session_id?, cwd.unwrap_or_default(), title))
}

#[tauri::command]
fn read_claude_session_preview(jsonl_path: String) -> Result<SessionPreview, String> {
    let path = PathBuf::from(&jsonl_path);
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut assistant_texts: Vec<String> = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        let rec: JsonlRecord = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if session_id.is_empty() {
            if let Some(id) = &rec.session_id {
                session_id = id.clone();
            }
        }
        if cwd.is_empty() {
            if let Some(c) = &rec.cwd {
                if !c.is_empty() {
                    cwd = c.clone();
                }
            }
        }
        if rec.rec_type.as_deref() == Some("assistant") {
            if let Some(msg) = &rec.message {
                if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                    let mut text = String::new();
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                            }
                        }
                    }
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        let mut chars = trimmed.chars();
                        let snippet: String = chars.by_ref().take(400).collect();
                        let suffix = if chars.next().is_some() { "…" } else { "" };
                        assistant_texts.push(format!("{}{}", snippet, suffix));
                    }
                }
            }
        }
    }

    let recent: Vec<String> = assistant_texts.into_iter().rev().take(5).collect();

    Ok(SessionPreview {
        session_id,
        cwd,
        recent_assistant_messages: recent,
    })
}

#[tauri::command]
fn spawn_claude_resume(
    app: tauri::AppHandle,
    session_id: String,
    cwd: String,
    prompt: String,
    on_event: Channel<ChunkEvent>,
) -> Result<String, String> {
    let mut cmd = Command::new("claude");
    cmd.arg("--resume")
        .arg(&session_id)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg(&prompt)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn claude: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr handle".to_string())?;

    let token = uuid::Uuid::new_v4().to_string();
    let handle = Arc::new(ChildHandle {
        child: Mutex::new(Some(child)),
        cancelled: AtomicBool::new(false),
    });
    {
        let registry = app.state::<ChildRegistry>();
        registry.0.lock().unwrap().insert(token.clone(), handle.clone());
    }

    let token_for_thread = token.clone();
    let app_for_thread = app.clone();

    std::thread::spawn(move || {
        let mut any_delta = false;
        let stdout_reader = BufReader::new(stdout);
        for line in stdout_reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Partial messages: { type: "stream_event", event: { type: "content_block_delta",
            //                     delta: { type: "text_delta", text: "..." } } }
            if parsed.get("type").and_then(|t| t.as_str()) == Some("stream_event") {
                if let Some(text) = parsed
                    .pointer("/event/delta/text")
                    .and_then(|v| v.as_str())
                {
                    any_delta = true;
                    let _ = on_event.send(ChunkEvent::Delta {
                        text: text.to_string(),
                    });
                    continue;
                }
            }
            // Final assistant message — only emit if we never saw deltas (fallback).
            if !any_delta && parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                if let Some(content) = parsed.pointer("/message/content").and_then(|c| c.as_array())
                {
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                let _ = on_event.send(ChunkEvent::Delta {
                                    text: t.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }

        let mut stderr_buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut stderr_buf);

        let status = {
            let mut child_lock = handle.child.lock().unwrap();
            child_lock.as_mut().and_then(|c| c.wait().ok())
        };

        let cancelled = handle.cancelled.load(Ordering::SeqCst);
        if cancelled {
            let _ = on_event.send(ChunkEvent::Cancelled);
        } else if status.map(|s| s.success()).unwrap_or(false) {
            let _ = on_event.send(ChunkEvent::Done);
        } else {
            let msg = stderr_buf.trim();
            let message = if msg.is_empty() {
                "claude exited with a non-zero status".to_string()
            } else {
                msg.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
            };
            let _ = on_event.send(ChunkEvent::Error { message });
        }

        // Remove from registry on natural completion.
        let registry = app_for_thread.state::<ChildRegistry>();
        registry.0.lock().unwrap().remove(&token_for_thread);
    });

    Ok(token)
}

#[tauri::command]
fn cancel_claude_resume(
    cancel_token: String,
    registry: State<'_, ChildRegistry>,
) -> Result<(), String> {
    let entry = registry.0.lock().unwrap().remove(&cancel_token);
    if let Some(handle) = entry {
        handle.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = handle.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(ChildRegistry::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            delete_file,
            show_open_dialog,
            show_save_dialog,
            list_claude_sessions,
            read_claude_session_preview,
            spawn_claude_resume,
            cancel_claude_resume,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
