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

Releases: pushing a `v*` tag triggers `.github/workflows/release.yml` (tauri-action), which builds macOS installers (aarch64 + x86_64) and attaches them to a **draft** GitHub Release. Releases are macOS-only by decision: `@claude` binary/session discovery is Unix-path-based, and we don't ship builds that can't deliver the full experience. A maintainer fills in the notes (drafts live in `docs/release-notes/`) and publishes manually. Tags are pushed by the maintainer, not by automation. Keep `version` in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in sync when bumping.

## Contributing

`main` is the default branch and is **not** committed to directly. To land a change:

1. Branch off `main` (e.g. `git checkout -b fix/short-description`).
2. Make the change and keep CI green locally: run the full check bar above (typecheck, lint, `format:check`, vitest, and `cargo fmt --check && cargo clippy -- -D warnings && cargo test`). Fix formatting with `npm run format` / `cargo fmt`.
3. Commit, push the branch, and open a PR against `main` with `gh pr create`. Let CI pass on the PR before merging.

Keep a PR scoped to one coherent theme. Update `PRD.md` and this file when behavior or architecture changes.

## Architecture

### Frontend (`src/`)

State lives entirely in `App.tsx` — no Redux or context. The editor, comments, and suggestions are wired together there via props and callbacks. Key relationships:

