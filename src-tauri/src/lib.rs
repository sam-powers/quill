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

    // --- classify_claude_outcome ---

    #[test]
    fn outcome_clean_exit_no_result_line_is_success() {
        // Exited 0, no result line emitted (e.g. older CLI) → success.
        assert!(classify_claude_outcome(true, Some(0), None, None, "").is_ok());
    }

    #[test]
    fn outcome_clean_exit_success_result_is_success() {
        assert!(classify_claude_outcome(true, Some(0), Some(false), Some("the reply"), "").is_ok());
    }

    #[test]
    fn outcome_exit_zero_but_is_error_is_failure_with_result_message() {
        // The core bug: claude --print exits 0 yet reports a logical error via
        // the result line. We must treat this as a failure and surface the
        // result message, not claim success.
        let err = classify_claude_outcome(
            true,
            Some(0),
            Some(true),
            Some("No conversation found with session ID abc"),
            "",
        )
        .unwrap_err();
        assert_eq!(err, "No conversation found with session ID abc");
    }

    #[test]
    fn outcome_nonzero_exit_falls_back_to_stderr() {
        let err = classify_claude_outcome(false, Some(1), None, None, "boom: something failed\n")
            .unwrap_err();
        assert!(err.contains("boom: something failed"));
    }

    #[test]
    fn outcome_result_message_preferred_over_stderr() {
        let err = classify_claude_outcome(
            true,
            Some(0),
            Some(true),
            Some("usage limit reached"),
            "noisy stderr",
        )
        .unwrap_err();
        assert_eq!(err, "usage limit reached");
    }

    #[test]
    fn outcome_no_message_anywhere_uses_generic_fallback_with_code() {
        let err = classify_claude_outcome(false, Some(127), None, None, "   ").unwrap_err();
        assert!(err.contains("127"));
        assert!(err.contains("without producing a reply"));
    }

    // --- resolve_claude_binary ---

    #[test]
    fn resolve_claude_binary_returns_path_or_actionable_error() {
        // Environment-dependent: on a dev machine with claude installed this
        // resolves to an absolute path; in a bare CI image it returns an error
        // that tells the user how to fix it. Either way it must never panic and
        // the error must be actionable.
        match resolve_claude_binary() {
            Ok(path) => assert!(path.is_absolute() || path.exists()),
            Err(msg) => assert!(msg.contains("claude")),
        }
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

/// Locate the `claude` CLI. A bundled macOS app inherits a minimal PATH from
/// launchd (often without the user's nvm / Homebrew dirs), so a bare
/// `Command::new("claude")` fails with "No such file or directory" even though
/// the binary is installed. We try, in order: (1) the existing PATH (works in
/// `tauri dev` / from a terminal), (2) a list of common install locations, and
/// (3) a login shell, which sources the user's profile and knows the real PATH.
/// Returns an absolute path to the binary, or an error explaining the search.
fn resolve_claude_binary() -> Result<PathBuf, String> {
    // 1. Already on PATH?
    if let Ok(output) = Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
    }

    // 2. Common install locations (nvm picks the highest-versioned node dir).
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from(format!("{home}/.claude/local/claude")),
        PathBuf::from(format!("{home}/.local/bin/claude")),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    let nvm_bin = PathBuf::from(format!("{home}/.nvm/versions/node"));
    if let Ok(entries) = std::fs::read_dir(&nvm_bin) {
        let mut versions: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path().join("bin/claude"))
            .collect();
        versions.sort();
        versions.reverse(); // newest version first
        candidates.extend(versions);
    }
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    // 3. Ask a login shell (sources the user's profile → full PATH).
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    if let Ok(output) = Command::new(&shell)
        .arg("-lic")
        .arg("command -v claude")
        .output()
    {
        if output.status.success() {
            // A login shell may print profile banners; take the last non-empty
            // line, which is `command -v`'s output.
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .rev()
                .map(str::trim)
                .find(|l| !l.is_empty())
            {
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }
    }

    Err(
        "Could not find the `claude` CLI. Install it (https://docs.claude.com/claude-code) \
         and make sure it's on your PATH, then restart Quill."
            .to_string(),
    )
}

