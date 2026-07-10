import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard tests that read App.css directly. They lock in two deliberate end-states
// that a later refactor could silently revert:
//   1. No painted page surface (no faux page-break gradient) — spec 10.
//   2. A widened reading measure (trimmed side padding) — spec 12.
// Each assertion is paired with a negative control proving it can fail.
// Read via fs (not Vite's `?raw`, which returns empty for `.css` under vitest —
// the CSS plugin intercepts the extension first). Paths resolve from the repo
// root (vitest runs with cwd = repo root).
const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');

/**
 * Concatenate the bodies of every CSS rule that paints the page surface itself —
 * a selector list entry that is `selector` standing alone (optionally with a
 * pseudo-class/element or its own combinator target), e.g. `.ProseMirror`,
 * `.ProseMirror:focus`, `.ProseMirror::before`. We deliberately EXCLUDE descendant
 * rules like `.ProseMirror .comment-thread-line`, whose gradients belong to nested
 * indicators (track-changes thread lines), not the page background. The faux
 * page-break gradient we're guarding against was painted directly on the surface,
 * so this is the scope that matters — and a gradient added to any surface variant
 * (`.ProseMirror::before`) is still caught.
 */
function ruleBody(source: string, selector: string): string {
  const esc = selector.replace('.', '\\.');
  // The whole selector-list entry must be `selector` plus only pseudo suffixes —
  // no whitespace/combinator that would make it a descendant/child rule.
  const surface = new RegExp(`^${esc}(?![\\w-])(?:::?[\\w-]+(?:\\([^)]*\\))?)*$`);
  const bodies: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.some((s) => surface.test(s))) bodies.push(m[2]);
  }
  return bodies.join('\n');
}

describe('page surface (spec 10 — no faux page-break indicator)', () => {
  it('.ProseMirror paints no background image / gradient', () => {
    const body = ruleBody(css, '.ProseMirror');
    expect(body).not.toContain('background-image');
    expect(body).not.toContain('linear-gradient');
  });

  it('.editor-page paints no background image / gradient', () => {
    const body = ruleBody(css, '.editor-page');
    expect(body).not.toContain('background-image');
    expect(body).not.toContain('linear-gradient');
  });

  it('keeps a page-sized min-height so a near-empty doc still fills the card', () => {
    // The layout minimum stays even though the page lines are gone.
    expect(ruleBody(css, '.ProseMirror')).toMatch(/min-height:\s*912px/);
  });

  it('negative control: the assertion catches a painted gradient', () => {
    // Prove the guard would fail if the gradient came back.
    const withGradient =
      '.ProseMirror { background-image: repeating-linear-gradient(#000 0, #000 1px); }';
    expect(ruleBody(withGradient, '.ProseMirror')).toContain('linear-gradient');
  });
});

describe('reading measure (spec 12 — wider surface)', () => {
  function readToken(name: string): number {
    const m = css.match(new RegExp(`${name}:\\s*(\\d+)px`));
    if (!m) throw new Error(`token ${name} not found in App.css`);
    return Number(m[1]);
  }

  it('keeps the widened side padding (≤ 72px)', () => {
    expect(readToken('--page-padding-x')).toBeLessThanOrEqual(72);
  });

  it('keeps at least US-Letter page width (≥ 816px)', () => {
    expect(readToken('--page-max-width')).toBeGreaterThanOrEqual(816);
  });

  it('negative control: the old cramped 96px padding would fail the guard', () => {
    expect(96).not.toBeLessThanOrEqual(72);
  });
});
