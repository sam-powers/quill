# Quill — Product Requirements (as-built)

**Status:** Reflects what is implemented and shipping today, single-player.
**Last updated:** 2026-05-23
**Out of scope (deprioritized):** real-time multiplayer, Google Sign-In, and cloud document sharing. That work lives unmerged on `claude/google-signin-multiplayer-ecT9T` and is intentionally excluded here.

---

## 1. Summary

Quill is a desktop Markdown editor for **reviewing and revising prose**, modeled on Google Docs' suggesting mode. It runs as a native app (Tauri) and pairs a clean writing surface with three review primitives — **tracked changes**, **inline comments**, and **AI replies from the Claude Code session that wrote the document**. Files are plain `.md` on disk; review metadata rides alongside in a sidecar so the Markdown stays portable.

The defining feature: a document can be **linked to the Claude Code session that authored it**, so a reviewer can reply to a comment with `@claude` and get an inline answer from the same agent — context-aware, even after that session has been compacted.

## 2. Who it's for

A writer or editor working on Markdown documents (often ones drafted with Claude Code) who wants to review, suggest edits, and ask the original author — human or AI — questions in context, without leaving a focused single-window editor.

## 3. Implemented experience

### 3.1 Writing surface

- Rich-text editing of Markdown via a WYSIWYG editor (Tiptap/ProseMirror).
- Formatting toolbar: **italic, bold, underline, strikethrough**, **undo/redo**, **H1/H2/H3**, **bullet list, numbered list, blockquote, inline code**.
- Toolbar actions preserve the active text selection (a known editor pitfall, handled deliberately).
- Document zoom from **60% to 240%** via toolbar shortcuts (Cmd +/−/0) and a footer slider (double-click the % to reset to 100%).
- Four selectable color **themes** (Sage, Mocha · Dragonfly, Watery · Adirondack, Rodeo · Ecological), persisted to local storage across launches.

### 3.2 Two modes: Editing and Suggesting

- A toolbar switch toggles between **Editing** (changes applied directly) and **Suggesting** (changes tracked, Google-Docs style).
- In Suggesting mode:
  - Typed text is marked as a tracked **insertion**; deleted text is marked as a tracked **deletion** rather than removed.
  - A **Suggesting** badge shows in the footer.
  - Each pending change surfaces a **suggestion card** in the margin with per-change **Accept** / **Reject**.
  - When any pending changes exist, the toolbar shows **Accept All** / **Reject All**.
  - Accepting an insertion keeps the text and drops the mark; rejecting removes it. Accepting a deletion removes the text; rejecting restores it.
  - Replacing text (typing over a selection) is represented as a **paired deletion + insertion** — two independent tracked changes, each accepted or rejected on its own — not a single "replacement" change.
- Switching back to Editing stops tracking new changes (existing tracked changes remain until resolved).

### 3.3 Comments

- Select text → a **+** button appears in the margin → add a comment anchored to that text range.
- Comments render as **cards in the right margin**, positioned next to their anchor with a collision-avoidance nudge so they don't overlap.
- Clicking a comment **activates** it and scrolls its anchor into view.
- Each comment is a **thread**: add replies, **resolve** / **unresolve**, and **delete** (which also removes the in-text highlight).

### 3.4 AI replies (`@claude`) — the differentiator

- A document can be **linked to a Claude Code session** via the footer ("Link to Claude session…"), choosing from a session picker. Once linked, the footer shows the linked session (`🔗 Claude <id>`) and offers an unlink (×).
- In a comment thread, the user can request a reply from Claude. The request is sent to the linked session and the **answer streams back inline** as an AI-authored reply in the thread.
- The prompt Claude receives includes the **highlighted anchor text**, the **comment thread so far**, and document context.
- **Claude can write edits directly into the document as tracked changes.** When the user asks for a revision (e.g. "tighten this", "fix the grammar"), Claude's reply carries a fenced `quill-edits` block of `find` / `replace` edits alongside its prose. Quill locates each `find` string and applies the replacement as a **tracked change attributed to Claude** — so AI revisions land as ordinary Accept / Reject suggestion cards in the margin, reviewed exactly like a human's. The prose explanation still appears in the thread; only the editing instructions are stripped from it.
  - **Scope is inferred from the request:** by default edits are confined to the **highlighted** anchor text; phrasing like "this paragraph" widens the scope to the surrounding **paragraph**, and "the whole document" to the **entire doc**.
  - Edits whose `find` text can no longer be located in the document are skipped rather than misapplied, and the count is reported.
  - Track-changes mode is toggled on only for the duration of applying Claude's edits, then restored to whatever it was — so this works whether or not the user is in Suggesting mode.
