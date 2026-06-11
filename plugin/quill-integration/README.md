# Quill Integration (Claude Code plugin)

Open Markdown documents in [Quill](https://github.com/sam-powers/quill) — the document editor that can hold a conversation — directly from a Claude Code session, with track-changes, inline comments, and `@claude` replies.

## What it does

Adds one slash command:

```
/quill-integration:open-in-quill <path-to.md>
```

It resolves the path to absolute, URL-encodes it, and runs `open "quill://open?file=…"`. Quill receives the deep link, opens the document, and restores its comments, suggestions, and any linked Claude session from the `<name>.comments.json` sidecar.

Examples:

```
/quill-integration:open-in-quill PRD.md
/quill-integration:open-in-quill ./docs/spec.md
/quill-integration:open-in-quill /Users/me/notes/draft.md
```

## Requirements

- **macOS** — uses the `open` command and the `quill://` URL scheme.
- **Quill installed and launched at least once** — Quill registers the `quill://` scheme on first launch. If the command fails to open, run `open /path/to/quill.app` once, then retry.

## Install

Add the marketplace, then install — either from a terminal:

```bash
claude plugin marketplace add sam-powers/quill
claude plugin install quill-integration@quill-official
```

or from inside a Claude Code session:

```
/plugin marketplace add sam-powers/quill
/plugin install quill-integration@quill-official
```

The marketplace manifest lives at [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) in the root of the Quill repo (Claude Code requires it at the repository root).

### Local development

```bash
claude --plugin-dir ./plugin/quill-integration
```

## Notes

This plugin only triggers the editor — the deep-link handling, session auto-binding, and AI reply streaming all live in the Quill app itself (Rust/Tauri). The plugin is intentionally thin so it carries no secrets and works standalone on any machine with Quill installed.
