# Quill

A desktop Markdown editor for **reviewing and revising prose**, modeled on Google Docs' suggesting mode. Quill pairs a clean writing surface with three review primitives — **tracked changes**, **inline comments**, and **AI replies from the Claude Code session that wrote the document**.

Files are plain `.md` on disk; review metadata rides alongside in a sidecar, so the Markdown stays portable and editable anywhere.

> **The defining feature:** a document can be linked to the Claude Code session that authored it. A reviewer can reply to a comment with `@claude` and get an inline, context-aware answer from the same agent — even after that session has been compacted.

## Features

- **WYSIWYG Markdown editing** built on Tiptap/ProseMirror, with a formatting toolbar (bold, italic, underline, strikethrough, headings, lists, blockquote, inline code) and undo/redo.
- **Suggesting mode** — a Google-Docs-style toggle that tracks edits as insertions and deletions instead of applying them directly. Each pending change gets a margin card with per-change **Accept** / **Reject**, plus **Accept All** / **Reject All**.
- **Inline comments** — anchor a threaded comment to a text range; reply, resolve, and delete. Comment cards live in the right margin with collision-avoidance so they never overlap.
- **`@claude` replies** — link a document to its authoring Claude Code session and ask questions in a comment thread. Answers stream back inline. Quill sends a line diff of what changed (or the full document, if the session's context was compacted).
- **AI-authored tracked changes** — ask Claude in a comment to _revise_ the text ("tighten this", "fix the grammar") and it writes the edits straight into the document as **tracked changes attributed to Claude** — reviewed as ordinary Accept / Reject suggestion cards, just like a human's. Scope follows your phrasing: the highlighted text by default, or "this paragraph" / "the whole document".
- **Deep links** — `quill://open?file=…` opens a document directly, e.g. launched from a Claude Code session, restoring its comments, suggestions, and session binding.
- **Quality-of-life** — document zoom (60–240%), four persisted color themes, a live status bar (word/char count, line/column, dirty indicator), and standard file shortcuts (New, Open, Save, Save As).

## Persistence model

Every saved document is two files:

| File                   | Contents                                                              |
| ---------------------- | --------------------------------------------------------------------- |
| `<name>.md`            | Portable Markdown — the document itself.                              |
| `<name>.comments.json` | Sidecar holding comments, suggestions, and the linked Claude session. |

The sidecar is deleted automatically on save when it holds nothing, so a document with no review metadata is just a clean `.md` file.

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org) 22+, a [Rust toolchain](https://rustup.rs), and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform. The `@claude` feature additionally requires the [Claude Code](https://claude.com/claude-code) CLI on your `PATH`.

```bash
# Install JS dependencies
npm install

# Run the full desktop app with hot reload
npm run tauri dev

# Produce a distributable bundle for your platform
npm run tauri build
```

`npm run dev` runs only the Vite frontend in a browser (no native window, no file I/O) — useful for UI work.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm test              # vitest (unit + component)
npx playwright test   # end-to-end (requires browsers: npx playwright install)

cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
```

CI runs the full frontend and Rust suites on every push and pull request to `main`.

### Project layout

```
src/                  React/TypeScript frontend
  App.tsx             Top-level orchestration (editor, comments, suggestions, shortcuts)
  components/         Editor, toolbar, comment/suggestion cards, footer, session picker
  extensions/         Tiptap extensions: TrackChanges, Comment
  hooks/              File I/O, comment/suggestion state, Claude replies
  types/              Shared data contract (Comment, Suggestion, SidecarFile, …)
  utils/              Pure helpers (sidecar paths, tracked-edit diffing)
  test/               Vitest unit/component tests
src-tauri/            Rust/Tauri backend (file I/O, dialogs, Claude session integration)
e2e/                  Playwright end-to-end specs
plugin/               Claude Code plugin that opens files in Quill via deep link
docs/                 Design references and supporting docs
```

See [`PRD.md`](./PRD.md) for the full as-built product spec and [`CLAUDE.md`](./CLAUDE.md) for architecture notes.

## License

Released under the [Apache License 2.0](./LICENSE).
