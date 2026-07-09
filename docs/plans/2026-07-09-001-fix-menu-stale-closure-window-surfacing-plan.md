---
title: 'fix: menu stale-closure, window-close capability, and deep-link window surfacing'
date: 2026-07-09
type: fix
status: planned
plan_depth: lightweight
---

# fix: Menu stale-closure, window-close capability, and deep-link window surfacing

Group 2 of a multi-group port from a downstream fork. Three small, independent
defects ported as **behavior specs** (not patches) from `docs/to-improve/`:

- `docs/to-improve/04-window-close-capability.md`
- `docs/to-improve/05-deep-link-surface-window.md`
- `docs/to-improve/06-menu-handler-stale-closure.md`

Each is applied to match this repo's existing conventions. The specs' own code is
reference only — the ground truth below reflects the current state of this repo,
verified before planning.

---

## Problem Frame

Three latent defects, all reachable in the shipped desktop app:

1. **Window won't close from the unsaved-changes dialog (spec 04).** The
   `onCloseRequested` guard in `src/App.tsx` correctly calls `win.destroy()` on
   both the guard-resolved ("Don't Save") path and the catch path — but the
   Tauri capability set does not grant `core:window:allow-destroy`. A
   frontend-initiated `destroy()` is blocked by the ACL, so choosing "Don't
   Save" (or hitting the catch) silently fails to close the window. This is a
   real present bug in the built app, not a theoretical one.

2. **Deep link opens the doc but leaves the window hidden/behind (spec 05).**
   The `on_open_url` deep-link handler in `src-tauri/src/lib.rs` emits
   `deep-link-open` so the frontend loads the file, but never surfaces the main
   window. If Quill is running hidden, minimized, or in the background, a
   `quill://open?file=…` link loads the document invisibly — the user sees
   nothing happen.

3. **Cmd+S and other native-menu shortcuts fire stale handlers (spec 06).** The
   menu-event effect in `src/App.tsx` registers Tauri listeners exactly once on
   mount, reading handlers through a ref that is refreshed every render. But the
   wiring aliases `const h = menuHandlersRef.current` at registration time and
   dereferences `h.` inside each callback — snapshotting the **first render's**
   handlers. Symptom: Cmd+S always routes to Save-As because `handleSave` closes
   over the initial `openFilePath = null`. Every menu action except Open Recent
   (which already reads the ref at fire time) and Clear Recent (which calls
   module functions directly) is affected. The effect's own trailing comment
   claims "handlers are read live through menuHandlersRef" — which is exactly
   what the buggy alias breaks.

## Scope Boundaries

**In scope:** the three fixes above, plus one unit test for the menu
stale-closure (the only automated-testable piece).

**Out of scope / explicitly excluded:**

- Any other change to `src/App.tsx` beyond the menu-wiring fix. The
  `onCloseRequested` guard already calls `win.destroy()` correctly on both paths
  — do **not** re-touch it.
- The asset-protocol `$HOME` scope in `tauri.conf.json` — leave untouched.
- Broad window capabilities. Grant **only** `core:window:allow-destroy`, not a
  blanket window permission set.
- The cold-start pending-deep-link path (`take_pending_deep_link` /
  `PendingDeepLink`). Surfacing belongs on the warm `on_open_url` emit path where
  a running window exists; cold start already launches and surfaces the app
  through normal startup.
- Internal Amazon/Brazil fork adaptations (build wiring, dependency mirror, CSP
  scrubbing, font vendoring, plugin repointing, update-checker removal) — never
  ported.

## Requirements

- **R1** — Choosing "Don't Save" (or the catch path) in the unsaved-changes
  dialog on window close actually closes the window. (spec 04)
- **R2** — A `quill://open?file=…` deep link received while the app is running
  brings the main window to the foreground (shown, unminimized, focused) in
  addition to loading the document. (spec 05)
- **R3** — Native-menu shortcuts (Cmd+S in particular) invoke the current
  render's handlers, so Save saves to the open file rather than always prompting
  Save-As. (spec 06)
- **R4** — The menu-handler-ref contract is protected by a unit test that fails
  if wiring reverts to a registration-time snapshot.

## Key Technical Decisions