/// Decide whether a finished `claude` invocation succeeded, and if not, produce
/// the most useful error message. Pure so it can be unit-tested.
///
/// Success requires BOTH a clean process exit and a non-error result line.
/// `claude --print` exits 0 even on logical failures (auth errors, "no
/// conversation found", usage limits), signalling them only via the result
/// line's `is_error`, so that field is authoritative when present. The error
/// message prefers the result line's text (the actual reason), then stderr,
/// then a generic fallback that at least names the exit code.
fn classify_claude_outcome(
    exit_ok: bool,
    exit_code: Option<i32>,
    result_is_error: Option<bool>,
    result_message: Option<&str>,
    stderr_buf: &str,
) -> Result<(), String> {
    let logical_ok = result_is_error != Some(true);
    if exit_ok && logical_ok {
        return Ok(());
    }

    let stderr_tail = {
        let msg = stderr_buf.trim();
        if msg.is_empty() {
            None
        } else {
            Some(
                msg.lines()
                    .rev()
                    .take(5)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
    };

    let message = result_message
        .map(str::to_string)
        .filter(|m| !m.trim().is_empty())
        .or(stderr_tail)
        .unwrap_or_else(|| {
            let code = exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            format!("claude exited without producing a reply (exit code {code})")
        });
    Err(message)
}

#[tauri::command]
fn spawn_claude_resume(
    app: tauri::AppHandle,
    session_id: String,
    cwd: String,
    prompt: String,
    on_event: Channel<ChunkEvent>,
) -> Result<String, String> {
    let claude_bin = resolve_claude_binary()?;
    let mut cmd = Command::new(&claude_bin);
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
        // The final `result` line reports logical success/failure. `claude
        // --print` exits 0 even on errors (auth failures, "no conversation
        // found", usage limits), signalling them only via `is_error` here — so
        // we must inspect this, not just the process exit code.
        let mut result_is_error: Option<bool> = None;
        let mut result_message: Option<String> = None;
        let stdout_reader = BufReader::new(stdout);
        for line in stdout_reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Terminal result line: { type: "result", is_error: bool,
            //                         subtype: "...", result: "..." }
            if parsed.get("type").and_then(|t| t.as_str()) == Some("result") {
                result_is_error = parsed.get("is_error").and_then(|v| v.as_bool());
                // Prefer the human-readable `result`, fall back to `subtype`.
                result_message = parsed
                    .get("result")
                    .and_then(|v| v.as_str())
                    .or_else(|| parsed.get("subtype").and_then(|v| v.as_str()))
                    .map(|s| s.to_string());
                continue;
            }
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
        let exit_code = status.and_then(|s| s.code());
        let exit_ok = status.map(|s| s.success()).unwrap_or(false);

        if cancelled {
            let _ = on_event.send(ChunkEvent::Cancelled);
        } else {
            match classify_claude_outcome(
                exit_ok,
                exit_code,
                result_is_error,
                result_message.as_deref(),
                &stderr_buf,
            ) {
                Ok(()) => {
                    let _ = on_event.send(ChunkEvent::Done);
                }
                Err(message) => {
                    let _ = on_event.send(ChunkEvent::Error { message });
                }
            }
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

            build_menu(app.handle())?;

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
            has_native_menu,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Build the native application menu and route File-menu clicks to frontend
/// events. The menu mirrors the existing keyboard shortcuts (Cmd/Ctrl+N/O/S,
/// Cmd/Ctrl+Shift+S) so file operations are reachable without knowing them.
fn build_menu(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::Emitter;

    // Quit is a custom item (not PredefinedMenuItem::quit) so Cmd+Q routes
    // through the frontend's unsaved-changes guard; the frontend calls
    // `exit_app` once the document is safe.
    let quit_item = MenuItem::with_id(app, "menu-quit", "Quit Quill", true, Some("CmdOrCtrl+Q"))?;
    let new_item = MenuItem::with_id(app, "menu-new", "New", true, Some("CmdOrCtrl+N"))?;
    let open_item = MenuItem::with_id(app, "menu-open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let save_item = MenuItem::with_id(app, "menu-save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as_item = MenuItem::with_id(
        app,
        "menu-save-as",
        "Save As…",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_item,
            &open_item,
            &PredefinedMenuItem::separator(app)?,
            &save_item,
            &save_as_item,
        ],
    )?;

    // App menu first so macOS shows the standard application menu (with Quit);
    // also provides Edit conveniences (copy/paste/select-all/undo/redo).
    let app_menu = Submenu::with_items(
        app,
        "Quill",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Quill"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])?;
    app.set_menu(menu)?;

    app.on_menu_event(move |app, event| {
        // The menu item id is exactly the event name the frontend listens for.
        let id = event.id().as_ref();
        if matches!(
            id,
            "menu-new" | "menu-open" | "menu-save" | "menu-save-as" | "menu-quit"
        ) {
            let _ = app.emit(id, ());
        }
    });

    Ok(())
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

/// Reports that a real native menu is present. The frontend uses this to yield
/// the file-operation accelerators (New/Open/Save/Save As) to the menu so they
/// don't double-fire. It can't infer this from `__TAURI_INTERNALS__`: the e2e
/// suite mocks that global but has no native menu and must keep handling the
/// shortcuts in JS, so this command (absent from the e2e IPC mock) is the
/// authoritative signal.
#[tauri::command]
fn has_native_menu() -> bool {
    true
}

/// Exit the app unconditionally. The Quit menu item only emits `menu-quit`;
/// the frontend runs its unsaved-changes guard and then calls this.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}
