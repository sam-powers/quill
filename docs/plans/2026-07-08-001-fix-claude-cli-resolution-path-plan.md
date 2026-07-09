---
title: 'Fix claude CLI resolution & child PATH (specs 01–03)'
date: 2026-07-08
status: ready
branch: fix/claude-cli-resolution-path
area: Rust backend (src-tauri/src/lib.rs)
origin: docs/to-improve/01-claude-spawn-path.md, docs/to-improve/02-claude-resolve-configured-binary.md, docs/to-improve/03-claude-interactive-login-shell.md
---

# Fix claude CLI resolution & child PATH (specs 01–03)

## Problem

When Quill runs as a packaged macOS `.app` launched from Finder, launchd hands the
process a **minimal PATH** (`/usr/bin:/bin:/usr/sbin:/sbin`) that lacks Node and
the user's toolchain dirs. Three related defects follow, all in
`src-tauri/src/lib.rs`:

1. **(Spec 01)** `spawn_claude_resume` spawns the resolved `claude` binary but
   never sets the child's `PATH`. `claude` is a Node script (`#!/usr/bin/env
node`); with a minimal PATH it dies with `env: node: No such file or
directory`. Reproduces only in a packaged `.app` from Finder, never from
   `tauri dev` in a terminal — but a real bug for every installed user.

2. **(Spec 02)** `resolve_claude_binary` runs its hardcoded install-dir scan
   **before** it asks the login shell. The scan can pick a stale global install
   (e.g. an old `claude` under an old Node version) that emits a deprecated
   request shape and gets a `400 "thinking.type.enabled" is not supported for
this model` from the API. The user's _configured_ CLI should win.

3. **(Spec 03)** The one shell site uses a **non-interactive** login shell
   (`-lc`). Toolchain PATH lines (nvm/fnm/Homebrew/Volta) very commonly live in
   `.zshrc` / `.bashrc`, which a login-but-non-interactive shell does **not**
   source — so `-lc` misses them. `env -i HOME=$HOME /bin/zsh -lc 'command -v
claude'` returns empty where `-ilc` returns the real path.

## Scope

**In scope:** `src-tauri/src/lib.rs` only — the `resolve_claude_binary` resolution
order, a new pure PATH-builder, its wiring into `spawn_claude_resume`, and the
shell invocation flag. Unit tests for the pure builder.

**Out of scope / do NOT do:**

- Do **not** duplicate `.env_remove("ANTHROPIC_API_KEY")` — already present at the
  spawn site (`src-tauri/src/lib.rs:1260`).
- Do **not** delete or modify the user's stale `claude` install — spec 02 only
  changes _preference order_, never the filesystem.
- Do **not** paste code from the specs verbatim — they are behavior descriptions;
  match this file's existing conventions (it already has pure, unit-tested
  helpers like `classify_claude_outcome`).
- Automated verification of the real `.app`-from-Finder behavior is **manual and
  out of scope** for tests — the packaged-launchd environment can't be
  reconstructed in `cargo test`.

## Current ground truth (verified in `src-tauri/src/lib.rs`)

- `resolve_claude_binary()` at `:1097` resolves in order: (1) `which claude`
  (`:1099`, only trusts a result that `is_file()`); (2) hardcoded install-dir
  scan (`:1111`, incl. `~/.nvm/versions/node/*/bin/claude` sorted newest-first);
  (3) login shell `$SHELL -lc 'command -v claude'` (`:1140`), last non-empty
  stdout line, guarded by `is_file()`. Doc comment describing the order is at
  `:1090–1096`; the comment defending `-lc` is at `:1136–1138`.
- `spawn_claude_resume()` at `:1223` builds `Command::new(&claude_bin)` with
  `--resume`/`--session-id`, `--print`, `--output-format stream-json`,
  `--include-partial-messages`, `--verbose`, optional `--add-dir`; already calls
  `.env_remove("ANTHROPIC_API_KEY")` at `:1260`; **does not** set `.env("PATH",
…)`.
- Existing test `resolve_claude_binary_returns_path_or_actionable_error` at
  `:513` (in the `#[cfg(test)] mod tests` block). Pure helpers like
  `classify_claude_outcome` are unit-tested there — mirror that convention.

## Approach

