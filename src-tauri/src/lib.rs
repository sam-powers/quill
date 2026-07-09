use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Document-like paths Quill is allowed to touch through the general file
/// commands. These commands are reachable from the frontend (and, via the
/// `quill://` deep link, indirectly from a hostile web page), so they must not
/// be general-purpose filesystem primitives. Every legitimate caller operates
/// on a Markdown document or its `<name>.comments.json` sidecar; confining the
/// commands to those suffixes means a crafted path can never coax Quill into
/// reading `/etc/passwd` or overwriting an arbitrary file. The native open/save
/// dialogs already restrict the user to `.md`, so this loses no real capability.
fn ensure_allowed_path(path: &str) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    let allowed =
        lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".comments.json");
    if allowed {
        Ok(())
    } else {
        Err("Refusing to access a file Quill does not manage".to_string())
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    ensure_allowed_path(&path)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    ensure_allowed_path(&path)?;
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    ensure_allowed_path(&path)?;
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

#[tauri::command]
async fn show_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

/// Path of the crash-recovery draft inside the app data directory. A single
/// draft, not one per document: Quill is a single-window, single-document
/// app, so at most one document can have unsaved changes.
fn draft_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("draft.json"))
}

/// Write-then-rename so a crash mid-write can't leave a truncated draft —
/// the draft exists precisely to survive crashes.
fn write_draft_at(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_draft_at(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_draft_at(path: &std::path::Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn write_draft(app: tauri::AppHandle, content: String) -> Result<(), String> {
    write_draft_at(&draft_file_path(&app)?, &content)
}

#[tauri::command]
fn read_draft(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_draft_at(&draft_file_path(&app)?)
}

#[tauri::command]
fn delete_draft(app: tauri::AppHandle) -> Result<(), String> {
    delete_draft_at(&draft_file_path(&app)?)
}

/// Document-like extensions worth surfacing in the context-folder manifest.
/// The manifest only tells Claude what exists — it reads files itself via
/// `--add-dir` — so this is about keeping the prompt focused, not access.
const CONTEXT_FILE_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "rst", "adoc", "org", "csv", "tsv", "json", "yaml", "yml", "toml",
    "tex", "html", "pdf", "docx",
];

/// Recursively list document files under `root` as sorted, `/`-separated
/// relative paths, capped at `max` entries. Hidden entries and dependency /
/// build directories are skipped so a project folder doesn't flood the prompt.
fn collect_context_files(root: &std::path::Path, max: usize) -> Vec<String> {
    const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__"];
    // Hard bound on how many files we examine, so a pathological folder
    // (huge vendored tree with doc-like extensions) can't hang the scan.
    let scan_limit = max.saturating_mul(50).max(5_000);
    let mut out: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if scanned >= scan_limit {
                stack.clear();
                break;
            }
            scanned += 1;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_ref()) {
                    stack.push(path);
                }
                continue;
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| CONTEXT_FILE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel);
            }
        }
    }
    out.sort();
    out.truncate(max);
    out
}

const MAX_CONTEXT_FILES: usize = 200;

