/**
 * Link editing UI end-to-end tests: the toolbar Link button (Cmd+K) and its
 * add / edit / remove popover.
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

async function selectAll(page: Page) {
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(50);
}

const linkButton = (page: Page) => page.locator('[title="Link (Cmd+K)"]');

async function addLink(page: Page, url: string) {
  await linkButton(page).click();
  const input = page.locator('.link-popover-input');
  await input.fill(url);
  await page.locator('.link-popover button:has-text("Add link")').click();
  await page.waitForTimeout(100);
}

test.describe('Link editing', () => {
  test('button is disabled without a selection', async ({ page }) => {
    await setup(page);
    await page.keyboard.type('plain text');
    await expect(linkButton(page)).toBeDisabled();
  });

  test('adds a link to the selected text', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('visit the docs');
    await selectAll(page);
    await addLink(page, 'https://example.com/docs');

    const link = editor.locator('a[href="https://example.com/docs"]');
    await expect(link).toHaveText('visit the docs');
  });

  test('normalizes a bare domain to https', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('example');
    await selectAll(page);
    await addLink(page, 'example.com');

    await expect(editor.locator('a[href="https://example.com"]')).toHaveText('example');
  });

  test('edits an existing link from a cursor inside it', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('home page');
    await selectAll(page);
    await addLink(page, 'https://old.example.com');

    // A bare click inside the link (openOnClick is off) puts the cursor in it.
    await editor.locator('a').click();
    await expect(linkButton(page)).toHaveClass(/active/);

    await linkButton(page).click();
    const input = page.locator('.link-popover-input');
    await expect(input).toHaveValue('https://old.example.com');
    await input.fill('https://new.example.com');
    await page.locator('.link-popover button:has-text("Update")').click();

    await expect(editor.locator('a[href="https://new.example.com"]')).toHaveText('home page');
  });

  test('removes a link but keeps the text', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('linked words');
    await selectAll(page);
    await addLink(page, 'https://example.com');
    await expect(editor.locator('a')).toHaveCount(1);

    await editor.locator('a').click();
    await linkButton(page).click();
    await page.locator('.link-popover button:has-text("Remove")').click();

    await expect(editor.locator('a')).toHaveCount(0);
    await expect(editor).toContainText('linked words');
  });

  test('Cmd+K opens the popover for a selection', async ({ page }) => {
    await setup(page);
    await page.keyboard.type('shortcut link');
    await selectAll(page);
    await page.keyboard.down('ControlOrMeta');
    await page.keyboard.press('k');
    await page.keyboard.up('ControlOrMeta');

    await expect(page.locator('.link-popover-input')).toBeFocused();
  });

  test('Enter in the URL field applies the link, Esc closes', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('enter applies');
    await selectAll(page);
    await linkButton(page).click();
    const input = page.locator('.link-popover-input');
    await input.fill('https://example.com');
    await input.press('Enter');
    await expect(editor.locator('a[href="https://example.com"]')).toHaveCount(1);
    await expect(page.locator('.link-popover')).toHaveCount(0);

    // Esc path: reopen on the link and dismiss without changes.
    await editor.locator('a').click();
    await linkButton(page).click();
    await page.locator('.link-popover-input').press('Escape');
    await expect(page.locator('.link-popover')).toHaveCount(0);
    await expect(editor.locator('a[href="https://example.com"]')).toHaveCount(1);
  });
});