Three units, sequenced so the shared shell helper exists before its callers use
it. All shell reads move to an **interactive** login shell (`-ilc`) with a
sentinel-prefixed protocol so banners/rc noise can't be mistaken for the payload.

### U2 — Reorder resolution: shell wins over dir scan

**File:** `src-tauri/src/lib.rs` (`resolve_claude_binary`, `:1097–1169`).

Swap the order so the user's configured CLI is preferred over a hardcoded scan:

1. `which claude` (unchanged — only trust an existing file).
2. **Login shell** `command -v claude` (moved up from step 3).
3. **Hardcoded install-dir scan** (moved down to last).

Rationale: the dir scan is a _fallback_, not an authority. The shell reflects what
the user actually configured (nvm default, Homebrew, a `local/claude`); letting
the scan preempt it is what selects the stale binary in spec 02. The scan must
never preempt the shell's choice.

Update the doc comment at `:1090–1096` so the described order matches (try order:
existing PATH → login shell → common install locations).

### U3 — Interactive login shell + sentinel protocol (shared helper)

**File:** `src-tauri/src/lib.rs`.

The shell is read for two distinct purposes now (resolve the binary; read the
login PATH for U1), so extract a small **shell-read helper** rather than
duplicating the invocation. Directional sketch (not implementation spec):

- A helper that runs `$SHELL -ilc <script>` (SHELL from env, fallback `/bin/sh`)
  and returns captured stdout on success. `-ilc`, **not** `-lc`: interactive so
  `.zshrc`/`.bashrc` toolchain lines are sourced; login so profile files are too;
  `-c` to run the one script we pass.
- **Binary resolution** runs `command -v claude` and takes the **last non-empty
  stdout line** (banner-proof — an interactive shell may print rc/profile
  chatter before the answer), then guards with `is_file()` exactly as today.
- **PATH read** (new, feeds U1) runs `printf '<SENTINEL>%s\n' "$PATH"` and returns
  the text **after the sentinel on the sentinel-bearing line**. A unique sentinel
  (e.g. `___QUILL_PATH___`) survives interleaved rc output where "last line"
  alone would not, since a trailing banner could otherwise clobber a plain PATH
  echo.

Update the comment at `:1136–1138` that currently defends `-lc` to explain why an
**interactive** login shell is required (toolchain PATH lines commonly live in
interactive-only rc files).

Keep both reads resilient: a shell that errors, prints nothing, or omits the
sentinel yields `None`/empty and the caller falls through to its next source —
never a panic, never a bogus path handed to `Command::new`.

### U1 — Pure child-PATH builder + wire into spawn

**File:** `src-tauri/src/lib.rs`.

Add a **pure** function so it is unit-testable without touching the process
environment:

```
fn build_child_path(
    claude_bin: &Path,          // the resolved claude binary
    login_shell_path: Option<&str>, // U3 sentinel PATH read, may be None
    inherited_path: Option<&str>,   // std::env::var("PATH"), may be None
    home: &str,                 // std::env::var("HOME")
) -> String
```

Assembly — **highest priority first, de-duplicated preserving first occurrence,
colon-joined**:

1. **(a)** The directory the resolved `claude` binary lives in
   (`claude_bin.parent()`). This is the single most reliable entry: it is exactly
   where the working `claude` (and its sibling `node`, for nvm/Homebrew layouts)
   resides.