#[tauri::command]
fn list_context_files(folder: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err(format!("Not a folder: {folder}"));
    }
    Ok(collect_context_files(&root, MAX_CONTEXT_FILES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // --- recent menu labels ---

    #[test]
    fn recent_menu_label_uses_file_name() {
        assert_eq!(recent_menu_label("/Users/sam/docs/notes.md"), "notes.md");
        assert_eq!(recent_menu_label("plain.md"), "plain.md");
    }

    #[test]
    fn recent_menu_label_falls_back_to_path() {
        assert_eq!(recent_menu_label("/"), "/");
        assert_eq!(recent_menu_label(""), "");
    }

    // --- draft persistence ---

    #[test]
    fn draft_round_trips_and_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("draft.json");
        assert_eq!(read_draft_at(&path).unwrap(), None);
        write_draft_at(&path, r#"{"version":1}"#).unwrap();
        assert_eq!(
            read_draft_at(&path).unwrap(),
            Some(r#"{"version":1}"#.to_string())
        );
    }

    #[test]
    fn draft_write_overwrites_and_leaves_no_tmp_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("draft.json");
        write_draft_at(&path, "first").unwrap();
        write_draft_at(&path, "second").unwrap();
        assert_eq!(read_draft_at(&path).unwrap(), Some("second".to_string()));
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn draft_delete_removes_file_and_is_ok_when_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("draft.json");
        delete_draft_at(&path).unwrap();
        write_draft_at(&path, "x").unwrap();
        delete_draft_at(&path).unwrap();
        assert_eq!(read_draft_at(&path).unwrap(), None);
    }

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

    // --- path policy (ensure_allowed_path) ---

    #[test]
    fn allowed_paths_accept_documents_and_sidecars() {
        assert!(ensure_allowed_path("/tmp/notes.md").is_ok());
        assert!(ensure_allowed_path("/tmp/notes.markdown").is_ok());
        assert!(ensure_allowed_path("/tmp/notes.comments.json").is_ok());
        // Case-insensitive: macOS paths are commonly mixed-case.
        assert!(ensure_allowed_path("/tmp/NOTES.MD").is_ok());
    }

    #[test]
    fn disallowed_paths_are_rejected() {
        assert!(ensure_allowed_path("/etc/passwd").is_err());
        assert!(ensure_allowed_path("/Users/me/.ssh/id_rsa").is_err());
        // A bare `.json` is not a Quill sidecar.
        assert!(ensure_allowed_path("/tmp/secrets.json").is_err());
        // Suffix games: the real extension is what matters.
        assert!(ensure_allowed_path("/tmp/notes.md.exe").is_err());
    }

    #[test]
    fn confined_commands_refuse_disallowed_paths() {
        // The commands themselves enforce the policy, not just the helper.
        assert!(read_file("/etc/passwd".to_string()).is_err());
        assert!(write_file("/tmp/evil.sh".to_string(), "x".to_string()).is_err());
        assert!(delete_file("/tmp/evil.sh".to_string()).is_err());
    }

    // --- deep-link target validation (parse_quill_open / validate_open_target) ---

    #[test]
    fn deep_link_opens_existing_markdown_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "# Doc").unwrap();
        let url = format!("quill://open?file={}", path.to_str().unwrap());
        let result = parse_quill_open(&url);
        // Canonicalized, so compare against the canonical form.
        let canonical = fs::canonicalize(&path).unwrap();
        assert_eq!(result, Some(canonical.to_string_lossy().into_owned()));
    }

    #[test]
    fn deep_link_rejects_nonexistent_file() {
        let url = "quill://open?file=/tmp/quill_does_not_exist_xyz.md";
        assert_eq!(parse_quill_open(url), None);
    }

    #[test]
    fn deep_link_rejects_non_markdown_target() {
        // The classic attack: point the scheme at a sensitive file.
        let url = "quill://open?file=/etc/passwd";
        assert_eq!(parse_quill_open(url), None);
    }

    #[test]
    fn deep_link_rejects_directory_even_with_md_suffix() {
        let dir = tempdir().unwrap();
        let bogus = dir.path().join("notes.md");
        fs::create_dir(&bogus).unwrap();
        let url = format!("quill://open?file={}", bogus.to_str().unwrap());
        assert_eq!(parse_quill_open(&url), None);
    }

    #[test]
    fn deep_link_rejects_wrong_host() {
        let url = "quill://evil?file=/tmp/whatever.md";
        assert_eq!(parse_quill_open(url), None);
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

    // --- build_child_path ---

    #[test]
    fn child_path_includes_claude_binary_dir() {
        let path = build_child_path(
            Path::new("/Users/x/.nvm/versions/node/v20/bin/claude"),
            None,
            None,
            "/Users/x",
        );
        assert!(path
            .split(':')
            .any(|d| d == "/Users/x/.nvm/versions/node/v20/bin"));
    }

    #[test]
    fn child_path_puts_claude_dir_first() {
        let path = build_child_path(
            Path::new("/opt/claude/bin/claude"),
            Some("/login/a:/login/b"),
            Some("/inherited/c"),
            "/Users/x",
        );
        assert_eq!(path.split(':').next(), Some("/opt/claude/bin"));
    }

    #[test]
    fn child_path_dedups_preserving_first_occurrence() {
        // The same dir appears as the claude dir, in the login PATH, and in the
        // inherited PATH — it must survive exactly once, at its earliest slot.
        let path = build_child_path(
            Path::new("/shared/bin/claude"),
            Some("/shared/bin:/login/only"),
            Some("/shared/bin:/inherited/only"),
            "/Users/x",
        );
        let count = path.split(':').filter(|d| *d == "/shared/bin").count();
        assert_eq!(count, 1);
        assert_eq!(path.split(':').next(), Some("/shared/bin"));
    }

    #[test]
    fn child_path_has_well_known_dirs_without_login_or_inherited() {
        // Worst case: a packaged .app with neither a login-shell PATH nor an
        // inherited PATH still gets a usable PATH from the fallbacks.
        let path = build_child_path(Path::new("/somewhere/claude"), None, None, "/Users/x");
        let dirs: Vec<&str> = path.split(':').collect();
        for expected in [
            "/Users/x/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            assert!(dirs.contains(&expected), "missing {expected} in {path}");
        }
        // No empty segments leak through.
        assert!(
            !dirs.iter().any(|d| d.is_empty()),
            "empty segment in {path}"
        );
    }

    // --- collect_context_files ---

    #[test]
    fn collect_context_files_returns_sorted_relative_paths() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("zebra.md"), "z").unwrap();
        fs::write(dir.path().join("alpha.txt"), "a").unwrap();
        fs::write(dir.path().join("notes").join("inner.md"), "i").unwrap();

        let files = collect_context_files(dir.path(), 200);
        assert_eq!(files, vec!["alpha.txt", "notes/inner.md", "zebra.md"]);
    }

    #[test]
    fn collect_context_files_skips_hidden_and_dependency_dirs() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join(".git").join("config.md"), "x").unwrap();
        fs::write(dir.path().join("node_modules").join("readme.md"), "x").unwrap();
        fs::write(dir.path().join(".hidden.md"), "x").unwrap();
        fs::write(dir.path().join("visible.md"), "x").unwrap();

        let files = collect_context_files(dir.path(), 200);
        assert_eq!(files, vec!["visible.md"]);
    }

    #[test]
    fn collect_context_files_filters_non_document_extensions() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("doc.md"), "x").unwrap();
        fs::write(dir.path().join("image.png"), "x").unwrap();
        fs::write(dir.path().join("binary.exe"), "x").unwrap();
        fs::write(dir.path().join("no_extension"), "x").unwrap();
        fs::write(dir.path().join("UPPER.MD"), "x").unwrap();

        let files = collect_context_files(dir.path(), 200);
        assert_eq!(files, vec!["UPPER.MD", "doc.md"]);
    }

    #[test]
    fn collect_context_files_caps_the_manifest() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("doc{i:02}.md")), "x").unwrap();
        }

        let files = collect_context_files(dir.path(), 3);
        // Capped after sorting, so the result is the first N alphabetically.
        assert_eq!(files, vec!["doc00.md", "doc01.md", "doc02.md"]);
    }

    #[test]
    fn list_context_files_rejects_non_folder() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("file.md");
        fs::write(&file, "x").unwrap();

        assert!(list_context_files(file.to_str().unwrap().to_string()).is_err());
        assert!(list_context_files("/tmp/quill_test_missing_folder_xyz".to_string()).is_err());
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

