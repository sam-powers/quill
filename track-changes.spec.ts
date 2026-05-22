import { test, expect, chromium } from '@playwright/test';
import type { Page, Browser } from '@playwright/test';

async function setup(): Promise<{ browser: Browser; page: Page; editor: import('@playwright/test').Locator }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:1420');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
  return { browser, page, editor };
}

async function enableSuggesting(page: Page) {
  const badge = page.locator('.editing-badge');
  await expect(badge).toContainText('Editing');
  await badge.click();
  await expect(badge).toContainText('Suggesting');
}

// ── Insertion tracking ────────────────────────────────────────────────────────

test('typing in suggesting mode wraps text in tracked_insert mark', async () => {
  const { browser, page, editor } = await setup();

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

  await browser.close();
});

test('typing in normal mode does NOT produce tracked_insert marks', async () => {
  const { browser, page, editor } = await setup();

  await editor.click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).toContain('hello');

  await browser.close();
});

// ── Deletion tracking ─────────────────────────────────────────────────────────

test('deleting text in suggesting mode wraps it in tracked_delete mark', async () => {
  const { browser, page, editor } = await setup();

  // Type some text in normal mode so it is committed content
  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);

  await enableSuggesting(page);
  await editor.click();

  // Select all and delete
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).toContain('<del');
  expect(html).toContain('track-delete');

  await browser.close();
});

test('deleting text in normal mode removes it outright with no tracked mark', async () => {
  const { browser, page, editor } = await setup();

  await editor.click();
  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);

  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<del');
  expect(html).not.toContain('hello world');

  await browser.close();
});

// ── Suggestion cards ──────────────────────────────────────────────────────────

test('suggestion card appears in the margin after typing in suggesting mode', async () => {
  const { browser, page, editor } = await setup();

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('suggested text');
  await page.waitForTimeout(300);

  const card = page.locator('.suggestion-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Insertion');

  await browser.close();
});

test('deletion suggestion card appears after deleting committed text', async () => {
  const { browser, page, editor } = await setup();

  await editor.click();
  await page.keyboard.type('delete me');
  await page.waitForTimeout(100);

  await enableSuggesting(page);
  await editor.click();

  // Select all text and delete
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  const card = page.locator('.suggestion-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Deletion');

  await browser.close();
});

// ── Per-change accept ─────────────────────────────────────────────────────────

test('accepting an insertion removes the tracked mark and keeps the text', async () => {
  const { browser, page, editor } = await setup();

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

  await browser.close();
});

test('rejecting an insertion removes the tracked mark and removes the text', async () => {
  const { browser, page, editor } = await setup();

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

  await browser.close();
});

test('accepting a deletion removes the tracked mark and removes the text', async () => {
  const { browser, page, editor } = await setup();

  await editor.click();
  await page.keyboard.type('remove me');
  await page.waitForTimeout(100);

  await enableSuggesting(page);
  await editor.click();

  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  const acceptBtn = page.locator('.suggestion-accept-btn').first();
  await acceptBtn.click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<del');
  expect(html).not.toContain('remove me');

  await browser.close();
});

test('rejecting a deletion removes the tracked mark and restores the text', async () => {
  const { browser, page, editor } = await setup();

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

  await browser.close();
});

// ── Accept all / Reject all ───────────────────────────────────────────────────

test('Accept All removes all tracked marks and keeps inserted text', async () => {
  const { browser, page, editor } = await setup();

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

  await browser.close();
});

test('Reject All removes all tracked marks and discards inserted text', async () => {
  const { browser, page, editor } = await setup();

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('ephemeral');
  await page.waitForTimeout(300);

  await page.locator('[title="Reject all suggestions"]').click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).not.toContain('ephemeral');

  await browser.close();
});

test('Accept All and Reject All buttons only appear in suggesting mode', async () => {
  const { browser, page } = await setup();

  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).not.toBeVisible();

  await enableSuggesting(page);

  await expect(page.locator('[title="Accept all suggestions"]')).toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).toBeVisible();

  await browser.close();
});

// ── Mode toggle ───────────────────────────────────────────────────────────────

test('toggling back to editing mode stops tracking new changes', async () => {
  const { browser, page, editor } = await setup();

  await enableSuggesting(page);
  // Exit suggesting mode
  await page.locator('.editing-badge').click();
  await expect(page.locator('.editing-badge')).toContainText('Editing');

  await editor.click();
  await page.keyboard.type('normal text');
  await page.waitForTimeout(150);

  const html = await editor.innerHTML();
  expect(html).not.toContain('<ins');
  expect(html).toContain('normal text');

  await browser.close();
});