2. **(b)** The login-shell PATH entries (from U3's sentinel read), split on `:`,
   in order.
3. **(c)** The already-inherited PATH entries (`inherited_path`), split on `:`.
4. **(d)** Well-known fallback dirs, in this order: every
   `~/.nvm/versions/node/*/bin` **newest-first** (same discovery + sort as the
   existing dir scan — reuse or mirror it), then `~/.local/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin`, then the standard system dirs
   (`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`). (d) guarantees a usable PATH even
   when both (b) and (c) are absent — the packaged-`.app` worst case.

De-dup rule: an entry already emitted by an earlier source is skipped when it
recurs later (first occurrence wins, preserving priority). Empty segments are
dropped.

**Wire into `spawn_claude_resume` (`:1223+`):** after `resolve_claude_binary`
returns `claude_bin`, read the login-shell PATH via U3's helper, call
`build_child_path(&claude_bin, login_path.as_deref(), std::env::var("PATH").ok().as_deref(), &home)`,
and set `.env("PATH", &computed)` on the command — alongside the existing
`.env_remove("ANTHROPIC_API_KEY")` at `:1260` (do not remove or duplicate that
line).

## Implementation units

| Unit | File                   | Summary                                                                                                           | Depends on                       |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| U2   | `src-tauri/src/lib.rs` | Reorder `resolve_claude_binary`: which → login shell → dir scan last; update doc comment `:1090–1096`             | —                                |
| U3   | `src-tauri/src/lib.rs` | Shell-read helper: `-ilc`, last-non-empty-line binary resolution, sentinel PATH read; update `:1136–1138` comment | — (used by U2's shell step & U1) |
| U1   | `src-tauri/src/lib.rs` | Pure `build_child_path`; wire `.env("PATH", …)` into `spawn_claude_resume`                                        | U3 (login-PATH source)           |

Recommended build order: **U3 → U2 → U1** (helper first, then the resolver that
uses it, then the builder that consumes both the resolved binary and the login
PATH).

## Test scenarios

Tests live in the existing `#[cfg(test)] mod tests` block in
`src-tauri/src/lib.rs` (alongside `resolve_claude_binary_returns_path_or_actionable_error`
at `:513` and the `classify_claude_outcome` tests). Only the **pure** builder is
unit-tested; shell-dependent and packaged-`.app` behavior is manual.

**`build_child_path` (U1) — required unit tests:**

1. **Includes the claude binary's own dir.** Given `claude_bin =
/Users/x/.nvm/versions/node/v20/bin/claude`, the result contains
   `/Users/x/.nvm/versions/node/v20/bin`.
2. **Claude dir comes first.** With a non-empty login PATH and inherited PATH
   supplied, the claude binary's dir is the **first** colon-segment of the
   result (priority (a) beats (b)/(c)/(d)).
3. **De-dups preserving first occurrence.** When the same dir appears in the
   claude dir, the login PATH, and the inherited PATH, it appears **exactly once**
   in the result, at its earliest (highest-priority) position.
4. **Well-known dirs present when login+inherited both absent.** With
   `login_shell_path = None` and `inherited_path = None`, the result still
   contains the fallback dirs (`/opt/homebrew/bin`, `/usr/local/bin`,
   `~/.local/bin` expanded against `home`, and the standard system dirs) — the
   packaged-`.app` worst case still yields a usable PATH.

Add assertions as natural: no empty segments in the output; nvm bin dirs (when
present under the test `home`) are ordered newest-first, mirroring the existing
scan.

**`resolve_claude_binary` (U2/U3):** keep the existing
`resolve_claude_binary_returns_path_or_actionable_error` test green (environment-
dependent: an absolute path on a dev machine, an actionable error in bare CI —
never a panic). No new deterministic unit test is added for the reordered
resolver because it shells out; the ordering change is covered by review + the
existing non-panic guarantee.

## Verification

- `cd src-tauri && cargo test` — all green, including the four new
  `build_child_path` tests and the existing resolver test.
- `cd src-tauri && cargo clippy -- -D warnings` — clean (no new warnings from the
  helper or builder).
- `cd src-tauri && cargo fmt --check` — clean.
- Frontend checks unaffected (Rust-only change) but run the full bar before PR:
  `npm run typecheck && npm run lint && npm run format:check && npm test`.
- **Manual (out of automated scope):** build the `.app` (`npm run tauri build`),
  launch from Finder, trigger an `@claude` reply, and confirm it streams a
  response instead of `env: node: No such file or directory` — and that the reply
  does not 400 on a deprecated request shape (confirming the configured, not
  stale, binary was used).

## Risks & notes

- **Interactive shell side effects.** `-ilc` sources rc files, which may print
  banners or run slow init. Mitigated by the sentinel protocol (payload is
  unambiguous regardless of surrounding chatter) and by the existing pattern of
  taking the last/marked line. Cost is one extra shell spawn per `@claude` reply
  (the new PATH read); acceptable for a user-initiated action.
- **de-dup correctness is the load-bearing invariant** for U1 — test 3 locks it.
  A regression here would either bloat PATH harmlessly or (worse) reorder
  priority; the "first occurrence wins" rule keeps priority intact.
- This is **LFG Group 1** of a multi-group port (specs 01–03). Groups 2–5 follow
  in separate LFG cycles.
