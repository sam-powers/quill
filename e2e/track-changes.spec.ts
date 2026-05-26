import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
  return { editor };
}

async function enableSuggesting(page: Page) {
  const badge = page.locator('.mode-switch');
  await expect(badge).toContainText('Editing');
  await badge.click();
  await expect(badge).toContainText('Suggesting');
}

// ── Insertion tracking ────────────────────────────────────────────────────────

test('typing in suggesting mode wraps text in tracked_insert mark', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).toContain('<ins');
  expect(html).toContain('track-insert');
  // Each keystroke produces a separate <ins> node, so check textContent not innerHTML
  const text = await editor.textContent();
  expect(text).toContain('hello');
});

test('typing in normal mode does NOT produce tracked_insert marks', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).toContain('hello');
});

// ── Deletion tracking ─────────────────────────────────────────────────────────

test('deleting text in suggesting mode wraps it in tracked_delete mark', async ({ page }) => {
  const { editor } = await setup(page);

  // Type some text in normal mode so it is committed content
  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);

  await enableSuggesting(page);
  await editor.click();

  // Select all and delete
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).toContain('<del');
  expect(html).toContain('track-delete');
});

test('deleting text in normal mode removes it outright with no tracked mark', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);

  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<del');
  expect(html).not.toContain('hello world');
});

// ── Suggestion cards ──────────────────────────────────────────────────────────

test('suggestion card appears in the margin after typing in suggesting mode', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('suggested text');
  await page.waitForTimeout(300);

  const card = page.locator('.suggestion-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Insertion');
});

test('deletion suggestion card appears after deleting committed text', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('delete me');
  await page.waitForTimeout(100);

  await enableSuggesting(page);
  await editor.click();

  // Select all text and delete
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  const card = page.locator('.suggestion-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Deletion');
});

// ── Per-change accept ─────────────────────────────────────────────────────────

test('accepting an insertion removes the tracked mark and keeps the text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('keep me');
  await page.waitForTimeout(300);

  const acceptBtn = page.locator('.suggestion-accept-btn').first();
  await expect(acceptBtn).toBeVisible();
  await acceptBtn.click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).toContain('keep me');
});

test('rejecting an insertion removes the tracked mark and removes the text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('discard me');
  await page.waitForTimeout(300);

  const rejectBtn = page.locator('.suggestion-reject-btn').first();
  await expect(rejectBtn).toBeVisible();
  await rejectBtn.click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).not.toContain('discard me');
});

test('accepting a deletion removes the tracked mark and removes the text', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('remove me');
  await page.waitForTimeout(100);

  await enableSuggesting(page);
  await editor.click();

  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  const acceptBtn = page.locator('.suggestion-accept-btn').first();
  await acceptBtn.click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<del');
  expect(html).not.toContain('remove me');
});

test('rejecting a deletion removes the tracked mark and restores the text', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('restore me');
  await page.waitForTimeout(100);

  await enableSuggesting(page);
  await editor.click();

  // Select the last word "me" only — avoids block-boundary issues from select-all + delete
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  const rejectBtn = page.locator('.suggestion-reject-btn').first();
  await rejectBtn.click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<del');
  // "me" should be restored
  const text = await editor.textContent();
  expect(text).toContain('me');
});

// ── Accept all / Reject all ───────────────────────────────────────────────────

test('Accept All removes all tracked marks and keeps inserted text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('first ');
  await page.keyboard.type('second');
  await page.waitForTimeout(300);

  await page.locator('[title="Accept all suggestions"]').click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).toContain('first');
  expect(html).toContain('second');
});

test('Reject All removes all tracked marks and discards inserted text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('ephemeral');
  await page.waitForTimeout(300);

  await page.locator('[title="Reject all suggestions"]').click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).not.toContain('ephemeral');
});

test('Accept All and Reject All buttons only appear when pending changes exist', async ({
  page,
}) => {
  const { editor } = await setup(page);

  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).not.toBeVisible();

  await enableSuggesting(page);
  // Still hidden — Suggesting mode alone doesn't reveal them; pending changes do.
  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();

  await editor.click();
  await page.keyboard.type('hi');
  await expect(page.locator('[title="Accept all suggestions"]')).toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).toBeVisible();
});

// ── Mode toggle ───────────────────────────────────────────────────────────────

test('toggling back to editing mode stops tracking new changes', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  // Exit suggesting mode
  await page.locator('.mode-switch').click();
  await expect(page.locator('.mode-switch')).toContainText('Editing');

  await editor.click();
  await page.keyboard.type('normal text');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).toContain('normal text');
});