/// Lock a `Mutex` without panicking on poisoning. These mutexes guard plain data
/// (a process handle, a registry map, a pending path) that stays valid even if a
/// thread panicked while holding the lock, so recovering the inner guard is the
/// right call — far better than propagating a panic out of a process-spawn or
/// deep-link path.
fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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

/// Locate the `~/.claude/projects/*/<session_id>.jsonl` for a session, if it
/// exists on disk yet. `Ok(None)` covers both a missing projects directory and
/// an unknown session id.
fn find_session_jsonl(session_id: &str) -> Result<Option<std::path::PathBuf>, String> {
    let dir = claude_projects_dir()?;
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    for project_entry in read.flatten() {
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
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
fn check_session_compacted(session_id: String) -> Result<CompactionInfo, String> {
    let Some(path) = find_session_jsonl(&session_id)? else {
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

/// Unique marker printed before `$PATH` so we can recover it from stdout even
/// when an interactive shell interleaves profile/rc banners around our output.
const QUILL_PATH_SENTINEL: &str = "___QUILL_PATH___";

/// Run a script in the user's interactive login shell and return captured
/// stdout on success.
///
/// `-ilc`, not `-lc`: **interactive** so `.zshrc` / `.bashrc` are sourced (nvm,
/// fnm, Homebrew, and Volta commonly put their PATH lines there, and a
/// non-interactive login shell skips those files entirely), **login** so profile
/// files are sourced too, and `-c` to run exactly the one script we pass. A
/// shell that errors or can't be spawned yields `None` so callers fall through.
fn login_shell_stdout(script: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(&shell).arg("-ilc").arg(script).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Ask the interactive login shell where `claude` resolves. Returns the file if
/// it names a real executable, else `None`.
fn claude_from_login_shell() -> Option<PathBuf> {
    // A login shell may print profile banners; take the *last* non-empty line,
    // which is `command -v`'s output, then only trust a real file — never an
    // arbitrary line of shell output handed to Command::new.
    let stdout = login_shell_stdout("command -v claude")?;
    let path = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| !l.is_empty())?;
    let candidate = PathBuf::from(path);
    candidate.is_file().then_some(candidate)
}

/// Read the user's full PATH as their interactive login shell sees it. Printed
/// behind a sentinel so a trailing rc/profile banner can't clobber the value
/// (a plain `echo $PATH` would be ambiguous against interleaved output).
fn login_shell_path() -> Option<String> {
    let script = format!("printf '{QUILL_PATH_SENTINEL}%s\\n' \"$PATH\"");
    let stdout = login_shell_stdout(&script)?;
    stdout
        .lines()
        .find_map(|l| l.strip_prefix(QUILL_PATH_SENTINEL))
        .map(str::to_string)
        .filter(|p| !p.is_empty())
}

/// The `~/.nvm/versions/node/*/bin` directories, newest version first. Shared by
/// the install-dir scan and the child-PATH fallback so both agree on ordering.
fn nvm_node_bin_dirs(home: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(format!("{home}/.nvm/versions/node"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join("bin"))
        .collect();
    dirs.sort();
    dirs.reverse(); // newest version first
    dirs
}

/// Locate the `claude` CLI. A bundled macOS app inherits a minimal PATH from
/// launchd (often without the user's nvm / Homebrew dirs), so a bare
/// `Command::new("claude")` fails with "No such file or directory" even though
/// the binary is installed. We try, in order: (1) the existing PATH (works in
/// `tauri dev` / from a terminal), (2) an interactive login shell, which sources
/// the user's profile and rc files and knows the *configured* CLI, and (3) a
/// list of common install locations as a last-resort fallback. The shell is
/// tried before the hardcoded scan so a stale global install can't preempt the
/// binary the user actually configured. Returns an absolute path, or an error
/// explaining the search.
fn resolve_claude_binary() -> Result<PathBuf, String> {
    // 1. Already on PATH?
    if let Ok(output) = Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let candidate = PathBuf::from(&path);
            // Only trust the result if it actually names an existing file — a
            // stray line of output should never be handed to Command::new.
            if !path.is_empty() && candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // 2. Ask the interactive login shell (sources profile + rc → the user's
    //    *configured* claude). This runs before the hardcoded scan so a stale
    //    global install can't win over what the user set up.
    if let Some(candidate) = claude_from_login_shell() {
        return Ok(candidate);
    }

    // 3. Common install locations, last resort (nvm picks the highest-versioned
    //    node dir). Only reached when neither PATH nor the shell resolved it.
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from(format!("{home}/.claude/local/claude")),
        PathBuf::from(format!("{home}/.local/bin/claude")),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    candidates.extend(
        nvm_node_bin_dirs(&home)
            .into_iter()
            .map(|d| d.join("claude")),
    );
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    Err(
        "Could not find the `claude` CLI. Install it (https://docs.claude.com/claude-code) \
         and make sure it's on your PATH, then restart Quill."
            .to_string(),
    )
}

/// Build the PATH to hand the spawned `claude` process. A packaged `.app`
/// launched from Finder inherits launchd's minimal PATH, which lacks Node — and
/// `claude` is a `#!/usr/bin/env node` script, so it dies with `env: node: No
/// such file or directory`. We assemble a richer PATH, highest priority first,
/// de-duplicated preserving first occurrence, colon-joined:
///   (a) the directory the resolved `claude` binary lives in (its sibling `node`
///       lives here for nvm/Homebrew layouts),
///   (b) the login-shell PATH (rc files' toolchain lines),
///   (c) the already-inherited PATH,
///   (d) well-known fallback dirs so even the worst case (b and c both empty)
///       still yields a usable PATH.
/// Pure so it can be unit-tested without touching the environment.
fn build_child_path(
    claude_bin: &Path,
    login_shell_path: Option<&str>,
    inherited_path: Option<&str>,
    home: &str,
) -> String {
    let mut ordered: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |dir: String| {
        // First occurrence wins, preserving priority; empty segments dropped.
        if !dir.is_empty() && seen.insert(dir.clone()) {
            ordered.push(dir);
        }
    };

    // (a) the resolved binary's own directory.
    if let Some(parent) = claude_bin.parent() {
        push(parent.to_string_lossy().into_owned());
    }
    // (b) login-shell PATH, then (c) inherited PATH, in order.
    for source in [login_shell_path, inherited_path].into_iter().flatten() {
        for entry in source.split(':') {
            push(entry.to_string());
        }
    }
    // (d) well-known fallbacks.
    for dir in nvm_node_bin_dirs(home) {
        push(dir.to_string_lossy().into_owned());
    }
    for dir in [
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ] {
        push(dir);
    }

    ordered.join(":")
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
    add_dir: Option<String>,
    allow_create: Option<bool>,
    on_event: Channel<ChunkEvent>,
) -> Result<String, String> {
    let claude_bin = resolve_claude_binary()?;
    // Bindings created inside Quill ("Start new session") point at a session
    // that doesn't exist until the first reply: create it under the binding's
    // id with `--session-id`, then resume it like any other session afterwards.
    // Without allow_create an unknown session still fails loudly via --resume.
    let create_new = allow_create.unwrap_or(false) && find_session_jsonl(&session_id)?.is_none();
    let mut cmd = Command::new(&claude_bin);
    cmd.arg(if create_new {
        "--session-id"
    } else {
        "--resume"
    })
    .arg(&session_id)
    .arg("--print")
    .arg("--output-format")
    .arg("stream-json")
    .arg("--include-partial-messages")
    .arg("--verbose");
    // Grant read access to the document's linked context folder so Claude can
    // open the files named in the prompt's manifest.
    if let Some(dir) = add_dir.as_deref().filter(|d| !d.is_empty()) {
        cmd.arg("--add-dir").arg(dir);
    }
    // A packaged .app launched from Finder inherits launchd's minimal PATH,
    // which lacks Node — and `claude` is a node script, so it would die with
    // `env: node: No such file or directory`. Give the child a PATH that
    // includes the binary's own dir plus the user's real toolchain dirs.
    let home = std::env::var("HOME").unwrap_or_default();
    let child_path = build_child_path(
        &claude_bin,
        login_shell_path().as_deref(),
        std::env::var("PATH").ok().as_deref(),
        &home,
    );
    cmd.arg(&prompt)
        .current_dir(&cwd)
        .env("PATH", &child_path)
        // If Quill was launched from a shell with an API key exported, the CLI
        // would silently bill that key instead of the user's `claude` login.
        .env_remove("ANTHROPIC_API_KEY")
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
        lock_recover(&registry.0).insert(token.clone(), handle.clone());
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
                Err(e) => {
                    // A non-JSON line in the stream-json output is unexpected;
                    // skip it but leave a breadcrumb rather than vanishing it.
                    log::debug!("skipping non-JSON line from claude stream: {e}");
                    continue;
                }
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
            let mut child_lock = lock_recover(&handle.child);
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
        lock_recover(&registry.0).remove(&token_for_thread);
    });

    Ok(token)
}

#[tauri::command]
fn cancel_claude_resume(
    cancel_token: String,
    registry: State<'_, ChildRegistry>,
) -> Result<(), String> {
    let entry = lock_recover(&registry.0).remove(&cancel_token);
    if let Some(handle) = entry {
        handle.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = lock_recover(&handle.child).as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Diagnostics a user can copy and paste into a bug report: app version, OS,
/// architecture, and where the local log file lives so they can attach it.
#[derive(Serialize)]
struct Diagnostics {
    version: String,
    os: String,
    arch: String,
    log_dir: String,
}

#[tauri::command]
fn get_diagnostics(app: tauri::AppHandle) -> Result<Diagnostics, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "<unknown>".to_string());
    Ok(Diagnostics {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        log_dir,
    })
}

/// Open the app's log directory in the OS file manager (Help → Show Logs).
#[tauri::command]
fn reveal_logs(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Route Rust panics into the log file (chaining the default hook so dev still
/// gets the usual stderr output). Without this, a backend panic vanishes
/// silently — there's no server to catch it. Installed before the builder so it
/// covers setup too.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        log::error!("panic at {location}: {payload}");
        default(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    tauri::Builder::default()
        .plugin(
            // Local-only diagnostics: leveled logs to the app log dir (plus
            // stdout in dev and the webview console so frontend logs land in
            // the same file). Rotation keeps the newest file and one previous,
            // capping disk use — KeepAll grows unbounded (plugins-workspace
            // #1397). Nothing leaves the machine; the Help menu lets the user
            // reveal or copy these when reporting a bug.
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("quill".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(ChildRegistry::default());
            app.manage(PendingDeepLink::default());

            build_menu(app.handle(), &[])?;

            use tauri::Emitter;

            // Registered once here (not in build_menu): `update_recent_menu`
            // rebuilds the menu at runtime, and re-registering the handler on
            // every rebuild would stack listeners.
            app.on_menu_event(move |app, event| {
                // The menu item id is exactly the event name the frontend
                // listens for; Open Recent ids carry the path after "recent:".
                let id = event.id().as_ref();
                if let Some(path) = id.strip_prefix("recent:") {
                    let _ = app.emit("menu-open-recent", path.to_string());
                } else if matches!(
                    id,
                    "menu-new"
                        | "menu-open"
                        | "menu-save"
                        | "menu-save-as"
                        | "menu-export-pdf"
                        | "menu-quit"
                        | "menu-clear-recent"
                        | "menu-reveal-logs"
                        | "menu-copy-diagnostics"
                ) {
                    let _ = app.emit(id, ());
                }
            });
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(path) = parse_quill_open(url.as_str()) {
                        // Buffer for cold start (frontend not yet listening) and
                        // also emit for the warm-start case where it is.
                        if let Some(pending) = handle.try_state::<PendingDeepLink>() {
                            *lock_recover(&pending.0) = Some(path.clone());
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
            show_folder_dialog,
            list_context_files,
            write_draft,
            read_draft,
            delete_draft,
            list_claude_sessions,
            read_claude_session_preview,
            spawn_claude_resume,
            cancel_claude_resume,
            find_session_for_markdown,
            check_session_compacted,
            handle_deep_link,
            take_pending_deep_link,
            has_native_menu,
            update_recent_menu,
            get_diagnostics,
            reveal_logs,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Label for an Open Recent entry: the file name, falling back to the full
/// path when there is no final component.
fn recent_menu_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Build the native application menu and route File-menu clicks to frontend
/// events. The menu mirrors the existing keyboard shortcuts (Cmd/Ctrl+N/O/S,
/// Cmd/Ctrl+Shift+S) so file operations are reachable without knowing them.
/// `recent` fills File → Open Recent; the frontend re-invokes
/// `update_recent_menu` (which calls back into here) whenever its list
/// changes, so the whole menu is rebuilt each time.
fn build_menu(app: &tauri::AppHandle, recent: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

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
    let export_pdf_item = MenuItem::with_id(
        app,
        "menu-export-pdf",
        "Export to PDF…",
        true,
        Some("CmdOrCtrl+P"),
    )?;

    // Open Recent: one item per remembered path (id carries the full path so
    // the click handler can forward it), then Clear Menu — disabled when there
    // is nothing to clear, matching the macOS convention.
    let mut recent_items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for path in recent {
        recent_items.push(Box::new(MenuItem::with_id(
            app,
            format!("recent:{path}"),
            recent_menu_label(path),
            true,
            None::<&str>,
        )?));
    }
    if !recent.is_empty() {
        recent_items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    let clear_recent_item = MenuItem::with_id(
        app,
        "menu-clear-recent",
        "Clear Menu",
        !recent.is_empty(),
        None::<&str>,
    )?;
    recent_items.push(Box::new(clear_recent_item));
    let recent_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        recent_items.iter().map(|i| i.as_ref()).collect();
    let open_recent_menu = Submenu::with_items(app, "Open Recent", true, &recent_refs)?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_item,
            &open_item,
            &open_recent_menu,
            &PredefinedMenuItem::separator(app)?,
            &save_item,
            &save_as_item,
            &PredefinedMenuItem::separator(app)?,
            &export_pdf_item,
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

    // Help: local diagnostics. "Copy Diagnostics" puts version/OS/log-path on
    // the clipboard for pasting into a bug report; "Show Logs" reveals the log
    // file. Both are frontend-handled (see the menu-event matcher).
    let copy_diagnostics_item = MenuItem::with_id(
        app,
        "menu-copy-diagnostics",
        "Copy Diagnostics",
        true,
        None::<&str>,
    )?;
    let reveal_logs_item =
        MenuItem::with_id(app, "menu-reveal-logs", "Show Logs", true, None::<&str>)?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&copy_diagnostics_item, &reveal_logs_item],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &help_menu])?;
    app.set_menu(menu)?;

    Ok(())
}

/// Rebuild the menu with the given Open Recent paths (most recent first).
/// The frontend owns the list (persisted in localStorage) and calls this on
/// launch and whenever the list changes.
#[tauri::command]
fn update_recent_menu(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    build_menu(&app, &paths).map_err(|e| e.to_string())
}

fn parse_quill_open(url: &str) -> Option<String> {
    // Expected form: quill://open?file=<urlencoded path>
    //
    // This is an OS-level entry point: any web page can fire `quill://open?...`,
    // so the target is attacker-influenced. We never hand back a raw path. The
    // decoded path must point at an existing **regular** Markdown file; anything
    // else (a directory, a device, a non-document, a non-existent path, or a
    // symlink to one) is rejected so the deep link can only ever open a real
    // document the user already has on disk — not coax Quill into touching
    // arbitrary files.
    let rest = url.strip_prefix("quill://")?;
    let (host, query) = rest.split_once('?')?;
    if host != "open" {
        return None;
    }
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("file=") {
            let decoded = percent_decode(v);
            return validate_open_target(&decoded);
        }
    }
    None
}

/// Accept a deep-link target only if it resolves to an existing regular
/// Markdown file. Returns the canonicalized path (symlinks resolved) so callers
/// open the real file, not a redirect.
fn validate_open_target(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_file() {
        return None;
    }
    // Re-check the suffix on the canonical path: a symlink could end in `.md`
    // while pointing at something else.
    let canon_lower = canonical.to_string_lossy().to_ascii_lowercase();
    if !(canon_lower.ends_with(".md") || canon_lower.ends_with(".markdown")) {
        return None;
    }
    Some(canonical.to_string_lossy().into_owned())
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
    Ok(lock_recover(&pending.0).take())
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
