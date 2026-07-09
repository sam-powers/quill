# 01 — claude CLI: give the spawned process a working PATH

**Area:** Rust backend (`src-tauri/src/lib.rs`) · **Type:** bug · **Related:** 02, 03

## Problem

When Quill is launched as a packaged macOS `.app` (Finder/Dock/Spotlight) rather
than from a terminal, `@claude` replies fail immediately. The spawned `claude`
CLI is a Node script (`#!/usr/bin/env node`, or a shim that re-execs one), and it
dies with:

```
env: node: No such file or directory
```

## Root cause

A GUI app launched by macOS `launchd` inherits a **minimal PATH** (roughly
`/usr/bin:/bin:/usr/sbin:/sbin`) — none of nvm/fnm/Homebrew/Volta dirs where
`node` lives. A terminal launch (`npm run tauri dev`) inherits the shell's full
PATH, so this never reproduces in dev. When Quill spawns `claude` with the
inherited (minimal) environment, `claude`'s `env node` lookup finds no `node`.

## The change

When spawning the `claude` CLI (the command backing `@claude` replies and
full-document review), set the child process's `PATH` env var to a computed PATH
that includes `node`, instead of letting it inherit the minimal launchd PATH.

Build that PATH from these sources, highest priority first, de-duplicated
(preserve first occurrence), colon-joined:

1. **The directory the resolved `claude` binary lives in.** `node` is very often
   its sibling (same nvm/fnm version dir, same Homebrew `bin`). This single entry
   fixes the common case even if everything else fails.
2. **The login shell's PATH** — the authoritative source for whatever the user
   configured (nvm/fnm/Homebrew/Volta). See spec 03 for how to read this
   correctly (it must source the interactive rc file).
3. **The already-inherited PATH** — covers the `tauri dev` / terminal case.
4. **Well-known fallback dirs** as a backstop: every `~/.nvm/versions/node/*/bin`
   (newest version first), `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
   and the standard system dirs.

Implement the PATH assembly as a **pure function** taking `(claude_bin_path,
login_shell_path, inherited_path, home)` so it can be unit-tested without
touching the environment. Then in the spawn command, `.env("PATH", &computed)`.

Also `.env_remove("ANTHROPIC_API_KEY")` on the spawned command if the public repo
doesn't already — Quill drives `claude` as the user's own CLI session, and a stray
API-key env var can change which credentials/endpoint the CLI uses.

## Verify

- Unit tests for the pure PATH builder: (a) includes the claude binary's own dir;
  (b) claude dir comes first; (c) de-dups preserving first occurrence; (d) still
  produces the well-known dirs when login+inherited PATH are both absent.
- Real-app check: build the `.app`, launch it from Finder (not a terminal),
  trigger an `@claude` reply, confirm it runs instead of `env: node` failing.

## Notes for the porter

- The public repo may resolve/spawn `claude` slightly differently — apply the
  _intent_ (spawned child gets a node-containing PATH), matching the repo's
  existing spawn code.
- This is the same `spawn_claude_resume` path used by both single-comment replies
  and full-document review, so fixing it once covers both.
