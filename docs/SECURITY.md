# Security posture

This document describes Quill's threat model, the trust boundaries it defends,
and the deliberate decisions behind what is — and isn't — hardened. It is meant
to be read by an engineer reviewing the app, not just to list mitigations. Where
we left something unchanged, the rationale is here too, because a defensible
non-fix is part of the posture.

## Reporting a vulnerability

If you find a security issue in Quill, please report it privately rather than
opening a public issue, so it can be fixed before it's widely known. Email
**sapowers16@gmail.com** with a description and, where possible, steps to
reproduce. You'll get an acknowledgement, and we'll work the fix and any
disclosure timing with you. There is no bug-bounty program — this is a small
open-source project — but reports are genuinely welcome and credited if you'd
like.

## What Quill is, in security terms

Quill is a local, single-user macOS desktop app (Tauri 2 + a React/TypeScript
webview). It edits Markdown files the user already has on disk, stores
annotations in a sidecar next to each document, and — when the user opts in —
shells out to the locally-installed `claude` CLI to get AI replies on a document.
There is no server, no account, no multi-tenant data, and no network listener.
That shape rules out whole categories of risk (no auth, no session management,
no server-side injection) and concentrates the real risk in three places:

1. **The webview.** Untrusted _content_ (the Markdown being edited, including
   links and image URLs) is rendered in a context that also has IPC access to
   the Rust backend. Classic desktop-webview concern: don't let document content
   become code or navigate the user somewhere hostile.
2. **The IPC / filesystem boundary.** The Rust backend exposes file read/write/
   delete and process-spawn commands to the webview. Anything that can drive
   those commands can touch the filesystem.
3. **The deep link.** `quill://open?file=…` is registered with the OS. **Any web
   page the user visits can fire it.** This is the one entry point an external
   attacker can reach without already being on the machine, so it gets the most
   scrutiny.

## The core finding

Both passes over the codebase reached the same conclusion, and it's worth
stating plainly because it shaped every fix:

> **Quill trusted _deserialized_ data more than it trusted _rendered_ data.**

The rendered side was already in good shape. The CSP is restrictive
(`default-src 'self'`, no `unsafe-eval`, scripting confined to the bundle), the
webview can't be navigated to arbitrary origins, and the tracked-edit machinery
computes ProseMirror positions defensively. Link and image rendering were the
two soft spots there, and both are now closed.

The deserialized side was where trust outran validation. Three on-disk inputs —
the `.comments.json` sidecar, the `draft.json` crash-recovery snapshot, and the
`quill://` deep-link target — were read back and largely believed. A sidecar is
just a file next to a document; a user can receive a `.md` + sidecar pair from
anyone. A draft is written by us but can be corrupted. A deep link is
attacker-influenced by definition. None of these had earned the trust they were
getting. **Hostile or merely corrupt annotation data could reach
`doc.resolve(pos)` in ProseMirror, which throws on a negative / fractional / NaN
position and white-screens the app on open** — a denial-of-service on a
document the user can no longer open, with no obvious recovery.

The hardening below is organized around closing that gap.

## Trust boundaries and the data crossing them

| Boundary         | Input                                           | Trust before                    | Trust after                                         |
| ---------------- | ----------------------------------------------- | ------------------------------- | --------------------------------------------------- |
| Webview render   | Link `href`, image `src` in the document        | Rendered as authored            | Scheme-allowlisted; remote `img` constrained by CSP |
| IPC → filesystem | `read_file` / `write_file` / `delete_file` path | Any path the webview passed     | Extension-confined to documents Quill manages       |
| OS → app         | `quill://open?file=…` target                    | Decoded and opened              | Canonicalized, must be an existing regular `.md`    |
| Disk → state     | `.comments.json` sidecar, `draft.json`          | Spread into state largely as-is | Sanitized to a known-valid shape before use         |
| App → process    | `claude` binary resolution                      | First matching string spawned   | Must resolve to a real file                         |

## Hardening measures (all merged to `main`)

### 1. Filesystem commands are confined, and the deep link is validated (#57)

The three file commands (`read_file`, `write_file`, `delete_file`) each call
`ensure_allowed_path` before touching the disk. The backend legitimately serves
_user-chosen arbitrary paths_ (the native open/save dialog can land anywhere), so
confinement is by **extension allowlist**, not directory — Quill only ever reads
or writes files it manages:

```rust
fn ensure_allowed_path(path: &str) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    let allowed =
        lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".comments.json");
    if allowed { Ok(()) } else { Err("Refusing to access a file Quill does not manage".to_string()) }
}
```

This means a compromised or buggy webview can't use these commands to read
`~/.ssh/id_rsa` or write an executable into a launch directory — the command
refuses anything that isn't a document or its sidecar. (Crash-recovery uses
separate `write_draft` / `read_draft` / `delete_draft` commands scoped to the
single app-data `draft.json`, so they aren't — and don't need to be — covered by
this allowlist.)

