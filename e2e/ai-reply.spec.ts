/**
 * Playwright coverage for the AI comment-reply state machine.
 *
 * The real `spawn_claude_resume` Tauri command isn't available in CI, so each
 * test installs `window.__quillMock` via `page.addInitScript()` before the app
 * mounts. The mock plays scripted ChunkEvents and `window.__quillTestSession`
 * seeds a fake binding so the @claude code path runs without a SessionPicker.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type MockScriptStep =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'pause' }; // hold open until cancel

// Installs a mock that plays a DIFFERENT script for each successive spawn. The
// Nth spawn (0-indexed) plays scripts[N]; once past the end, the last script
// repeats. This lets a test drive an error-then-success retry flow: the first
// spawn fails, the retry (a second spawn) succeeds.
async function setupWithMockScripts(
  page: Page,
  scripts: MockScriptStep[][],
  sessionOverrides: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    ({
      scriptList,
      overrides,
    }: {
      scriptList: MockScriptStep[][];
      overrides: Record<string, unknown>;
    }) => {
      type Ev =
        | { kind: 'delta'; text: string }
        | { kind: 'done' }
        | { kind: 'error'; message: string }
        | { kind: 'cancelled' };

      let nextTokenId = 0;
      let spawnIndex = 0;
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
          const steps = scriptList[Math.min(spawnIndex, scriptList.length - 1)];
          spawnIndex++;
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
    { scriptList: scripts, overrides: sessionOverrides },
  );

  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
}

// The common case: one script replayed for every spawn.
async function setupWithMock(
  page: Page,
  script: MockScriptStep[],
  sessionOverrides: Record<string, unknown> = {},
): Promise<void> {
  await setupWithMockScripts(page, [script], sessionOverrides);
}

async function addCommentWithAIReply(page: Page, anchor: string, replyText: string) {
  await page.keyboard.type(anchor);
  // Select all
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
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

// Mounts the app WITHOUT seeding a session, so @claude has nothing to talk to.
// Used to verify the prompt-to-link behavior.
async function setupWithoutSession(page: Page): Promise<void> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
}

// Adds a comment whose initial composer body itself contains @claude (no reply
// step). Exercises the "tag Claude in the first comment" path.
async function addCommentTaggingClaude(page: Page, anchor: string, body: string) {
  await page.keyboard.type(anchor);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(50);
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill(body);
  await page.locator('.add-comment-compose .btn-primary').click();
}

test('AI reply: pending → delta → done streams chunks and clears spinner', async ({ page }) => {
  await setupWithMock(page, [
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
});

test('AI reply: @claude in the initial comment triggers a reply', async ({ page }) => {
  await setupWithMock(page, [
    { kind: 'delta', text: 'On it — ' },
    { kind: 'delta', text: 'done.' },
    { kind: 'done' },
  ]);

  await addCommentTaggingClaude(page, 'hello world', '@claude please review this');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('.comment-reply-text')).toContainText('On it — done.', {
    timeout: 3000,
  });
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0);

  // Thread order: the user's question must render above Claude's answer.
  const replies = page.locator('.comment-reply');
  await expect(replies.first()).toContainText('@claude please review this');
  await expect(replies.first()).not.toHaveClass(/comment-reply-ai/);
});

test('AI reply: @claude with no linked session opens the session picker', async ({ page }) => {
  await setupWithoutSession(page);
  // Session picker must not be open yet.
  await expect(page.locator('.session-picker')).toHaveCount(0);

  await addCommentTaggingClaude(page, 'hello world', '@claude take a look');

  // Tagging Claude with no session prompts the user to link one.
  await expect(page.locator('.session-picker')).toBeVisible({ timeout: 2000 });
});

test('AI reply: @claude in a reply with no linked session opens the session picker', async ({
  page,
}) => {
  await setupWithoutSession(page);
  await expect(page.locator('.session-picker')).toHaveCount(0);

  // Same as the initial-comment case, but via the reply form on an existing
  // comment — this path used to silently drop the @claude request.
  await addCommentWithAIReply(page, 'hello world', '@claude take a look');

  await expect(page.locator('.session-picker')).toBeVisible({ timeout: 2000 });
});

test('Session picker: offers "Start new session", disabled until the doc is saved', async ({
  page,
}) => {
  await setupWithoutSession(page);
  await addCommentTaggingClaude(page, 'hello world', '@claude take a look');

  await expect(page.locator('.session-picker')).toBeVisible({ timeout: 2000 });
  // In the browser the document has no file path yet, so the button renders
  // but stays disabled — the new session needs the doc's folder as its cwd.
  const startNew = page.locator('.session-picker-new');
  await expect(startNew).toBeVisible();
  await expect(startNew).toBeDisabled();
});

test('AI reply: a Quill-created binding spawns with allowCreate', async ({ page }) => {
  await setupWithMock(page, [{ kind: 'delta', text: 'Hi!' }, { kind: 'done' }], {
    createdByQuill: true,
  });

  await addCommentTaggingClaude(page, 'hello world', '@claude introduce yourself');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply.locator('.comment-reply-text')).toContainText('Hi!', { timeout: 3000 });

  const args = await page.evaluate(
    () => (window as unknown as { __lastSpawnArgs: unknown }).__lastSpawnArgs,
  );
  expect(args).toMatchObject({ sessionId: 'test-session-id', allowCreate: true });
  // A fresh session never authored the doc — the prompt must not claim it did.
  const prompt = (args as { prompt: string }).prompt;
  expect(prompt).not.toContain('previously authored');
  expect(prompt).toContain('Here is the full current document:');
});

test('AI reply: a session-loss error shows Re-link primary plus a secondary Retry', async ({
  page,
}) => {
  // "session not found" classifies as kind:'session' → Re-link is the primary
  // affordance, and because a session error is still retryable a secondary
  // Retry is offered too.
  await setupWithMock(page, [
    { kind: 'delta', text: 'partial...' },
    { kind: 'error', message: 'session not found' },
  ]);

  await addCommentWithAIReply(page, 'hello world', '@claude help');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('.comment-reply-error')).toContainText('session not found', {
    timeout: 3000,
  });
  await expect(aiReply.getByRole('button', { name: /Re-link session/i })).toBeVisible();
  await expect(aiReply.getByRole('button', { name: /^Retry$/i })).toBeVisible();
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0);
});

test('AI reply: a transient error shows Retry (no Re-link) and retry succeeds in place', async ({
  page,
}) => {
  // First spawn fails with a transient API error; the failed reply offers a
  // primary Retry and no Re-link. Clicking Retry re-issues the identical
  // request against the SAME reply entry, which the second script completes.
  await setupWithMockScripts(page, [
    [
      { kind: 'delta', text: 'partial...' },
      { kind: 'error', message: 'API Error: overloaded' },
    ],
    [{ kind: 'delta', text: 'Second time worked.' }, { kind: 'done' }],
  ]);

  await addCommentWithAIReply(page, 'hello world', '@claude help');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('.comment-reply-error')).toContainText('API Error: overloaded', {
    timeout: 3000,
  });
  // Transient → Retry is the primary action; Re-link is demoted to a ghost
  // secondary rather than hidden.
  const retryBtn = aiReply.getByRole('button', { name: /^Retry$/i });
  await expect(retryBtn).toBeVisible();
  await expect(retryBtn).toHaveClass(/btn-primary/);
  await expect(aiReply.getByRole('button', { name: /Re-link session/i })).toHaveClass(/btn-ghost/);

  await retryBtn.click();

  // Same reply entry recovers: error clears and the second script's text lands.
  await expect(aiReply.locator('.comment-reply-text')).toContainText('Second time worked.', {
    timeout: 3000,
  });
  await expect(aiReply.locator('.comment-reply-error')).toHaveCount(0);
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0);
  // Exactly one AI reply — retry reused the entry, it did not append a new one.
  await expect(page.locator('.comment-reply-ai')).toHaveCount(1);
});

// Selects the first `count` characters of the current line (from its start),
// then opens the comment composer and posts an @claude reply. Used to exercise
// edit scope: only the highlighted substring should be editable.
async function addCommentOnPrefix(page: Page, anchor: string, count: number, replyText: string) {
  await page.keyboard.type(anchor);
  await page.keyboard.press('Home'); // to line start (platform-agnostic; Cmd/Ctrl+Left differ across OSes)
  await page.keyboard.down('Shift');
  for (let i = 0; i < count; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill('seed comment');
  await page.locator('.add-comment-compose .btn-primary').click();
  await page.waitForTimeout(150);
  await page.locator('.comment-reply-trigger').click();
  await page.locator('.comment-reply-input').fill(replyText);
  await page.locator('.comment-card .btn-primary').click();
}

test('AI edits: prose + quill-edits block (fence split across deltas) becomes a suggestion', async ({
  page,
}) => {
  // The opening fence is split across two deltas to prove the holdback strategy
  // never leaks a partial fence into the visible reply.
  await setupWithMock(page, [
    { kind: 'delta', text: 'Fixed the subject-verb agreement.\n\n```quil' },
    { kind: 'delta', text: 'l-edits\n' },
    {
      kind: 'delta',
      text: '{"summary":"Fixed subject-verb agreement.","edits":[{"find":"cat are","replace":"cats are"}]}\n```',
    },
    { kind: 'done' },
  ]);

  await addCommentWithAIReply(page, 'the cat are happy', '@claude fix the grammar');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });

  const replyText = aiReply.locator('.comment-reply-text');
  await expect(replyText).toContainText('Fixed the subject-verb agreement.', { timeout: 3000 });
  // The JSON block must never reach the user.
  await expect(replyText).not.toContainText('quill-edits');
  await expect(replyText).not.toContainText('"find"');
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0);

  // A suggestion card appears for the edit, authored by Claude.
  const card = page.locator('.suggestion-card');
  await expect(card.first()).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.suggestion-card .comment-author').first()).toHaveText('Claude (AI)');
  // The new text "cats are" shows up as a tracked insertion in the document.
  await expect(page.locator('.ProseMirror')).toContainText('cats are');
});

test('AI edits: an edit outside the highlight is skipped and surfaced', async ({ page }) => {
  // Highlight only "alpha" (first 5 chars). The edit targeting "gamma" lies
  // outside the highlight, so it must be skipped — not applied.
  await setupWithMock(page, [
    { kind: 'delta', text: 'Capitalized the opening word.\n\n```quill-edits\n' },
    {
      kind: 'delta',
      text: '{"summary":"x","edits":[{"find":"gamma","replace":"GAMMA"}]}\n```',
    },
    { kind: 'done' },
  ]);

  await addCommentOnPrefix(page, 'alpha beta gamma', 5, '@claude tidy this up');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  // The out-of-range edit is reported as skipped, and the document is unchanged.
  await expect(aiReply.locator('.comment-reply-text')).toContainText('skipped', { timeout: 3000 });
  await expect(page.locator('.suggestion-card')).toHaveCount(0);
  await expect(page.locator('.ProseMirror')).not.toContainText('GAMMA');
});

test('AI edits: "whole paragraph" widens scope beyond the highlight', async ({ page }) => {
  // Highlight only "alpha" but ask for the whole paragraph; an edit on "gamma"
  // (elsewhere in the paragraph) should now apply.
  await setupWithMock(page, [
    { kind: 'delta', text: 'Revised across the paragraph.\n\n```quill-edits\n' },
    {
      kind: 'delta',
      text: '{"summary":"x","edits":[{"find":"gamma","replace":"GAMMA"}]}\n```',
    },
    { kind: 'done' },
  ]);

  await addCommentOnPrefix(page, 'alpha beta gamma', 5, '@claude rewrite the whole paragraph');

  const aiReply = page.locator('.comment-reply-ai').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('.ai-spinner')).toHaveCount(0, { timeout: 3000 });
  // The edit landed even though it was outside the highlight.
  await expect(page.locator('.suggestion-card').first()).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.ProseMirror')).toContainText('GAMMA');
});

test('AI reply: pending → cancel resolves without leaving spinner', async ({ page }) => {
  await setupWithMock(page, [{ kind: 'delta', text: 'starting...' }, { kind: 'pause' }]);

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
});
