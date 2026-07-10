/**
 * Spec 09 — a comment anchored at the end of a viewport-filling document must be
 * scrollable fully into view without adding content to the doc.
 *
 * The card column is overflow-hidden and its cards paint at `nudgedTop − scrollTop`.
 * Before the fix, a card whose bottom sat past the document's own content was
 * unreachable: no scroll position revealed it. App now sizes a dynamic
 * `.editor-bottom-spacer` on the scrollable content (extending scroll range only
 * when a low-anchored card needs it) and `scrollCardIntoView` brings the full card
 * on-screen on activation. This test exercises the real layout end-to-end.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function setup(page: Page) {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
  return editor;
}

test('a comment on the last line of a tall document scrolls fully into view', async ({ page }) => {
  const editor = await setup(page);

  // Fill well past one viewport so there IS empty space below the last card to
  // reproduce the bug — a short doc leaves viewport below the anchor already.
  const lines = 60;
  for (let i = 0; i < lines; i++) {
    await page.keyboard.type(`Paragraph ${i} — some body text to give the document height.`);
    if (i < lines - 1) await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(100);

  // Comment on the very last line (cursor is already at document end).
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(50);

  const plusBtn = page.locator('.add-comment-btn');
  await plusBtn.click();
  const textarea = page.locator('.add-comment-compose textarea');
  await textarea.fill('last-line note');
  // Submit via Cmd+Enter — the compose popover's submit button can render below
  // the fold for a last-line selection, so don't depend on it being on-screen.
  await textarea.press('ControlOrMeta+Enter');
  await page.waitForTimeout(200);

  // Scroll back to the top so the card starts off-screen and activation has to
  // bring it into view (adding a comment focuses it, so scroll up first).
  const scrollArea = page.locator('.editor-scroll-area');
  await scrollArea.evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(100);

  // Activate the card by clicking its commented text.
  const mark = editor.locator('mark[data-comment-id]').last();
  await mark.scrollIntoViewIfNeeded();
  await mark.click();
  await page.waitForTimeout(400); // smooth scroll + one rAF for the spacer effect

  // The card must sit fully within the scroll area's viewport, with a positive
  // bottom gap — proving the spacer opened enough range and scrollCardIntoView
  // used it. No content was added to the document to make this fit.
  const card = page.locator('.comment-card-active');
  await expect(card).toBeVisible();

  const gaps = await page.evaluate(() => {
    const area = document.querySelector('.editor-scroll-area') as HTMLElement;
    const el = document.querySelector('.comment-card-active') as HTMLElement;
    const a = area.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    return { topGap: c.top - a.top, bottomGap: a.bottom - c.bottom };
  });

  expect(gaps.topGap).toBeGreaterThanOrEqual(0);
  expect(gaps.bottomGap).toBeGreaterThan(0);
});