- **`App.tsx`** — Orchestrates everything: editor ref, comment/suggestion state, keyboard shortcuts (Cmd+S/O/N, Cmd+Shift+S, Cmd+F), file metadata. (Cmd+K lives in `Toolbar.tsx`'s `LinkButton`, not here: a popover that adds/edits/removes the StarterKit link mark. It captures the selection range when it opens — the URL input steals focus — and `extendMarkRange('link')` targets the whole link from a cursor inside it; `normalizeHref` prefixes bare domains with `https://`. Link changes are mark-only steps, so suggesting mode passes them through untracked, same as bold.)
- **`Editor.tsx`** — Wraps Tiptap. Exposes an imperative handle (`getMarkdown()`, `setContent()`) via `forwardRef`. Do not reach past this component to manipulate Tiptap directly. The extension set includes tables, task lists, and images so those constructs round-trip through save — mirror any extension change in `src/test/utils/markdownRoundTrip.test.ts`, which asserts fidelity. StarterKit bundles Link/Underline in Tiptap v3: configure them via `StarterKit.configure({ link: … })`, never as separate extensions (duplicates warn). Keep all `@tiptap/*` deps on the same minor version (skew breaks `vite build`); the `overrides` block in `package.json` pins `prosemirror-*` to single instances (a split throws "Adding different instances of a keyed plugin").
- **`hooks/useFileManager.ts`** — All Tauri file I/O. Opens/saves `.md` files and manages the parallel `.comments.json` sidecar. Invoke Tauri commands only from here.
- **`hooks/useComments.ts`** / **`hooks/useSuggestions.ts`** — CRUD state for comments and track-changes suggestions.
- **`hooks/useDraftAutosave.ts`** — Crash recovery. While the doc is dirty, snapshots it (content + annotations + links, type `DraftFile`) to `draft.json` in the app data dir every ~5 s; deletes the draft on the dirty→clean _transition_ only — never on a clean mount, which would race the launch recovery check (`readDraft` → App's Recover/Discard modal). Paths that exit before React effects flush (the unsaved-changes guard's Save / Don't Save) must `await deleteDraft()` explicitly. Outside Tauri every operation is a silent no-op.
- **`hooks/useUpdateCheck.ts`** — Once on launch (production builds only — gated on `import.meta.env.PROD`, so dev/e2e never hit the network), fetches GitHub's latest published release and compares it to `__APP_VERSION__` (injected from `package.json` by `vite.config.ts` **and** `vitest.config.ts` — keep both `define`s). A newer version renders `components/UpdateBanner.tsx` (dismissible; dismissal persisted per-version in localStorage; "View release" opens the browser via the opener plugin). This is notify-only, not an auto-updater. The CSP's `connect-src` allowlists `https://api.github.com` for this.
- **`components/CommentLayer.tsx`** — Absolutely-positioned comment cards with a collision-detection nudge algorithm to prevent overlap.

### Tiptap Extensions (`src/extensions/`)

- **`TrackChanges.ts`** — ProseMirror plugin that intercepts document transactions in suggesting mode and wraps changes with `tracked_insert` / `tracked_delete` marks. A step that both deletes and inserts (typing over a selection, applied quill-edits) mints both halves with a shared `pairId`: `CommentLayer.tsx` groups them into one `ReplacementCard`, and `acceptChange` / `rejectChange` also accept a pairId, resolving both halves in one transaction.
- **`Comment.ts`** — Tiptap mark extension for anchoring comment highlights to text ranges.
- **`PendingComment.ts`** — Decoration (not a mark — never touches the document) that keeps the to-be-commented range highlighted while the comment composer is open. Driven by `setPendingCommentRange` / `clearPendingCommentRange`, wired to the composer lifecycle via `AddCommentButton`'s `onComposingChange`.
- **`Find.ts`** — Decoration-only find & replace state (never touches the document); `components/FindBar.tsx` is the UI (Cmd+F). Plugin state `{query, matches, activeIndex}` recomputes matches on every doc change. `findMatches` gathers text per textblock with a char→position map so matches span mark boundaries, but excludes text carrying `tracked_delete` (replace would re-find its own struck-out leftovers) and breaks adjacency at non-text inline nodes. Replacement is ordinary `insertContent`, so TrackChanges mints a tracked replacement pair in suggesting mode; the insert always lands at `match.from` (the struck original follows it), so stepping past a replacement is `match.from + replaceText.length` in both modes. Replace All applies back-to-front in one chain — one transaction, one undo step.
- **`AnnotationFocus.ts`** — Decoration (never touches the document) that intensifies the in-text highlight of the active annotation (comment or suggestion). Driven by `setAnnotationFocus` / `clearAnnotationFocus`, mirrored from App's `activeAnnotation` state; also exports `findAnnotationRange` for live mark ranges. A suggestion target id may be a change id or a replacement's `pairId` (matches both halves). Clicks on annotated text are hit-tested in `Editor.tsx`'s `handleClick` (DOM-walk for `data-comment-id` / `data-change-id`) and reported to App, which focuses the innermost candidate — promoting a replacement half to its pairId.
- **`MarkdownImage.ts`** — Image extension whose `renderHTML` resolves the displayed src at draw time: relative paths are resolved against the open document's directory (`setImageBaseDir`, called by App **before** `setContent` — ProseMirror draws synchronously) through Tauri's asset protocol (`convertFileSrc`). The document attribute keeps the original Markdown path, so serialization is untouched. Outside Tauri or for unsaved docs, relative srcs pass through unresolved. The asset protocol is enabled in `tauri.conf.json` (scope `$HOME/**`, `protocol-asset` cargo feature); the CSP's `img-src` also allows `https:` for remote images. Related: `utils/markdownFidelity.ts` (`detectLossyConstructs`) warns once on open when a file contains footnotes or raw HTML, which the editor would mangle on save.

### Persistence Model

Every saved file produces two files:

- `<name>.md` — Markdown content from Tiptap
- `<name>.comments.json` — Sidecar with comments, suggestions, the linked AI session, and the linked reference folder (type: `SidecarFile`)

The sidecar is deleted automatically on save if it contains no data.

### Tauri Backend (`src-tauri/src/lib.rs`)

The Rust layer (`run()`) registers every IPC command — these are the only Rust entry points, so all file system, dialog, and Claude-process work must go through them:

- **File & dialog:** `read_file`, `write_file`, `delete_file`, `show_open_dialog`, `show_save_dialog`, `show_folder_dialog`.
- **Draft autosave:** `write_draft`, `read_draft`, `delete_draft` manage the single `draft.json` crash-recovery snapshot in the app data dir (atomic temp-file + rename writes; a missing draft reads as `None`).
- **Reference folder:** `list_context_files` walks a linked folder (bounded, hidden/dependency dirs skipped, document-like extensions only, capped at 200) to build the prompt manifest.
- **Claude session integration:** `list_claude_sessions`, `read_claude_session_preview`, `find_session_for_markdown`, `check_session_compacted`, `spawn_claude_resume`, `cancel_claude_resume`. These read `~/.claude/projects/*.jsonl` to locate and preview sessions, and spawn the `claude` CLI (`--resume … --print --output-format stream-json`, plus `--add-dir` when a reference folder is linked) to stream `@claude` replies back over an IPC `Channel`. `spawn_claude_resume` accepts `allow_create`: when set and the session's jsonl doesn't exist yet, it swaps `--resume` for `--session-id`, creating the session on first contact — this backs the picker's "Start new session" button (`createdByQuill` bindings, which skip the compaction check and always send the full document, with prompts that never claim Claude authored the doc). Spawned children are tracked in a `ChildRegistry` so they can be cancelled.
- **Deep links:** `handle_deep_link` / `parse_quill_open` parse `quill://open?file=…` URLs.
- **App lifecycle:** `has_native_menu`, `exit_app`. The menu's Quit item emits `menu-quit` instead of quitting so the frontend's unsaved-changes guard (`guardDirty` in `App.tsx`, with the `AppModal` Save / Don't Save / Cancel dialog) runs first; the same guard covers New, Open, deep links, and window close. Use `AppModal` for any user-facing dialog — `window.alert`/`confirm` are unreliable in Tauri webviews.

### `@claude` reply flow (`src/hooks/useClaudeReply.ts` + backend)

`useClaudeReply` builds the prompt (anchor text, comment thread, the reference-folder manifest when one is linked, and either a line diff or the full document depending on `check_session_compacted` — skipped for `createdByQuill` bindings, which always get the full document), calls `spawn_claude_resume` (passing `addDir` for the reference folder and `allowCreate` for Quill-minted sessions), and consumes the streamed `ChunkEvent`s (`Delta` / `Done` / `Error` / `Cancelled`) to update the AI reply in place. Streaming parsing (fence holdback for the `quill-edits` block) lives in `utils/trackedEdits.ts`.

### Core Types (`src/types/index.ts`)

`Comment`, `Reply`, `Suggestion`, `AISessionBinding`, `SidecarFile` — the shared data contract between frontend state and the serialized sidecar (`version: 2`). Change these carefully; they affect both runtime state and on-disk files. See `PRD.md` for the full as-built behavior.
