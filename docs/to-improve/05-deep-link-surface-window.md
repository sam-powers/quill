# 05 — Deep link opens a doc but leaves the window hidden

**Area:** Rust backend (`src-tauri/src/lib.rs`, deep-link handler) · **Type:** bug

## Problem

Opening a document via a `quill://open?file=…` deep link (e.g. from the
`open-in-quill` integration, or `open quill://…` on macOS) loads the document
into the editor — but if Quill's window is backgrounded, minimized, or hidden,
the window doesn't come forward. The editor updates invisibly and the deep link
looks like a no-op: the user clicked a link and apparently nothing happened.

## Root cause

The deep-link handler emits the `deep-link-open` event (frontend loads the doc)
but never surfaces the main window. The document genuinely loads into the
existing window; it's just not shown.

## The change

In the deep-link handler, after emitting the open event, surface the main window.
Cover all three background states:

```rust
if let Some(win) = handle.get_webview_window("main") {
    let _ = win.show();        // hidden
    let _ = win.unminimize();  // minimized
    let _ = win.set_focus();   // backgrounded
}
```

All three calls together handle hidden, minimized, and merely-backgrounded
windows. Ignore the individual `Result`s (best-effort surfacing).

## Verify

- Minimize Quill, fire a `quill://open?file=…` deep link → window restores and
  comes to the front showing the opened doc.
- Same with the window merely behind another app, and with a hidden window.

## Notes for the porter

- Match the public repo's window label (`"main"` in the fork; confirm the repo's).
- This is additive — a few lines in the existing deep-link branch.
