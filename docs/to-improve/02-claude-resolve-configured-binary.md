# 02 — claude CLI: resolve the user's configured binary, not a stale copy

**Area:** Rust backend (`src-tauri/src/lib.rs`) · **Type:** bug · **Related:** 01, 03

## Problem

`@claude` replies fail deterministically with an API error like:

```
API Error: 400 "thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

Retrying just re-hits the same error. The user has a current, working `claude`
CLI — but Quill is invoking a **different, stale** one.

## Root cause

Quill resolves the `claude` binary by scanning a hardcoded list of install
directories (including every `~/.nvm/versions/node/*/bin/claude`). If an old
global install exists there (e.g. a months-old `npm i -g @anthropic-ai/claude-code`
under an old Node version), the dir scan finds **that** one first — not the
current `claude` the user's shell actually resolves. The stale CLI emits a
deprecated request shape that the current model rejects with a 400.

The tell: the failing session's transcript entries are tagged with the **old**
CLI version (e.g. `version: 2.1.104`) while the user's real `claude --version`
reports something newer. Picking the wrong-version binary is a silent
**correctness** bug, not a "not found" error.

## The change

Reorder `claude` binary resolution so the **user's configured CLI wins**:

1. **Bare `which claude`** first (works under `tauri dev` / terminal launch where
   PATH is already good). Only trust the result if it names an existing file.
2. **Ask the user's shell**: run `command -v claude` through their login shell
   (see spec 03 for why it must be an _interactive_ login shell) — this resolves
   the `claude` the user actually uses. Take the last non-empty stdout line (so an
   rc banner can't be mistaken for the path) and verify it's a real file.
3. **Only then**, as a last-ditch fallback, scan the hardcoded install dirs. A
   stale install here is strictly better than failing outright — but it must
   **never preempt** the user's shell choice above.

The principle: **when resolving a user's installed CLI from a GUI app, the tool
their shell resolves is authoritative.** Consult the shell before scanning
install dirs; a machine may have several `claude` installs of different ages, and
the dir scan must not silently shadow the current one.

## Verify

- Confirm resolution returns the shell-resolved `claude` even when a stale copy
  exists in one of the scanned dirs (leave the stale copy in place; the new logic
  should skip past it via the shell step).
- Real-app check: `@claude` reply succeeds in the built `.app` where it previously
  400'd.

## Notes for the porter

- This pairs with spec 01: 01 makes the spawned CLI _run_; 02 makes sure it's the
  _right_ CLI. Do them together.
- Do not delete or modify the user's stale install — just make resolution prefer
  the configured one.
