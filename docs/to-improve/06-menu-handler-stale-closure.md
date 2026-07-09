# 06 — Cmd+S (and other native-menu shortcuts) use stale handlers

**Area:** `src/App.tsx` (native menu event wiring) · **Type:** bug (stale closure)

## Problem

Native menu actions (File → Save, New, Open, Save As, Export PDF, Quit, Copy
Diagnostics, Show Logs) behave as if the app is stuck on its initial state. The
clearest symptom: **Cmd+S / File → Save always routes to "Save As"** (shows a save
dialog) even for an already-saved file, because it sees `filePath = null` — the
value from first render — instead of the current file path.

## Root cause

The menu-event listeners are registered once (in a mount effect). The handlers
live in a ref (`menuHandlersRef`) that is **reassigned to a fresh object every
render**, because the handlers close over changing state (`filePath`, `comments`,
etc.). The buggy wiring aliased `menuHandlersRef.current` into a local variable
**at registration time**:

```ts
const h = menuHandlersRef.current; // ← snapshot of the FIRST render's handlers
await wire('menu-save', () => void h.handleSave()); // frozen forever
```

That local `h` captures only the first render's closures. Every menu action then
runs against first-render state.

## The change

Read `menuHandlersRef.current` **inside each callback (at fire time)**, never
aliased into a local at registration:

```ts
await wire('menu-save', () => void menuHandlersRef.current.handleSave());
await wire('menu-new', () => menuHandlersRef.current.handleNew());
// …same for save-as, export-pdf, quit, copy-diagnostics, reveal-logs
```

The ref is the whole point — it exists so the once-registered listener can reach
the _latest_ handlers. Dereference it late.

## Verify

- Add a unit test (mirror the fork's `src/test/utils/menuHandlerRef.test.ts`):
  simulate the ref being reassigned across renders, fire a wired callback, assert
  it invokes the **latest** handler, not the one present at registration.
- Real-app check: open and save a file, edit, Cmd+S → saves in place (no Save-As
  dialog).

## Notes for the porter

- General principle: when a long-lived listener needs current state, keep the
  state in a ref and read `ref.current` at call time — do **not** copy `.current`
  into a local at registration. The fork's Open-Recent handler already did this
  correctly and was the reference for the fix.
- The exact set of `menu-*` events depends on which menu items the public repo
  exposes; apply the read-at-fire-time pattern to all of them.
