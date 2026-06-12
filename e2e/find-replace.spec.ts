/**
 * Find & replace (Cmd+F) end-to-end tests.
 *
 * The find bar searches with decorations only; replacement goes through
 * ordinary editor commands, so in suggesting mode it produces tracked
 * changes like any hand-typed edit.
 */
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
  const sw = page.locator('.mode-switch');
  await expect(sw).toContainText('Editing');
  await sw.click();
  await expect(sw).toContainText('Suggesting');
}

async function openFindBar(page: Page) {
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('f');
  await page.keyboard.up('ControlOrMeta');
  await page.locator('.find-bar').waitFor({ timeout: 2000 });
}

test.describe('Find & replace', () => {
  test('Cmd+F opens the find bar and Esc closes it', async ({ page }) => {
    await setup(page);
    await openFindBar(page);
    await expect(page.locator('.find-bar-input').first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('.find-bar')).toHaveCount(0);
  });

  test('typing a query highlights matches and shows the count', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('the cat sat on the mat');
    await openFindBar(page);
    await page.locator('.find-bar-input').first().fill('the');

    await expect(page.locator('.ProseMirror .find-match')).toHaveCount(2);
    await expect(page.locator('.find-bar-count')).toHaveText('1 of 2');
  });

  test('Enter steps through matches and wraps around', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('one fish two fish red fish');
    await openFindBar(page);
    const input = page.locator('.find-bar-input').first();
    await input.fill('fish');
    await expect(page.locator('.find-bar-count')).toHaveText('1 of 3');

    await input.press('Enter');
    await expect(page.locator('.find-bar-count')).toHaveText('2 of 3');
    await input.press('Enter');
    await expect(page.locator('.find-bar-count')).toHaveText('3 of 3');
    await input.press('Enter');
    await expect(page.locator('.find-bar-count')).toHaveText('1 of 3');
    await input.press('Shift+Enter');
    await expect(page.locator('.find-bar-count')).toHaveText('3 of 3');
  });

  test('no results state', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('hello world');
    await openFindBar(page);
    await page.locator('.find-bar-input').first().fill('zebra');

    await expect(page.locator('.find-bar-count')).toHaveText('No results');
    await expect(page.locator('.find-bar button:has-text("Replace")')).toBeDisabled();
  });

  test('replace swaps one occurrence in editing mode', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('good dog bad dog');
    await openFindBar(page);
    await page.locator('.find-bar-input').first().fill('dog');
    await page.locator('.find-bar-input').nth(1).fill('cat');
    await page.locator('.find-bar button:has-text("Replace")').first().click();

    await expect(editor).toContainText('good cat bad dog');
    await expect(page.locator('.find-bar-count')).toHaveText('1 of 1');
  });

  test('replace all swaps every occurrence and undoes in one step', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('red fish red boat red sky');
    await openFindBar(page);
    await page.locator('.find-bar-input').first().fill('red');
    await page.locator('.find-bar-input').nth(1).fill('blue');
    await page.locator('.find-bar button:has-text("All")').click();

    await expect(editor).toContainText('blue fish blue boat blue sky');
    await expect(page.locator('.find-bar-count')).toHaveText('No results');

    // Undo targets the focused element; give the editor focus back first.
    await editor.click();
    await page.keyboard.down('ControlOrMeta');
    await page.keyboard.press('z');
    await page.keyboard.up('ControlOrMeta');
    await expect(editor).toContainText('red fish red boat red sky');
  });

  test('replace in suggesting mode produces a tracked replacement', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('the quick fox');
    await enableSuggesting(page);
    await openFindBar(page);
    await page.locator('.find-bar-input').first().fill('quick');
    await page.locator('.find-bar-input').nth(1).fill('sly');
    await page.locator('.find-bar button:has-text("Replace")').first().click();

    // Original survives struck-out, the replacement is a pending insert.
    await expect(editor.locator('del.track-delete')).toHaveText('quick');
    await expect(editor.locator('ins.track-insert')).toHaveText('sly');
    // The struck-out original must not be re-found.
    await expect(page.locator('.find-bar-count')).toHaveText('No results');
  });

  test('struck-out text is not matched while searching', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('alpha beta');
    await enableSuggesting(page);
    // The mode switch stole focus; click back into the editor, then strike
    // the whole line via select-all + delete (partial keyboard selections
    // are flaky in headless Chromium; the unit tests cover the mixed case).
    await editor.click();
    await page.keyboard.down('ControlOrMeta');
    await page.keyboard.press('a');
    await page.keyboard.up('ControlOrMeta');
    await page.waitForTimeout(50);
    await page.keyboard.press('Backspace');
    await expect(editor.locator('del.track-delete')).toHaveText('alpha beta');

    await openFindBar(page);
    await page.locator('.find-bar-input').first().fill('alpha');
    await expect(page.locator('.find-bar-count')).toHaveText('No results');
  });

  test('closing the find bar clears the highlights', async ({ page }) => {
    const { editor } = await setup(page);
    await editor.pressSequentially('find me find me');
    await openFindBar(page);
    await page.locator('.find-bar-input').first().fill('find');
    await expect(page.locator('.ProseMirror .find-match')).toHaveCount(2);

    await page.keyboard.press('Escape');
    await expect(page.locator('.ProseMirror .find-match')).toHaveCount(0);
  });
});
