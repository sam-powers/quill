/**
 * Playwright coverage for the AI comment-reply state machine.
 *
 * The real `spawn_claude_resume` Tauri command isn't available in CI, so each
 * test installs `window.__quillMock` via `page.addInitScript()` before the app
 * mounts. The mock plays scripted ChunkEvents and `window.__quillTestSession`
 * seeds a fake binding so the @claude code path runs without a SessionPicker.
 */
import { test, expect, chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

type MockScriptStep =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'pause' }; // hold open until cancel

async function setupWithMock(script: MockScriptStep[]): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript((steps: MockScriptStep[]) => {
    type Ev =
      | { kind: 'delta'; text: string }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
      | { kind: 'cancelled' };

    let nextTokenId = 0;
    const pending = new Map<string, () => void>(); // token → cancel resolver

    (window as unknown as { __quillTestSession: unknown }).__quillTestSession = {
      provider: 'claude-code',
      sessionId: 'test-session-id',
      cwd: '/tmp/test',
      generatedAt: '2026-01-01T00:00:00Z',
    };

    (window as unknown as { __quillMock: unknown }).__quillMock = {
      spawn: (_args: unknown, onEvent: (e: Ev) => void) => {
        const token = `mock-${++nextTokenId}`;
        let cancelled = false;
        pending.set(token, () => {
          cancelled = true;
          onEvent({ kind: 'cancelled' });
          pending.delete(token);
        });
        (async () => {
          for (const step of steps) {
            if (cancelled) return;
            await new Promise((r) => setTimeout(r, 30));
            if (cancelled) return;
            if (step.kind === 'pause') {
              // Park indefinitely; only cancel will resolve.
              await new Promise(() => undefined);
              return;
            }
            onEvent(step as Ev);
            if (step.kind === 'done' || step.kind === 'error') {
              pending.delete(token);
              return;
            }
          }
        })();
        return token;
      },
      cancel: (token: string) => {
        pending.get(token)?.();
      },
    };
  }, script);

  await page.goto('http://localhost:1420');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
  return { browser, page };
}

async function addCommentWithAIReply(page: Page, anchor: string, replyText: string) {
  await page.keyboard.type(anchor);
  // Select all
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
  // Open comment composer
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill('seed comment');
  await page.locator('.add-comment-compose .btn-primary').click();
  await page.waitForTimeout(150);
  // Reply containing @claude
  await page.locator('.comment-reply-trigger').click();
  await page.locator('.comment-reply-input').fill(replyText);
  await page.locator('.comment-card .btn-primary').click();
}

test('AI reply: pending → delta → done streams chunks and clears spinner', async () => {
  const { browser, page } = await setupWithMock([
    { kind: 'delta', text: 'Sure — ' },
    { kind: 'delta', text: 'the answer ' },
    { kind: 'delta', text: 'is 42.' },
    { kind: 'done' },
  ]);

  await addCommentWithAIReply(page, 'hello world', '@claude what is the answer?');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  // Spinner present while streaming.
  await expect(aiReply.locator('.ai-spinner')).toBeVisible();
  // Wait for accumulated text and spinner clearance.
  await expect(aiReply.locator('.comment-reply-text')).toContainText('Sure — the answer is 42.', {
    timeout: 3000,
  });
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0);
  await expect(aiReply.locator('.btn-cancel-ai')).toHaveCount(0);
  await browser.close();
});

test('AI reply: pending → error shows Re-link button', async () => {
  const { browser, page } = await setupWithMock([
    { kind: 'delta', text: 'partial...' },
    { kind: 'error', message: 'Session no longer available' },
  ]);

  await addCommentWithAIReply(page, 'hello world', '@claude help');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('.comment-reply-error')).toContainText(
    'Session no longer available',
    { timeout: 3000 },
  );
  await expect(aiReply.getByRole('button', { name: /Re-link session/i })).toBeVisible();
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0);
  await browser.close();
});

test('AI reply: pending → cancel resolves without leaving spinner', async () => {
  const { browser, page } = await setupWithMock([
    { kind: 'delta', text: 'starting...' },
    { kind: 'pause' },
  ]);

  await addCommentWithAIReply(page, 'hello world', '@claude long task');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('.comment-reply-text')).toContainText('starting...', {
    timeout: 2000,
  });
  await expect(aiReply.locator('.btn-cancel-ai')).toBeVisible();
  await aiReply.locator('.btn-cancel-ai').click();
  // Cancel transitions to finished: spinner & cancel button go away.
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0, { timeout: 2000 });
  await expect(aiReply.locator('.btn-cancel-ai')).toHaveCount(0);
  // Partial text retained.
  await expect(aiReply.locator('.comment-reply-text')).toContainText('starting...');
  await browser.close();
});