- **Grant exactly `core:window:allow-destroy` (spec 04).** Verified against
  `src-tauri/gen/schemas/acl-manifests.json`: `core:default` bundles
  `core:window:default`, which is read-only window commands and does **not**
  include `allow-destroy`. `allow-destroy` is a valid grantable permission.
  Adding just that one permission is the minimal grant that unblocks the
  existing `win.destroy()` calls — no App.tsx change needed. Frontend-initiated
  window operations are the only ones gated by capabilities; this is why the
  Rust-side surfacing in spec 05 needs no capability change.

- **Surface the window in Rust, best-effort (spec 05).** After the existing
  `handle.emit("deep-link-open", path)`, resolve the main window via
  `handle.get_webview_window("main")` (the `Manager` trait is already imported at
  `src-tauri/src/lib.rs:10`; window label `"main"` matches the capability scope)
  and call `show()`, `unminimize()`, `set_focus()`, ignoring each `Result` with
  `let _ =` — the same best-effort style the surrounding closure already uses for
  `emit`. Rust-initiated window ops are not capability-gated, so no
  `default.json` change accompanies this. Additive only: a few lines inside the
  existing `if let Some(path) = …` branch, after the emit.

- **Read the ref at fire time, per callback (spec 06).** Delete the
  `const h = menuHandlersRef.current` alias and make each wired callback
  dereference `menuHandlersRef.current` when it runs, mirroring the Open-Recent
  block that already does this correctly (`const cur = menuHandlersRef.current`
  inside the callback). This keeps the register-once / read-live design the
  effect's comment already documents — the fix makes the code match its stated
  contract. `menu-clear-recent` already calls module functions directly (not via
  `h`); leave it as-is.

- **Unit-test the ref contract, not the whole effect (spec 06).** The failing
  behavior is purely "does the wired callback read the latest ref value or a
  snapshot?" A focused unit test that simulates a ref reassigned across renders
  and asserts the wired callback invokes the latest handler pins the contract
  without standing up Tauri's `listen`. Deep-link surfacing and the capability
  grant are verified manually in a built `.app` (out of automated-test scope).

## Implementation Units

### U1. Grant `core:window:allow-destroy` capability

**Goal:** Unblock the frontend-initiated `win.destroy()` so the unsaved-changes
dialog can actually close the window. (R1)

**Requirements:** R1

**Dependencies:** none

**Files:**

- `src-tauri/capabilities/default.json` (modify)

**Approach:** Add `"core:window:allow-destroy"` to the `permissions` array.
Grant only that one permission — do not add blanket window perms. The App.tsx
`onCloseRequested` guard already calls `win.destroy()` on both the
guard-resolved and catch paths; this is the only missing piece.

**Patterns to follow:** the existing flat string-array entries in
`permissions` (e.g. `"dialog:allow-open"`).

**Test scenarios:** `Test expectation: none — capability-manifest JSON change;
verified manually in a built .app by choosing "Don't Save" on window close and
confirming the window closes. No automated harness exercises the Tauri ACL.`

**Verification:** `cargo test` and `cargo clippy -- -D warnings` still pass (the
capability file is validated at build time); the JSON remains well-formed and
`prettier`-clean.

### U2. Surface the main window on warm deep-link open

**Goal:** Bring the main window to the foreground when a `quill://open` link
arrives while the app is running. (R2)

**Requirements:** R2

**Dependencies:** none

**Files:**

- `src-tauri/src/lib.rs` (modify — the `on_open_url` closure, ~`:1527`)

**Approach:** Immediately after the existing
`let _ = handle.emit("deep-link-open", path);` (currently `src-tauri/src/lib.rs:1535`),
add a best-effort surfacing block: resolve `handle.get_webview_window("main")`
and, when present, call `.show()`, `.unminimize()`, `.set_focus()`, discarding
each `Result` with `let _ =`. `Manager` (providing `get_webview_window`) is
already imported at `src-tauri/src/lib.rs:10`; `handle` is already cloned before
the closure. Keep it inside the existing `if let Some(path) = parse_quill_open(…)`
branch. Do **not** touch the cold-start `PendingDeepLink` buffering — that path
surfaces via normal startup.

**Patterns to follow:** the surrounding closure's own best-effort style —
`let _ = handle.emit(...)` and `let _ = app.emit(id, ())` elsewhere in `setup`.

**Test scenarios:** `Test expectation: none — Tauri window surfacing has no
headless-testable seam here; verified manually in a built .app by minimizing the
window, opening a quill://open?file=… link, and confirming the window comes
forward with the document loaded.`

**Verification:** `cargo test`, `cargo clippy -- -D warnings`, and
`cargo fmt --check` pass; the added lines compile with no unused-import or
unused-result warnings.

