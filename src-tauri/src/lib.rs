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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // --- read_file ---

    #[test]
    fn read_file_returns_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.md");
        fs::write(&path, "# Hello Quill").unwrap();

        let result = read_file(path.to_str().unwrap().to_string());
        assert_eq!(result.unwrap(), "# Hello Quill");
    }

    #[test]
    fn read_file_returns_err_for_missing_file() {
        let result = read_file("/tmp/quill_test_nonexistent_xyz_abc.md".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn read_file_returns_empty_string_for_empty_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty.md");
        fs::write(&path, "").unwrap();

        let result = read_file(path.to_str().unwrap().to_string());
        assert_eq!(result.unwrap(), "");
    }

    // --- write_file ---

    #[test]
    fn write_file_creates_file_with_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("output.md");

        write_file(path.to_str().unwrap().to_string(), "# Written".to_string()).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "# Written");
    }

    #[test]
    fn write_file_creates_intermediate_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("file.md");

        write_file(
            path.to_str().unwrap().to_string(),
            "deep content".to_string(),
        )
        .unwrap();

        assert!(path.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "deep content");
    }

    #[test]
    fn write_file_overwrites_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("overwrite.md");
        fs::write(&path, "old content").unwrap();

        write_file(
            path.to_str().unwrap().to_string(),
            "new content".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
    }

    #[test]
    fn write_file_handles_unicode_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unicode.md");

        write_file(
            path.to_str().unwrap().to_string(),
            "# 日本語\nHello 🌍".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "# 日本語\nHello 🌍");
    }

    // --- delete_file ---

    #[test]
    fn delete_file_removes_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("to_delete.md");
        fs::write(&path, "bye").unwrap();
        assert!(path.exists());

        delete_file(path.to_str().unwrap().to_string()).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn delete_file_is_ok_when_file_does_not_exist() {
        let result = delete_file("/tmp/quill_test_never_existed_xyz_abc.md".to_string());
        assert!(result.is_ok());
    }

    #[test]
    fn delete_file_does_not_affect_other_files_in_directory() {
        let dir = tempdir().unwrap();
        let path1 = dir.path().join("file1.md");
        let path2 = dir.path().join("file2.md");
        fs::write(&path1, "one").unwrap();
        fs::write(&path2, "two").unwrap();

        delete_file(path1.to_str().unwrap().to_string()).unwrap();

        assert!(!path1.exists());
        assert!(path2.exists());
    }
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

/// Holds a deep-link path that arrived before the frontend was ready to receive
/// the `deep-link-open` event. On a cold start macOS launches the app *because*
/// of the `quill://open?file=…` URL, and `on_open_url` fires during `.setup()`
/// — before the WebView has mounted and registered its listener — so the emit is
/// dropped. We stash the path here and let the frontend pull it on mount via
/// `take_pending_deep_link`.
#[derive(Default)]
struct PendingDeepLink(Mutex<Option<String>>);

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
    #[serde(rename = "isCompactSummary")]
    is_compact_summary: Option<bool>,
}

#[derive(Serialize)]
struct AutoBindResult {
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "linkedAt")]
    linked_at: String,
}

#[derive(Serialize)]
struct CompactionInfo {
    compacted: bool,
    #[serde(rename = "originalMarkdown")]
    original_markdown: Option<String>,
}

fn assistant_text(msg: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
        }
    }
    out
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Plain ISO-8601 (UTC). Crude but enough for sidecar timestamps.
    let days_from_epoch = secs / 86400;
    let secs_in_day = secs % 86400;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    // Use chrono-free approximation: relies on serde elsewhere having stricter dates.
    let (y, mo, d) = days_to_ymd(days_from_epoch as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
}

fn days_to_ymd(mut days: i64) -> (i64, u32, u32) {
    // 1970-01-01 = day 0
    let mut year = 1970i64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let year_days = if leap { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_lengths = [
        31u32,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    let mut d = days as u32;
    for &ml in month_lengths.iter() {
        if d < ml {
            break;
        }
        d -= ml;
        month += 1;
    }
    (year, month, d + 1)
}

#[tauri::command]
fn find_session_for_markdown(content: String) -> Result<Option<AutoBindResult>, String> {
    // Normalize the search text — trim trailing whitespace and require it to be
    // non-trivial so we don't auto-bind on empty/near-empty docs.
    let needle_raw = content.trim();
    if needle_raw.len() < 80 {
        return Ok(None);
    }
    let needle = needle_raw.to_string();

    let dir = claude_projects_dir()?;
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let mut candidates: Vec<(std::path::PathBuf, u64)> = Vec::new();
    for project_entry in read.flatten() {
        if !project_entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let session_iter = match std::fs::read_dir(project_entry.path()) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in session_iter.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }
            let last_used = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            candidates.push((path, last_used));
        }
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.1));
    // Cap to the 50 most-recent sessions to keep the scan bounded.
    candidates.truncate(50);

    let mut matches: Vec<AutoBindResult> = Vec::new();
    for (path, _) in &candidates {
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(file);
        let mut sess_id = String::new();
        let mut sess_cwd = String::new();
        let mut found = false;
        for line in reader.lines().map_while(Result::ok) {
            let rec: JsonlRecord = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if sess_id.is_empty() {
                if let Some(id) = &rec.session_id {
                    sess_id = id.clone();
                }
            }
            if sess_cwd.is_empty() {
                if let Some(c) = &rec.cwd {
                    if !c.is_empty() {
                        sess_cwd = c.clone();
                    }
                }
            }
            if rec.rec_type.as_deref() == Some("assistant") {
                if let Some(msg) = &rec.message {
                    let text = assistant_text(msg);
                    if !text.is_empty() && text.contains(&needle) {
                        found = true;
                        break;
                    }
                }
            }
        }
        if found && !sess_id.is_empty() {
            matches.push(AutoBindResult {
                session_id: sess_id,
                cwd: sess_cwd,
                linked_at: iso_now(),
            });
            if matches.len() > 1 {
                // More than one match → ambiguous, don't auto-bind.
                return Ok(None);
            }
        }
    }

    Ok(matches.into_iter().next())
}

