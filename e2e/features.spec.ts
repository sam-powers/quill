/**
 * Comprehensive feature test suite for Quill.
 *
 * Each test runs in its own page via Playwright's `page` fixture; the dev
 * server is started automatically by playwright.config.ts (webServer).
 *
 * Known-broken tests use `test.fixme(...)` so the suite is green on first
 * pass. Goal mode should convert each `.fixme` to a passing `test(...)`.
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';

// ── helpers ───────────────────────────────────────────────────────────────────

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
  return { editor };
}

async function enableSuggesting(page: Page) {
  const sw = page.locator('.mode-switch');
  await expect(sw).toContainText('Editing');
  await sw.click();
  await expect(sw).toContainText('Suggesting');
}

async function disableSuggesting(page: Page) {
  const sw = page.locator('.mode-switch');
  await expect(sw).toContainText('Suggesting');
  await sw.click();
  await expect(sw).toContainText('Editing');
}

async function selectAll(page: Page) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
}

async function selectLastNChars(page: Page, n: number) {
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
}

async function addCommentViaPlusButton(page: Page, replyText: string) {
  // The floating "+" button only appears while a selection is active.
  const btn = page.locator('.add-comment-btn');
  await btn.click();
  const textarea = page.locator('.add-comment-compose textarea');
  await textarea.fill(replyText);
  await page.locator('.add-comment-compose .btn-primary').click();
  await page.waitForTimeout(150);
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Basic typing & text content
// ────────────────────────────────────────────────────────────────────────────

test('editor mounts and is focusable', async ({ page }) => {
  const { editor } = await setup(page);
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
});

test('typing inserts text in normal mode', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);
  await expect(editor).toContainText('hello world');
});

test('Enter creates a new paragraph', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two');
  await page.waitForTimeout(100);
  const paragraphs = await editor.locator('p').count();
  expect(paragraphs).toBeGreaterThanOrEqual(2);
});

test('backspace deletes characters in normal mode', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await expect(editor).toContainText('hel');
  await expect(editor).not.toContainText('hello');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Toolbar formatting (normal mode)
// ────────────────────────────────────────────────────────────────────────────

test('bold via toolbar wraps selected text in <strong>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).toContain('<strong>');
});

test('italic via toolbar wraps selected text in <em>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Italic (Cmd+I)"]').click();
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).toContain('<em>');
});

test('underline via toolbar wraps selected text in <u>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Underline (Cmd+U)"]').click();
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).toContain('<u>');
});

test('strikethrough via toolbar wraps selected text in <s>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Strikethrough"]').click();
  await page.waitForTimeout(150);
  const html = await editor.innerHTML();
  expect(html.match(/<(s|strike|del)>/)).not.toBeNull();
});

test('Cmd+B keyboard shortcut applies bold', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await page.keyboard.down('Meta');
  await page.keyboard.press('b');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).toContain('<strong>');
});

test('Cmd+I keyboard shortcut applies italic', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await page.keyboard.down('Meta');
  await page.keyboard.press('i');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).toContain('<em>');
});

test('bold on partial selection only formats that range', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectLastNChars(page, 5);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).toContain('<strong>world</strong>');
});

test('toggling bold twice removes the bold mark', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.waitForTimeout(100);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).not.toContain('<strong>');
});

test('toolbar button does not lose selection (regression)', async ({ page }) => {
  // Known broken: clicking bold/italic with text selected drops the selection,
  // so subsequent toolbar clicks operate on a collapsed cursor.
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.waitForTimeout(100);
  // After bold, selection should still cover all 11 chars.
  const sel = await page.evaluate(() => {
    const s = window.getSelection();
    return { collapsed: s?.isCollapsed, text: s?.toString() };
  });
  expect(sel.collapsed).toBe(false);
  expect(sel.text).toBe('hello world');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Headings
// ────────────────────────────────────────────────────────────────────────────

test('H1 toolbar button converts paragraph to <h1>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('title');
  await page.locator('[title="Heading 1"]').click();
  await page.waitForTimeout(150);
  await expect(editor.locator('h1')).toContainText('title');
});

test('H2 toolbar button converts paragraph to <h2>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('subtitle');
  await page.locator('[title="Heading 2"]').click();
  await page.waitForTimeout(150);
  await expect(editor.locator('h2')).toContainText('subtitle');
});

test('H3 toolbar button converts paragraph to <h3>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('sub-sub');
  await page.locator('[title="Heading 3"]').click();
  await page.waitForTimeout(150);
  await expect(editor.locator('h3')).toContainText('sub-sub');
});

test('toggling H1 back to paragraph', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('title');
  await page.locator('[title="Heading 1"]').click();
  await page.waitForTimeout(100);
  await page.locator('[title="Heading 1"]').click();
  await page.waitForTimeout(150);
  expect(await editor.locator('h1').count()).toBe(0);
  await expect(editor.locator('p')).toContainText('title');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Lists & blockquote & inline code
// ────────────────────────────────────────────────────────────────────────────

test('bullet list toolbar wraps lines in <ul><li>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('item one');
  await page.locator('[title="Bullet list"]').click();
  await page.waitForTimeout(150);
  await expect(editor.locator('ul li')).toContainText('item one');
});

test('numbered list toolbar wraps lines in <ol><li>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('item one');
  await page.locator('[title="Numbered list"]').click();
  await page.waitForTimeout(150);
  await expect(editor.locator('ol li')).toContainText('item one');
});

test('pressing Enter inside a list creates a new list item', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('one');
  await page.locator('[title="Bullet list"]').click();
  await page.waitForTimeout(100);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.waitForTimeout(150);
  expect(await editor.locator('ul li').count()).toBe(2);
});

test('blockquote toolbar wraps paragraph in <blockquote>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('a quote');
  await page.locator('[title="Blockquote"]').click();
  await page.waitForTimeout(150);
  await expect(editor.locator('blockquote')).toContainText('a quote');
});

test('inline code toolbar wraps selection in <code>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('foo bar');
  await selectAll(page);
  await page.locator('[title="Inline code"]').click();
  await page.waitForTimeout(150);
  expect(await editor.innerHTML()).toContain('<code>');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Undo / Redo
// ────────────────────────────────────────────────────────────────────────────

test('undo via toolbar reverts the last edit', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.waitForTimeout(100);
  await page.locator('[title="Undo (Cmd+Z)"]').click();
  await page.waitForTimeout(150);
  await expect(editor).not.toContainText('hello');
});

test('redo via toolbar restores an undone edit', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.waitForTimeout(100);
  await page.locator('[title="Undo (Cmd+Z)"]').click();
  await page.waitForTimeout(100);
  await page.locator('[title="Redo (Cmd+Shift+Z)"]').click();
  await page.waitForTimeout(150);
  await expect(editor).toContainText('hello');
});

test('Cmd+Z keyboard shortcut undoes', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.waitForTimeout(100);
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(150);
  await expect(editor).not.toContainText('hello');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Mode toggle (Editing ↔ Suggesting)
// ────────────────────────────────────────────────────────────────────────────

test('switch shows "Editing" by default', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.mode-switch')).toContainText('Editing');
});

test('clicking switch toggles to Suggesting mode', async ({ page }) => {
  await setup(page);
  await enableSuggesting(page);
  await expect(page.locator('.mode-switch')).toContainText('Suggesting');
});

test('clicking switch again toggles back to Editing', async ({ page }) => {
  await setup(page);
  await enableSuggesting(page);
  await disableSuggesting(page);
  await expect(page.locator('.mode-switch')).toContainText('Editing');
});

test('Accept All / Reject All buttons appear only when pending changes exist', async ({ page }) => {
  const { editor } = await setup(page);
  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();
  await enableSuggesting(page);
  // Still hidden — no pending changes yet, even in Suggesting mode.
  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();
  await editor.click();
  await page.keyboard.type('hi');
  await expect(page.locator('[title="Accept all suggestions"]')).toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).toBeVisible();
  // And they persist when we drop out of Suggesting mode.
  await disableSuggesting(page);
  await expect(page.locator('[title="Accept all suggestions"]')).toBeVisible();
});

test('suggestion cards persist after exiting Suggesting mode', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
  await disableSuggesting(page);
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

test('Footer shows "Suggesting" badge while in suggesting mode', async ({ page }) => {
  await setup(page);
  await enableSuggesting(page);
  await expect(page.locator('.footer-suggesting-badge')).toBeVisible();
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Track changes: insertion
// ────────────────────────────────────────────────────────────────────────────

test('typing in suggesting mode produces <ins> marks', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(200);
  const html = await editor.innerHTML();
  expect(html).toContain('<ins');
  expect(html).toContain('track-insert');
  await expect(editor).toContainText('hello');
});

test('typing 5 chars in suggesting mode produces ONE suggestion card (not five)', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(300);
  const count = await page.locator('.suggestion-card').count();
  expect(count).toBe(1);
});

test('suggestion card text matches the inserted text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(300);
  const card = page.locator('.suggestion-card').first();
  await expect(card).toContainText('hello');
  // And no garbled repetition like 'hheelllllllooooo'
  const cardText = await card.textContent();
  expect(cardText).not.toMatch(/hh+|ee+|ll+l|oo+o/);
});

test('typing slowly produces ONE suggestion card per logical insertion', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  for (const ch of 'hello') {
    await page.keyboard.type(ch);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);
  expect(await page.locator('.suggestion-card').count()).toBe(1);
});

test('insertion card shows "Insertion" badge', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hi');
  await page.waitForTimeout(300);
  await expect(page.locator('.suggestion-card').first()).toContainText('Insertion');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Track changes: deletion
// ────────────────────────────────────────────────────────────────────────────

test('selecting and backspacing committed text in suggesting mode produces <del>', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);
  await enableSuggesting(page);
  await editor.click();
  await selectAll(page);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  const html = await editor.innerHTML();
  expect(html).toContain('<del');
  expect(html).toContain('track-delete');
});

test('deletion card shows "Deletion" badge with the deleted text', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('delete me');
  await page.waitForTimeout(100);
  await enableSuggesting(page);
  await editor.click();
  await selectAll(page);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  const card = page.locator('.suggestion-card').first();
  await expect(card).toContainText('Deletion');
  await expect(card).toContainText('delete me');
});

test('progressive backspace: 5 backspaces delete 5 chars', async ({ page }) => {
  // Known broken: only the last backspace gets tracked. Cursor stays on the
  // already-marked char so consecutive backspaces re-target the same position.
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(300);
  const card = page.locator('.suggestion-card').first();
  // Expect "world" to be the marked deletion
  await expect(card).toContainText('world');
});

test('progressive backspace produces ONE deletion card, not five', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(300);
  expect(await page.locator('.suggestion-card').count()).toBe(1);
});

test('deleting a pending insertion just removes it (no separate delete mark)', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(200);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  const html = await editor.innerHTML();
  // No deletion mark — the user is deleting their own pending insertion
  expect(html).not.toContain('<del');
  // And only an insertion card should remain (text "hel")
  await expect(page.locator('.suggestion-card').first()).toContainText('hel');
});

test('repeated letters: backspacing through "aaa" deletes all three', async ({ page }) => {
  // Regression: previously the third backspace was a no-op because the cursor
  // landed at position 0 (outside the paragraph) after the second one.
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('aaa');
  await page.waitForTimeout(200);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  const html = await editor.innerHTML();
  // All inserted 'a's should be gone; no leftover <ins>
  expect(html).not.toContain('<ins');
  expect(html).not.toMatch(/>a</);
});

test('repeated letters in committed text: backspacing "book" produces tracked deletes', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('book');
  await page.waitForTimeout(200);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  const card = page.locator('.suggestion-card').first();
  // All three backspaces should be tracked — last three chars of "book" deleted
  await expect(card).toContainText('ook');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Accept / Reject individual changes
// ────────────────────────────────────────────────────────────────────────────

test('accepting an insertion keeps the text and removes the <ins> mark', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('keep me');
  await page.waitForTimeout(300);
  await page.locator('.suggestion-accept-btn').first().click();
  await page.waitForTimeout(200);
  expect(await editor.innerHTML()).not.toContain('<ins');
  await expect(editor).toContainText('keep me');
});

test('rejecting an insertion removes the text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('discard me');
  await page.waitForTimeout(300);
  await page.locator('.suggestion-reject-btn').first().click();
  await page.waitForTimeout(200);
  await expect(editor).not.toContainText('discard me');
  expect(await editor.innerHTML()).not.toContain('<ins');
});

test('accepting a deletion removes the text', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('remove me');
  await page.waitForTimeout(100);
  await enableSuggesting(page);
  await editor.click();
  await selectAll(page);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await page.locator('.suggestion-accept-btn').first().click();
  await page.waitForTimeout(200);
  await expect(editor).not.toContainText('remove me');
  expect(await editor.innerHTML()).not.toContain('<del');
});

test('rejecting a deletion restores the text without the <del> mark', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('restore me');
  await page.waitForTimeout(100);
  await enableSuggesting(page);
  await editor.click();
  await selectLastNChars(page, 2);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await page.locator('.suggestion-reject-btn').first().click();
  await page.waitForTimeout(200);
  await expect(editor).toContainText('me');
  expect(await editor.innerHTML()).not.toContain('<del');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Accept All / Reject All
// ────────────────────────────────────────────────────────────────────────────

test('Accept All removes all <ins> marks and keeps inserted text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('first ');
  await page.waitForTimeout(150);
  await page.keyboard.type('second');
  await page.waitForTimeout(300);
  await page.locator('[title="Accept all suggestions"]').click();
  await page.waitForTimeout(200);
  expect(await editor.innerHTML()).not.toContain('<ins');
  await expect(editor).toContainText('first');
  await expect(editor).toContainText('second');
});

test('Reject All removes all <ins> marks and discards inserted text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('ephemeral');
  await page.waitForTimeout(300);
  await page.locator('[title="Reject all suggestions"]').click();
  await page.waitForTimeout(200);
  expect(await editor.innerHTML()).not.toContain('<ins');
  await expect(editor).not.toContainText('ephemeral');
});

test('Accept All collapses suggestion cards', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(300);
  await page.locator('[title="Accept all suggestions"]').click();
  await page.waitForTimeout(200);
  expect(await page.locator('.suggestion-card').count()).toBe(0);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 11 — Mode toggle interaction with tracking
// ────────────────────────────────────────────────────────────────────────────

test('typing after toggling OUT of Suggesting mode is untracked', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await disableSuggesting(page);
  await editor.click();
  await page.keyboard.type('plain');
  await page.waitForTimeout(200);
  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).not.toContain('<del');
  await expect(editor).toContainText('plain');
});

test('pending changes survive toggling Suggesting off and back on', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(300);
  await disableSuggesting(page);
  await enableSuggesting(page);
  await page.waitForTimeout(200);
  expect(await page.locator('.suggestion-card').count()).toBe(1);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Comments: floating "+" button
// ────────────────────────────────────────────────────────────────────────────

test('floating "+" button appears when text is selected', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await expect(page.locator('.add-comment-btn')).toBeVisible();
});

test('floating "+" button disappears when selection collapses', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await expect(page.locator('.add-comment-btn')).toBeVisible();
  await page.keyboard.press('End'); // collapses
  await page.waitForTimeout(100);
  await expect(page.locator('.add-comment-btn')).not.toBeVisible();
});

test('clicking "+" opens compose box', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('.add-comment-btn').click();
  await expect(page.locator('.add-comment-compose')).toBeVisible();
  await expect(page.locator('.add-comment-compose textarea')).toBeFocused();
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 13 — Comments: adding, replying, resolving, deleting
// ────────────────────────────────────────────────────────────────────────────

test('submitting a comment creates a comment card', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'this needs work');
  await expect(page.locator('.comment-card').first()).toBeVisible();
  await expect(page.locator('.comment-card').first()).toContainText('this needs work');
});

test('commented text is wrapped in <mark data-comment-id>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'note');
  const html = await editor.innerHTML();
  expect(html).toContain('data-comment-id');
  expect(html).toContain('comment-mark');
});

test('comment card shows the anchor text snippet', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('the quick brown fox');
  await selectLastNChars(page, 3); // "fox"
  await addCommentViaPlusButton(page, 'animal');
  await expect(page.locator('.comment-anchor-text').first()).toContainText('fox');
});

test('reply button reveals a reply textarea', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'first');
  await page.locator('.comment-reply-trigger').click();
  await expect(page.locator('.comment-reply-input')).toBeVisible();
});

test('submitting a reply appends it to the card', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'first');
  await page.locator('.comment-reply-trigger').click();
  await page.locator('.comment-reply-input').fill('second');
  await page.locator('.comment-card .btn-primary').click();
  await page.waitForTimeout(150);
  const card = page.locator('.comment-card').first();
  await expect(card).toContainText('first');
  await expect(card).toContainText('second');
});

test('resolving a comment hides it from the default view', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  await page.locator('.comment-resolve-btn').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.comment-card.comment-card-resolved')).toHaveCount(0);
  await expect(page.locator('.show-resolved-btn')).toBeVisible();
});

test('show-resolved button reveals resolved comments', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  await page.locator('.comment-resolve-btn').click();
  await page.waitForTimeout(100);
  await page.locator('.show-resolved-btn').click();
  await page.waitForTimeout(100);
  await expect(page.locator('.comment-card-resolved')).toBeVisible();
});

test('deleting a comment removes the card and the mark', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  expect(await editor.innerHTML()).toContain('data-comment-id');
  await page.locator('.comment-delete-btn').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.comment-card')).toHaveCount(0);
  expect(await editor.innerHTML()).not.toContain('data-comment-id');
});

test('multiple comments stack without overlapping', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('one two three');
  await page.waitForTimeout(50);
  // Comment on "one"
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await addCommentViaPlusButton(page, 'A');
  // Comment on "three"
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await addCommentViaPlusButton(page, 'B');

  const cards = page.locator('.comment-card');
  await expect(cards).toHaveCount(2);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(a && b).toBeTruthy();
  // No overlap on the y-axis
  expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 1);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 14 — Footer (word/char count, line/col, file name)
// ────────────────────────────────────────────────────────────────────────────

test('word count updates as the user types', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('one two three');
  await page.waitForTimeout(100);
  await expect(page.locator('.footer')).toContainText('3 words');
});

test('char count updates as the user types', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await page.waitForTimeout(100);
  await expect(page.locator('.footer')).toContainText('5 chars');
});

test('footer shows "Untitled" when no file is open', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.footer-filename')).toContainText('Untitled');
});

test('dirty marker appears in footer after typing', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('x');
  await page.waitForTimeout(150);
  await expect(page.locator('.footer-dirty')).toBeVisible();
});

test('document title shows dirty bullet when modified', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('x');
  await page.waitForTimeout(150);
  const title = await page.title();
  expect(title).toContain('•');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 15 — Zoom
// ────────────────────────────────────────────────────────────────────────────

test('zoom slider in footer is present', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.footer-zoom-slider')).toBeVisible();
  await expect(page.locator('.footer-zoom-label')).toContainText('100%');
});

test('Cmd+= zoom shortcut increases zoom', async ({ page }) => {
  await setup(page);
  await page.keyboard.down('Meta');
  await page.keyboard.press('=');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(100);
  const label = await page.locator('.footer-zoom-label').textContent();
  expect(label).not.toBe('100%');
});

test('Cmd+- zoom shortcut decreases zoom', async ({ page }) => {
  await setup(page);
  await page.keyboard.down('Meta');
  await page.keyboard.press('-');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(100);
  const label = await page.locator('.footer-zoom-label').textContent();
  expect(label).not.toBe('100%');
});

test('Cmd+0 resets zoom to 100%', async ({ page }) => {
  await setup(page);
  await page.keyboard.down('Meta');
  await page.keyboard.press('=');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
  await page.keyboard.down('Meta');
  await page.keyboard.press('0');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(100);
  await expect(page.locator('.footer-zoom-label')).toContainText('100%');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 16 — Cross-feature interactions
// ────────────────────────────────────────────────────────────────────────────

test('comment can be added to text that is also tracked-inserted', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(300);
  await selectAll(page);
  await addCommentViaPlusButton(page, 'note on insertion');
  const html = await editor.innerHTML();
  expect(html).toContain('<ins');
  expect(html).toContain('data-comment-id');
  await expect(page.locator('.comment-card')).toHaveCount(1);
  // Plus one suggestion card for the insertion itself
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

test('typing newline in suggesting mode tracks the paragraph break', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.waitForTimeout(300);
  // Both lines + the break should be visible as a tracked insertion
  await expect(editor).toContainText('one');
  await expect(editor).toContainText('two');
  expect(await editor.innerHTML()).toContain('<ins');
});

test('replacement (type over selection) shows both <del> and <ins>', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);
  await enableSuggesting(page);
  await editor.click();
  // Select "world" and type "earth"
  await selectLastNChars(page, 5);
  await page.keyboard.type('earth');
  await page.waitForTimeout(300);
  const html = await editor.innerHTML();
  expect(html).toContain('<del');
  expect(html).toContain('<ins');
  await expect(editor).toContainText('hello'); // kept
  await expect(editor).toContainText('earth'); // inserted
  // Two cards: one deletion, one insertion
  expect(await page.locator('.suggestion-card').count()).toBe(2);
});

test('undo in suggesting mode reverts the last tracked change', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(300);
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(300);
  expect(await editor.innerHTML()).not.toContain('<ins');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 17 — Regression guards
// ────────────────────────────────────────────────────────────────────────────

test('typing after toggle-off does not produce <ins> even with prior pending', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('first');
  await page.waitForTimeout(200);
  await disableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('SECOND');
  await page.waitForTimeout(200);
  const html = await editor.innerHTML();
  expect(html).toContain('SECOND');
  const stripped = html.replace(/<ins[^>]*>.*?<\/ins>/g, '');
  expect(stripped).toContain('SECOND');
});

test('Enter in suggesting mode does not insert an empty paragraph between lines', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.waitForTimeout(300);
  // Two lines typed → exactly two paragraphs (no empty middle paragraph).
  expect(await editor.locator('p').count()).toBe(2);
});
