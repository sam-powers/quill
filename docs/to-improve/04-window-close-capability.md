# 04 — Window won't close from the unsaved-changes dialog

**Area:** Rust capability grant + `src/App.tsx` · **Type:** bug

## Problem

The unsaved-changes guard (the Save / Don't Save / Cancel dialog that intercepts
window close, New, Open, etc.) can't actually close the window when the user
chooses "Don't Save" (or after saving). The window-close is intercepted by the
frontend guard, but the frontend's attempt to then destroy/close the window is
denied by Tauri's capability ACL, so the window stays open.

## Root cause

Tauri 2 gates frontend-initiated window operations behind explicit **capability
permissions**. The app intercepts the OS close request (to run the dirty-check
first) but was never granted the permission to programmatically destroy the
window afterward, so the follow-through close is silently blocked.

## The change

1. **Grant the window-destroy capability.** Add `core:window:allow-destroy` (the
   Tauri 2 permission for `Window.destroy()`) to the app's capability file
   (whatever the public repo uses — commonly `src-tauri/capabilities/default.json`,
   scoped to the `"main"` window).
2. **Call it on the confirmed-close path** in `App.tsx`: after the dirty check
   resolves (user picked Don't Save, or Save completed), destroy the window. Wrap
   the guard logic so that if anything in the save path throws, the `catch`
   destroys the window anyway rather than trapping the user in an un-closable
   window.

## Verify

- Open a doc, make an edit (dirty), hit the window close button → dialog appears →
  "Don't Save" → window actually closes.
- Same with "Save" → saves, then closes.
- Force an error in the save path (e.g. cancel the save dialog) → the window still
  closes via the catch, not trapped open.

## Notes for the porter

- The exact permission string is Tauri-version-specific; `core:window:allow-destroy`
  is correct for Tauri 2. If the public repo already grants broader window perms,
  this may be a no-op on the capability side and only need the `App.tsx` follow-through.
- Only grant what's needed (destroy), not blanket window permissions.
