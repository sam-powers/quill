# Contributing to Quill

Thanks for your interest! Quill is a Tauri 2 + React 19 desktop Markdown editor with track-changes, inline comments, and `@claude` review built in. The [README](./README.md) covers building from source, [`PRD.md`](./PRD.md) is the as-built product spec, and [`CLAUDE.md`](./CLAUDE.md) has the architecture notes.

## Development setup

Prerequisites: Node.js 22+, a Rust toolchain, and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npm run tauri dev   # full desktop app with hot reload
```

## Before you open a PR

`main` is protected — all changes land via pull request. Keep each PR to one coherent theme, and make sure the full check bar is green locally (it's exactly what CI runs):

```bash
npm run typecheck
npm run lint
npm run format:check   # fix with: npm run format
npm test               # vitest
npx playwright test    # e2e (first time: npx playwright install chromium)

cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

A husky pre-commit hook runs lint-staged and the unit tests automatically.

## Guidelines

- Add or update tests for behavior you change — unit tests in `src/test/`, e2e in `e2e/`, Rust tests in `src-tauri/src/lib.rs`.
- Update `PRD.md` and `CLAUDE.md` when behavior or architecture changes.
- New Tauri IPC commands must be registered in `generate_handler!` in `src-tauri/src/lib.rs` and invoked only from `src/hooks/useFileManager.ts` or `src/hooks/useClaudeReply.ts`.
- Use the in-app `AppModal` for dialogs — `window.alert`/`confirm` are unreliable in Tauri webviews.

## Reporting bugs

[Open an issue](https://github.com/sam-powers/quill/issues) with your platform, what you did, what you expected, and what happened. For `@claude` problems, mention whether the `claude` CLI works in your terminal.