#[tauri::command]
fn check_session_compacted(session_id: String) -> Result<CompactionInfo, String> {
    // Find the jsonl that contains this session id.
    let dir = claude_projects_dir()?;
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CompactionInfo {
                compacted: false,
                original_markdown: None,
            });
        }
        Err(e) => return Err(e.to_string()),
    };

    let mut target: Option<std::path::PathBuf> = None;
    'outer: for project_entry in read.flatten() {
        let session_iter = match std::fs::read_dir(project_entry.path()) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in session_iter.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }
            if path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s == session_id)
                .unwrap_or(false)
            {
                target = Some(path);
                break 'outer;
            }
        }
    }

    let Some(path) = target else {
        return Ok(CompactionInfo {
            compacted: false,
            original_markdown: None,
        });
    };

    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut compacted = false;
    let mut last_assistant_markdown: Option<String> = None;
    for line in reader.lines().map_while(Result::ok) {
        let rec: JsonlRecord = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rec.is_compact_summary.unwrap_or(false)
            || rec.rec_type.as_deref() == Some("compact_summary")
            || rec.rec_type.as_deref() == Some("compaction")
        {
            compacted = true;
        }
        if rec.rec_type.as_deref() == Some("assistant") {
            if let Some(msg) = &rec.message {
                let text = assistant_text(msg);
                if text.contains("```") || text.lines().count() > 3 {
                    last_assistant_markdown = Some(text);
                }
            }
        }
    }

    Ok(CompactionInfo {
        compacted,
        original_markdown: if compacted {
            None
        } else {
            last_assistant_markdown
        },
    })
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
        if !project_entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false)
        {
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

    summaries.sort_by_key(|s| std::cmp::Reverse(s.last_used));
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;
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
        registry
            .0
            .lock()
            .unwrap()
            .insert(token.clone(), handle.clone());
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
                if let Some(text) = parsed.pointer("/event/delta/text").and_then(|v| v.as_str()) {
                    any_delta = true;
                    let _ = on_event.send(ChunkEvent::Delta {
                        text: text.to_string(),
                    });
                    continue;
                }
            }
            // Final assistant message — only emit if we never saw deltas (fallback).
            if !any_delta && parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                if let Some(content) = parsed
                    .pointer("/message/content")
                    .and_then(|c| c.as_array())
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
                msg.lines()
                    .rev()
                    .take(5)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
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
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            app.manage(ChildRegistry::default());
            app.manage(PendingDeepLink::default());

            use tauri::Emitter;
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(path) = parse_quill_open(url.as_str()) {
                        // Buffer for cold start (frontend not yet listening) and
                        // also emit for the warm-start case where it is.
                        if let Some(pending) = handle.try_state::<PendingDeepLink>() {
                            *pending.0.lock().unwrap() = Some(path.clone());
                        }
                        let _ = handle.emit("deep-link-open", path);
                    }
                }
            });
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
            find_session_for_markdown,
            check_session_compacted,
            handle_deep_link,
            take_pending_deep_link,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn parse_quill_open(url: &str) -> Option<String> {
    // Expected form: quill://open?file=<urlencoded path>
    let rest = url.strip_prefix("quill://")?;
    let (host, query) = rest.split_once('?')?;
    if host != "open" {
        return None;
    }
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("file=") {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn handle_deep_link(url: String) -> Result<Option<String>, String> {
    Ok(parse_quill_open(&url))
}

/// Returns and clears any deep-link path buffered during a cold start. The
/// frontend calls this once on mount to recover a launch URL whose
/// `deep-link-open` emit was dropped because no listener existed yet.
#[tauri::command]
fn take_pending_deep_link(pending: State<'_, PendingDeepLink>) -> Result<Option<String>, String> {
    Ok(pending.0.lock().unwrap().take())
}
