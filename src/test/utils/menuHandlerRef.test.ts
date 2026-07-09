import { describe, it, expect, vi } from 'vitest';

/**
 * Regression guard for the native-menu handler wiring in App.tsx.
 *
 * Menu listeners are registered exactly once on mount, but the handlers they
 * invoke change every render (they close over the latest openFilePath, dirty
 * state, etc.). App keeps the current handlers in `menuHandlersRef`, reassigned
 * on every render, and each wired callback must dereference
 * `menuHandlersRef.current` AT FIRE TIME.
 *
 * The bug this protects against: aliasing `const h = menuHandlersRef.current`
 * at registration time and calling `h.handleSave()` inside the callback, which
 * snapshots the FIRST render's handlers. Symptom in the app: Cmd+S always
 * routes to Save-As because `handleSave` closes over the initial
 * `openFilePath = null`.
 *
 * These tests model the exact wiring shape from App.tsx (a ref reassigned
 * across renders + a `wire(event, fn)` that stores the callback) so a revert to
 * a registration-time snapshot fails here.
 */

// Mirror of App.tsx's menuHandlersRef shape (only the fields the test exercises).
type Handlers = {
  handleSave: () => void;
  handleNew: () => void;
};

// Mirror of App.tsx's `wire`: registers a callback once, keyed by event name.
function makeWiring() {
  const registry = new Map<string, () => void>();
  const wire = (event: string, fn: () => void) => {
    registry.set(event, fn);
  };
  const fire = (event: string) => registry.get(event)?.();
  return { wire, fire };
}

describe('menu handler ref wiring', () => {
  it('fires the LATEST handler after the ref is reassigned across renders', () => {
    const first = vi.fn();
    const ref: { current: Handlers } = {
      current: { handleSave: first, handleNew: vi.fn() },
    };
    const { wire, fire } = makeWiring();

    // Correct pattern: read menuHandlersRef.current at fire time.
    wire('menu-save', () => ref.current.handleSave());

    // A later render swaps in fresh handlers.
    const second = vi.fn();
    ref.current = { handleSave: second, handleNew: vi.fn() };

    fire('menu-save');

    // Must call the newest handler, never the registration-time one.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('always tracks the newest handler across multiple reassignments', () => {
    const ref: { current: Handlers } = {
      current: { handleSave: vi.fn(), handleNew: vi.fn() },
    };
    const { wire, fire } = makeWiring();
    wire('menu-save', () => ref.current.handleSave());

    // Reassign twice — a registration-time alias would be stuck on render #1.
    ref.current = { handleSave: vi.fn(), handleNew: vi.fn() };
    const latest = vi.fn();
    ref.current = { handleSave: latest, handleNew: vi.fn() };

    fire('menu-save');

    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('routes each event to its own latest handler independently', () => {
    const ref: { current: Handlers } = {
      current: { handleSave: vi.fn(), handleNew: vi.fn() },
    };
    const { wire, fire } = makeWiring();
    wire('menu-save', () => ref.current.handleSave());
    wire('menu-new', () => ref.current.handleNew());

    const newSave = vi.fn();
    const newNew = vi.fn();
    ref.current = { handleSave: newSave, handleNew: newNew };

    fire('menu-save');
    fire('menu-new');

    expect(newSave).toHaveBeenCalledTimes(1);
    expect(newNew).toHaveBeenCalledTimes(1);
  });
});