- **Compaction-aware context:** before asking, Quill checks whether the linked session's context was compacted.
  - Context intact → Claude is sent a **line diff** of what it originally wrote vs. the current document.
  - Context compacted → Claude is sent the **full current document** with a note explaining the compaction.
- AI replies show a **pending** state while streaming and can be **cancelled**; failures surface an error on the reply.
  - **Binary resolution:** the `claude` CLI is located even when the bundled app starts with a minimal PATH (the macOS GUI case) — Quill checks the current PATH, then common install locations (nvm, Homebrew, `~/.local/bin`, `~/.claude/local`), then falls back to a login shell. If it still can't be found, the reply shows an actionable error telling the user to install it / put it on PATH.
  - **Error reporting:** `claude --print` exits 0 even on logical failures (auth errors, "no conversation found", usage limits), so success is judged by the stream's terminal `result` line (`is_error`), not the exit code. The error shown on the reply is the real reason — the result message, else stderr, else a fallback naming the exit code — rather than a generic "non-zero status".

### 3.5 Files & persistence

- Standard file operations available two ways: the native **File menu** (New / Open… / Save / Save As…) and the matching keyboard shortcuts **New (Cmd+N)**, **Open (Cmd+O)**, **Save (Cmd+S)**, **Save As (Cmd+Shift+S)**, both routed through the same handlers and native OS dialogs. The app ships a native menu bar (Quill / File / Edit) so file operations are discoverable, not shortcut-only.
- Every saved document is **two files**: `<name>.md` (portable Markdown) and `<name>.comments.json` (a sidecar holding comments, suggestions, and the linked AI session). The sidecar is removed on save when it holds nothing.
- **Corrupt-sidecar safety:** if a document's `.comments.json` exists but can't be parsed, Quill opens the Markdown with an empty review model, **warns the user**, and **refuses to overwrite or delete the unreadable sidecar** on a same-path save — so recoverable comment data is never silently clobbered. A Save As to a new path writes a fresh sidecar normally.
- **Deep links** (`quill://open?file=…`) open a document directly — e.g. launched from a Claude Code session — and restore its comments, suggestions, and session binding.
- **Dirty-state indicator** in both the window title and footer (`•`) when there are unsaved changes.
- **Unsaved-changes guard:** any action that would discard a dirty document — File → New, File → Open, an incoming deep link, closing the window, or quitting the app — first asks **Save / Don't Save / Cancel** in an in-app dialog. Choosing Save runs the normal save (including Save As for an untitled doc) and only proceeds if it succeeds; cancelling the save dialog keeps the document open. (The menu's Quit item routes through this guard rather than quitting directly.)
- **File errors are surfaced:** a failed open or save shows an in-app error dialog naming the file and the underlying OS error — a failed save is never silent (the dirty indicator also stays on). In-app dialogs are used instead of `window.alert`/`confirm`, which are unreliable in Tauri webviews.

### 3.6 Status bar (footer)

Live **filename**, **word count**, **character count**, **line/column**, suggesting badge, zoom control, and the Claude session link control.

## 4. Data model (contract)

- `Comment` (anchored text range + threaded `Reply[]`, resolved flag).
- `Reply` (author, text, `authorKind: user | ai`, pending/error state for streaming AI replies).
- `Suggestion` (status pending / accepted / rejected). The `type` field allows `insertion | deletion | replacement`, but `replacement` is currently unused — the editor tracks changes as `tracked_insert` / `tracked_delete` marks and never emits a distinct replacement.
- `AISessionBinding` (`provider: claude-code`, session id, cwd, linkedAt).
- `SidecarFile` (version 2: comments + suggestions + optional aiSession).

## 5. Platform

- Tauri 2 desktop app (native window, file dialogs, deep-link handling, Claude Code process integration) with a React/TypeScript frontend.
- Backend exposes a narrow surface: file read/write/delete, open/save dialogs, Claude session commands (find session for a doc, check compaction, spawn/cancel a resumed reply, handle deep links), and app exit (the Quit menu item emits an event so the frontend's unsaved-changes guard runs before `exit_app`).

## 6. Explicit non-goals (current build)

- No multi-user / real-time collaboration.
- No accounts, sign-in, or cloud sync.
- No document sharing beyond the local `.md` + sidecar pair.
- Suggesting mode tracks insertions and deletions only. A replacement is just a delete + insert pair; the `'replacement'` value in `SuggestionType` is declared but never written or read (a vestigial enum value, candidate for cleanup).

## 7. Backlog / known gaps

_(No open items in this section currently.)_
