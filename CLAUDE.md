# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Quill is a Tauri 2 + React 19 desktop app — a Markdown editor with track-changes and inline comments, similar to Google Docs suggesting mode. The frontend is React/TypeScript built with Vite; the backend is a thin Rust/Tauri layer that exposes file I/O and native dialogs to the frontend.

## Commands

```bash
npm run dev            # Frontend dev server only (no Tauri window, no file I/O)
npm run tauri dev      # Full desktop app (Tauri + frontend, hot-reload)
npm run tauri build    # Production bundle

npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run format:check   # prettier --check
npm test               # vitest (unit + component)
npx playwright test    # end-to-end specs

cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
```

CI (`.github/workflows/ci.yml`) runs the frontend checks (typecheck, eslint, prettier, vitest) and the Rust checks (fmt, clippy, test) on every push and PR to `main`. Match that bar before pushing.

## Contributing

`main` is the default branch and is **not** committed to directly. To land a change:

1. Branch off `main` (e.g. `git checkout -b fix/short-description`).
2. Make the change and keep CI green locally: run the full check bar above (typecheck, lint, `format:check`, vitest, and `cargo fmt --check && cargo clippy -- -D warnings && cargo test`). Fix formatting with `npm run format` / `cargo fmt`.
3. Commit, push the branch, and open a PR against `main` with `gh pr create`. Let CI pass on the PR before merging.

Keep a PR scoped to one coherent theme. Update `PRD.md` and this file when behavior or architecture changes.

## Architecture

### Frontend (`src/`)

State lives entirely in `App.tsx` — no Redux or context. The editor, comments, and suggestions are wired together there via props and callbacks. Key relationships:

- **`App.tsx`** — Orchestrates everything: editor ref, comment/suggestion state, keyboard shortcuts (Cmd+S/O/N, Cmd+Shift+S), file metadata.
- **`Editor.tsx`** — Wraps Tiptap. Exposes an imperative handle (`getMarkdown()`, `setContent()`) via `forwardRef`. Do not reach past this component to manipulate Tiptap directly.
- **`hooks/useFileManager.ts`** — All Tauri file I/O. Opens/saves `.md` files and manages the parallel `.comments.json` sidecar. Invoke Tauri commands only from here.
- **`hooks/useComments.ts`** / **`hooks/useSuggestions.ts`** — CRUD state for comments and track-changes suggestions.
- **`components/CommentLayer.tsx`** — Absolutely-positioned comment cards with a collision-detection nudge algorithm to prevent overlap.

### Tiptap Extensions (`src/extensions/`)

- **`TrackChanges.ts`** — ProseMirror plugin that intercepts document transactions in suggesting mode and wraps changes with `tracked_insert` / `tracked_delete` marks.
- **`Comment.ts`** — Tiptap mark extension for anchoring comment highlights to text ranges.

### Persistence Model

Every saved file produces two files:

- `<name>.md` — Markdown content from Tiptap
- `<name>.comments.json` — Sidecar with comments, suggestions, the linked AI session, and the linked reference folder (type: `SidecarFile`)

The sidecar is deleted automatically on save if it contains no data.

### Tauri Backend (`src-tauri/src/lib.rs`)

The Rust layer (`run()`) registers every IPC command — these are the only Rust entry points, so all file system, dialog, and Claude-process work must go through them:

- **File & dialog:** `read_file`, `write_file`, `delete_file`, `show_open_dialog`, `show_save_dialog`, `show_folder_dialog`.
- **Reference folder:** `list_context_files` walks a linked folder (bounded, hidden/dependency dirs skipped, document-like extensions only, capped at 200) to build the prompt manifest.
- **Claude session integration:** `list_claude_sessions`, `read_claude_session_preview`, `find_session_for_markdown`, `check_session_compacted`, `spawn_claude_resume`, `cancel_claude_resume`. These read `~/.claude/projects/*.jsonl` to locate and preview sessions, and spawn the `claude` CLI (`--resume … --print --output-format stream-json`, plus `--add-dir` when a reference folder is linked) to stream `@claude` replies back over an IPC `Channel`. Spawned children are tracked in a `ChildRegistry` so they can be cancelled.
- **Deep links:** `handle_deep_link` / `parse_quill_open` parse `quill://open?file=…` URLs.
- **App lifecycle:** `has_native_menu`, `exit_app`. The menu's Quit item emits `menu-quit` instead of quitting so the frontend's unsaved-changes guard (`guardDirty` in `App.tsx`, with the `AppModal` Save / Don't Save / Cancel dialog) runs first; the same guard covers New, Open, deep links, and window close. Use `AppModal` for any user-facing dialog — `window.alert`/`confirm` are unreliable in Tauri webviews.

### `@claude` reply flow (`src/hooks/useClaudeReply.ts` + backend)

`useClaudeReply` builds the prompt (anchor text, comment thread, the reference-folder manifest when one is linked, and either a line diff or the full document depending on `check_session_compacted`), calls `spawn_claude_resume` (passing `addDir` for the reference folder), and consumes the streamed `ChunkEvent`s (`Delta` / `Done` / `Error` / `Cancelled`) to update the AI reply in place. Streaming parsing (fence holdback for the `quill-edits` block) lives in `utils/trackedEdits.ts`.

### Core Types (`src/types/index.ts`)

`Comment`, `Reply`, `Suggestion`, `AISessionBinding`, `SidecarFile` — the shared data contract between frontend state and the serialized sidecar (`version: 2`). Change these carefully; they affect both runtime state and on-disk files. See `PRD.md` for the full as-built behavior.