The deep link gets a second, stricter check. `parse_quill_open` hands the decoded
target to `validate_open_target`, which: requires an `.md` / `.markdown` suffix →
`canonicalize`s the path (resolving symlinks) → requires the result to be an
existing **regular file** → re-checks the suffix on the _canonical_ path (a
symlink could be named `.md` while pointing elsewhere). A web page firing
`quill://open?file=/etc/passwd`, `…?file=/some/dir`, a non-existent path, or a
`.md` symlink aimed at a device or secret all get rejected. The deep link can
only ever open a real Markdown document the user already has on disk.

### 2. Deserialized annotations are sanitized to a known shape (#58)

`src/utils/annotationValidation.ts` is the single source of truth for what a
valid annotation looks like, used at **both** deserialization boundaries — the
sidecar (`useFileManager.ts`) and the draft snapshot (`useDraftAutosave.ts`) —
rather than duplicating guards in each. It exports `sanitizeComments`,
`sanitizeSuggestions`, `sanitizeAISession`, and `sanitizeContextFolder`.

The load-bearing helper is position validation, because that's what protects
ProseMirror:

```ts
function toPosition(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
```

A comment or suggestion with a missing id, a non-finite / negative / fractional
position, or an unknown type is dropped rather than spread into editor state. A
comment's `from`/`to` are normalized (`min`/`max`) so an inverted range can't
slip through. `sanitizeAISession` is all-or-nothing: the binding is accepted only
if `provider === 'claude-code'` and `sessionId`/`cwd`/`linkedAt` are all present,
so a half-formed binding can't drive a process spawn later. The white-screen-on-
open DoS is closed: a hostile or corrupt sidecar degrades to "some annotations
were dropped," never to a position that throws.

### 3. URL schemes are allowlisted on the two paths that open a browser (#59)

Two places turn stored strings into something the user can navigate to, and both
now refuse anything outside a known-safe set.

- **Link marks** (`Toolbar.tsx`, `normalizeHref`): a link the user types is
  persisted into the saved `.md` and is later clickable, so a `javascript:`,
  `data:`, `vbscript:`, or `file:` href would be a stored-XSS / local-file vector
  that survives a save/reopen. `normalizeHref` passes in-page/relative refs
  (`^[#/.]`), accepts a scheme only if it's in
  `['http', 'https', 'mailto', 'tel']`, gives bare domains an `https://` prefix,
  and returns empty for everything else.
- **The update banner** (`useUpdateCheck.ts`): "View release" opens
  `release.html_url` _from a network response_ in the user's browser.
  `safeReleaseUrl` accepts it only if it parses as `https://github.com/…`,
  otherwise falls back to the hardcoded releases page. A spoofed or compromised
  API response can't redirect the user to an arbitrary scheme or host.

### 4. Binary resolution only spawns a real file (#60)

`resolve_claude_binary` locates the `claude` CLI across PATH, common install
locations, and a login shell. Every path now gates on `candidate.is_file()`
before returning, so a stray line of `which` output or a profile banner printed
by the login shell can never be handed to `Command::new`. The login-shell probe
uses `-lc` (non-interactive login) rather than `-lic`: we want the profile's
PATH, not the side effects of interactive-only rc blocks.

## Deliberate non-fixes (judgment calls, documented on purpose)

Two things look like findings at a glance and were left unchanged after thinking
through the actual risk. Documenting _why_ is the point — a reviewer should be
able to see these were decisions, not oversights.

### Asset-protocol scope is `$HOME/**`

Relative image paths in a document are resolved against the document's directory
and loaded through Tauri's asset protocol, whose scope is `$HOME/**`
(`tauri.conf.json`). A narrower scope would be tempting, but **Quill is a
general-purpose editor: a user can open a Markdown file anywhere under their home
directory, and its images must load.** There is no narrower scope that doesn't
break the core feature. The scope grants the webview _read access for display_ to
files under `$HOME` via the asset protocol — but an `<img>` can render a file's
bytes, it cannot read them back into script and exfiltrate them, and the CSP
forbids the kind of scripting that would be needed to try. The exposure is
"display an image the user's own document points at," which is the feature
working as intended. We keep `$HOME/**` knowingly.

### Remote image `src` is a tracking beacon

Markdown permits `![](https://…)`, and the CSP's `img-src` allows `https:` so
those images render. Loading a remote image leaks the fact-of-open and the
client IP to that host — an ordinary web-beacon. This is **inherent to Markdown
rendering**, not specific to Quill, and the same trade-off every Markdown viewer
and email client makes. It is bounded: an image request carries no document
content, only the request itself, and the CSP confines remote image loads to
`https:`. We accept it rather than break remote images or build a
load-images-on-click gate that no comparable editor ships. A privacy-conscious
user editing untrusted documents should be aware that opening one may load remote
images — the same caution that applies to opening an HTML email.

## What this posture does not cover

To be honest about the boundary: Quill does not defend against an attacker who
_already_ has code execution on the machine or write access to the user's home
directory — at that point the deep link and sidecar are the least of the user's
problems. It is not code-signed or notarized beyond the standard release path,
and there is no auto-updater (the update story is a notify-only banner by
design). The threat model is "a normal user opens documents, some of which they
didn't author, and visits web pages that might fire a deep link" — and within
that model, the four fixes above close the gaps the audits found.