### U3. Fix menu-handler stale closure + add ref-contract unit test

**Goal:** Make native-menu callbacks invoke the current render's handlers, and
protect that with a unit test. (R3, R4)

**Requirements:** R3, R4

**Dependencies:** none

**Files:**

- `src/App.tsx` (modify — the menu-event `useEffect`, ~`:626`–`:643`)
- `src/test/utils/menuHandlerRef.test.ts` (create)

**Approach:** In the menu-event effect, remove the
`const h = menuHandlersRef.current` alias and rewrite each `wire(...)` callback
to read `menuHandlersRef.current` at fire time — e.g.
`await wire('menu-save', () => void menuHandlersRef.current.handleSave())` — for
all of: `menu-new`, `menu-open`, `menu-save`, `menu-save-as`,
`menu-export-pdf`, `menu-quit`, `menu-copy-diagnostics`, `menu-reveal-logs`.
Preserve the existing `void`/no-`void` shape per handler (the async ones keep
`void`). Leave `menu-clear-recent` (calls module functions directly) and the
Open-Recent block (already reads `menuHandlersRef.current` at fire time)
untouched. This makes the code match the effect's existing trailing comment,
"handlers are read live through menuHandlersRef."

For the test: model the ref-read pattern in isolation. Build a small harness that
mirrors the wiring — a mutable ref object whose `.current` is reassigned to
simulate a later render, and a `wire(event, fn)` that stores `fn`. Fire the
stored callback **after** reassigning the ref, and assert it invokes the latest
handler, not the one present at registration. A registration-time snapshot
(`const h = ref.current`) must make the test fail; a fire-time read
(`ref.current.handler()`) must make it pass.

**Patterns to follow:** the Open-Recent handler in the same effect
(`src/App.tsx:650`, `const cur = menuHandlersRef.current` inside the callback) is
the correct reference model. For the test file, mirror the structure and imports
of existing specs under `src/test/utils/` (Vitest `describe`/`it`/`expect`).

**Test scenarios** (`src/test/utils/menuHandlerRef.test.ts`):

- **Covers R4.** Fire-time read invokes the latest handler: given a ref whose
  `.current.handleSave` is `fnA` at wiring time, wire a callback that reads
  `ref.current.handleSave()`, then reassign `ref.current` so `handleSave` is
  `fnB`, fire the callback, and assert `fnB` was called and `fnA` was not.
- **Guard against snapshot regression:** demonstrate that the fire-time pattern
  survives multiple reassignments — reassign the ref twice and confirm the
  callback always calls the newest handler. (This is the assertion a
  registration-time alias would fail.)
- **Multiple events, independent handlers:** wire two events reading different
  keys off the ref (`handleSave`, `handleNew`); reassign both; fire each; assert
  each invokes its own latest handler. Confirms the pattern is per-callback, not
  shared state.

**Verification:** `npm run typecheck`, `npm run lint`, `npm run format:check`,
and `npm test` all pass; the new test fails if the wiring is reverted to a
`const h = menuHandlersRef.current` snapshot (sanity-check by temporarily
reintroducing the alias locally, confirming red, then reverting).

---

## Risks & Dependencies

- **Low blast radius.** All three changes are additive or localized. Spec 04 is a
  one-line capability addition; spec 05 is a few additive Rust lines on an
  existing branch; spec 06 removes an alias and inlines a ref read that the
  Open-Recent path already proves works.
- **The two runtime-only fixes (U1, U2) have no automated coverage** — this is
  inherent to Tauri capability ACLs and native window surfacing. Both are
  verified manually in a built `.app`. The plan does not pretend otherwise; the
  menu fix (U3), which _is_ testable, carries the unit test.
- **No cross-unit dependencies.** U1, U2, U3 are independent and can land in any
  order; they ship together as one PR for the Group 2 theme.

## Verification (whole change)

Match the CI bar before opening the PR:

- Frontend: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm test`.
- Rust: `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt --check` (run in
  `src-tauri/`).

Manual (built `.app`, out of automated scope, for the record):

- Spec 04: open a dirty doc, close the window, choose "Don't Save" → window
  closes.
- Spec 05: minimize/background the app, trigger a `quill://open?file=…` deep
  link → window comes forward with the doc loaded.
- Spec 06: open a saved file, edit, press Cmd+S → saves in place (no Save-As
  dialog).
