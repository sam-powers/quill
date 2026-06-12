/**
 * Playwright coverage for the full-document review flow: the comment-panel
 * button, the options modal (guidance + checkboxes), streaming, and the
 * conversion of Claude's reply into margin comments and tracked suggestions.
 *
 * Like ai-reply.spec.ts, the real `spawn_claude_resume` command isn't
 * available in CI, so each test installs `window.__quillMock` via
 * `page.addInitScript()` before the app mounts.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type MockScriptStep =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'pause' }; // hold open until cancel

async function setupWithMock(
  page: Page,
  script: MockScriptStep[],
  sessionOverrides: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    ({ steps, overrides }: { steps: MockScriptStep[]; overrides: Record<string, unknown> }) => {
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
        ...overrides,
      };

      (window as unknown as { __quillMock: unknown }).__quillMock = {
        spawn: (args: unknown, onEvent: (e: Ev) => void) => {
          // Exposed so tests can assert on what the app would send the backend.
          (window as unknown as { __lastSpawnArgs: unknown }).__lastSpawnArgs = args;
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
    },
    { steps: script, overrides: sessionOverrides },
  );

  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
}

// Types document text and opens the review modal via the comment-panel button.
async function openReviewModal(page: Page, docText: string) {
  await page.keyboard.type(docText);
  await page.locator('.review-doc-btn').click();
  await expect(page.locator('.review-modal')).toBeVisible({ timeout: 2000 });
}

test('Review: button opens the modal with an editable default prompt and both boxes checked', async ({
  page,
}) => {
  await setupWithMock(page, [{ kind: 'done' }]);
  await openReviewModal(page, 'alpha beta gamma');

  // Default guidance is pre-filled — a plain Submit is already a useful review.
  const guidance = page.locator('#review-guidance');
  await expect(guidance).toHaveValue(/tone, clarity/);
  const checks = page.locator('.review-modal-check input[type="checkbox"]');
  await expect(checks.nth(0)).toBeChecked();
  await expect(checks.nth(1)).toBeChecked();

  // …and it is editable.
  await guidance.fill('make it 20% shorter');
  await expect(guidance).toHaveValue('make it 20% shorter');
});

test('Review: Submit is disabled when neither output is requested', async ({ page }) => {
  await setupWithMock(page, [{ kind: 'done' }]);
  await openReviewModal(page, 'alpha beta gamma');

  const checks = page.locator('.review-modal-check input[type="checkbox"]');
  await checks.nth(0).uncheck();
  await checks.nth(1).uncheck();
  await expect(page.locator('.review-modal .btn-primary')).toBeDisabled();
  await checks.nth(0).check();
  await expect(page.locator('.review-modal .btn-primary')).toBeEnabled();
});

test('Review: reply becomes margin comments and tracked suggestions, with a summary', async ({
  page,
}) => {
  await setupWithMock(page, [
    { kind: 'delta', text: 'Solid draft overall.\n\n```quill-comments\n' },
    {
      kind: 'delta',
      text: '{"comments":[{"find":"alpha","comment":"Consider a stronger opening."}]}\n```\n',
    },
    {
      kind: 'delta',
      text: '```quill-edits\n{"summary":"Capitalized gamma.","edits":[{"find":"gamma","replace":"GAMMA"}]}\n```',
    },
    { kind: 'done' },
  ]);
  await openReviewModal(page, 'alpha beta gamma');
  await page.locator('.review-modal .btn-primary').click();

  // Assessment prose streams in; the JSON blocks never reach the user.
  const stream = page.locator('.review-modal-stream');
  await expect(stream).toContainText('Solid draft overall.', { timeout: 3000 });
  await expect(stream).not.toContainText('quill-comments');
  await expect(stream).not.toContainText('"find"');

  // Result summary counts both outputs.
  await expect(page.locator('.review-modal-summary')).toContainText('1 comment added', {
    timeout: 3000,
  });
  await expect(page.locator('.review-modal-summary')).toContainText('1 suggestion proposed');

  await page.locator('.review-modal .btn-primary').click(); // Done
  await expect(page.locator('.review-modal')).toHaveCount(0);

  // The comment landed in the margin, authored by Claude, with the remark as
  // an AI-styled reply.
  const card = page.locator('.comment-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Claude');
  await expect(card.locator('.comment-reply-ai .comment-reply-text')).toContainText(
    'Consider a stronger opening.',
  );

  // The edit landed as a tracked suggestion; the document shows the new text.
  await expect(page.locator('.suggestion-card').first()).toBeVisible();
  await expect(page.locator('.ProseMirror')).toContainText('GAMMA');
});

test('Review: unplaceable finds are skipped and surfaced in the summary', async ({ page }) => {
  await setupWithMock(page, [
    { kind: 'delta', text: 'Reviewed.\n\n```quill-comments\n' },
    { kind: 'delta', text: '{"comments":[{"find":"no such text","comment":"x"}]}\n```' },
    { kind: 'done' },
  ]);
  await openReviewModal(page, 'alpha beta gamma');
  await page.locator('.review-modal .btn-primary').click();

  await expect(page.locator('.review-modal-summary')).toContainText("1 couldn't be placed", {
    timeout: 3000,
  });
  await page.locator('.review-modal .btn-primary').click();
  await expect(page.locator('.comment-card')).toHaveCount(0);
});

test('Review: prompt carries the guidance, checkbox choices, and full document', async ({
  page,
}) => {
  await setupWithMock(page, [{ kind: 'delta', text: 'Looks good.' }, { kind: 'done' }]);
  await openReviewModal(page, 'alpha beta gamma');

  await page.locator('#review-guidance').fill('make it 20% shorter');
  await page.locator('.review-modal-check input[type="checkbox"]').nth(0).uncheck(); // comments off → suggestions only
  await page.locator('.review-modal .btn-primary').click();
  await expect(page.locator('.review-modal-summary')).toBeVisible({ timeout: 3000 });

  const args = await page.evaluate(
    () => (window as unknown as { __lastSpawnArgs: unknown }).__lastSpawnArgs,
  );
  expect(args).toMatchObject({ sessionId: 'test-session-id' });
  const prompt = (args as { prompt: string }).prompt;
  expect(prompt).toContain('User guidance for this review: make it 20% shorter');
  expect(prompt).toContain('alpha beta gamma');
  expect(prompt).toContain('```quill-edits');
  expect(prompt).not.toContain('```quill-comments');
});

test('Review: cancel mid-stream discards partial output and returns to the form', async ({
  page,
}) => {
  await setupWithMock(page, [{ kind: 'delta', text: 'Reading…' }, { kind: 'pause' }]);
  await openReviewModal(page, 'alpha beta gamma');
  await page.locator('.review-modal .btn-primary').click();

  await expect(page.locator('.review-modal-stream')).toContainText('Reading…', { timeout: 3000 });
  await page.locator('.review-modal .btn-ghost').click(); // Cancel stream

  // Back to the compose form — guidance box visible again, nothing applied.
  await expect(page.locator('#review-guidance')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.comment-card')).toHaveCount(0);
  await expect(page.locator('.suggestion-card')).toHaveCount(0);
});

test('Review: with no linked session the button opens the session picker', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.keyboard.type('alpha beta gamma');

  await expect(page.locator('.session-picker')).toHaveCount(0);
  await page.locator('.review-doc-btn').click();
  await expect(page.locator('.session-picker')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.review-modal')).toHaveCount(0);
});

test('Review: a stream error is shown and the modal can be closed', async ({ page }) => {
  await setupWithMock(page, [
    { kind: 'delta', text: 'partial…' },
    { kind: 'error', message: 'Session no longer available' },
  ]);
  await openReviewModal(page, 'alpha beta gamma');
  await page.locator('.review-modal .btn-primary').click();

  await expect(page.locator('.review-modal-error')).toContainText('Session no longer available', {
    timeout: 3000,
  });
  await page.locator('.review-modal .btn-ghost').click();
  await expect(page.locator('.review-modal')).toHaveCount(0);
});
