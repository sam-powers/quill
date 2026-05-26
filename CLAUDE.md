# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Quill is a Tauri 2 + React 19 desktop app — a Markdown editor with track-changes and inline comments, similar to Google Docs suggesting mode. The frontend is React/TypeScript built with Vite; the backend is a thin Rust/Tauri layer that exposes file I/O and native dialogs to the frontend.

## Commands

```bash
# Frontend dev server only (no Tauri window)
npm run dev

# Full desktop app (Tauri + frontend, hot-reload)
npm run tauri dev

# Production build
npm run tauri build

# TypeScript type-check (only static analysis available — no linter, no tests)
npm run build
```

No test framework is configured. No ESLint or Prettier configs exist — `tsc` is the only static analysis.

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
- `<name>.comments.json` — Sidecar with comments and suggestions (type: `SidecarFile`)

The sidecar is deleted automatically on save if it contains no data.

### Tauri Backend (`src-tauri/src/`)

Five commands: `read_file`, `write_file`, `delete_file`, `show_open_dialog`, `show_save_dialog`. These are the only Rust entry points; all file system and dialog operations must go through them.

### Core Types (`src/types/index.ts`)

`Comment`, `Reply`, `Suggestion`, `SidecarFile` — the shared data contract between frontend state and the sidecar format. Change these carefully; they affect both runtime state and serialized files.
