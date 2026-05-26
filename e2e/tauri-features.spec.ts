/**
 * Playwright coverage for the three Tauri-backed AI features:
 *   1. Auto-bind on stray .md open (find_session_for_markdown)
 *   2. Compaction detection branching in the prompt (check_session_compacted)
 *   3. quill:// deep-link → openFilePath flow (deep-link-open event)
 *
 * Real Tauri isn't running, so each test installs a minimal IPC shim at
 * window.__TAURI_INTERNALS__ via addInitScript. invoke() in the app code
 * dispatches through that shim, and event-bus listen()/emit() are simulated
 * by the same dispatcher (Tauri's listen() itself goes through invoke()).
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type InvokeHandler = (cmd: string, args: Record<string, unknown>) => unknown;

async function setupWithIPC(
  page: Page,
  opts: {
    handler: InvokeHandler;
    // Optional: inject a fake aiSession so the @claude path runs.
    testSession?: Record<string, unknown>;
    // Optional: capture invoke calls for later assertions.
    captureKey?: string;
  },
): Promise<void> {
  await page.addInitScript(
    ({ handlerSrc, testSession, captureKey }) => {
      // Reconstruct the handler from its source so it can be serialized.

      const handler = new Function('cmd', 'args', 'ctx', `return (${handlerSrc})(cmd, args, ctx);`);

      type Listener = { event: string; cb: (payload: unknown) => void };
      const listeners: Listener[] = [];
      const callbacks = new Map<number, (payload: unknown) => void>();
      let nextCbId = 1;
      const calls: { cmd: string; args: Record<string, unknown> }[] = [];

      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        transformCallback: (cb: (payload: unknown) => void) => {
          const id = nextCbId++;
          callbacks.set(id, cb);
          // Tauri also registers a global function it can call by id; mirror that.
          (window as unknown as Record<string | number, unknown>)[`_${id}`] = (payload: unknown) =>
            cb(payload);
          return id;
        },
        unregisterCallback: (id: number) => {
          callbacks.delete(id);
        },
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          calls.push({ cmd, args });
          // Built-in event plumbing.
          if (cmd === 'plugin:event|listen') {
            const cbId = args.handler as number;
            const ev = args.event as string;
            const cb = callbacks.get(cbId);
            if (cb) listeners.push({ event: ev, cb });
            return cbId;
          }
          if (cmd === 'plugin:event|unlisten') return null;
          // Delegate everything else to the test handler.
          return handler(cmd, args, {
            emit: (event: string, payload: unknown) => {
              for (const l of listeners) {
                if (l.event === event) l.cb({ event, id: 0, payload });
              }
            },
          });
        },
      };

      if (testSession) {
        (window as unknown as Record<string, unknown>).__quillTestSession = testSession;
      }
      if (captureKey) {
        (window as unknown as Record<string, unknown>)[captureKey] = calls;
        // Expose a hook to emit deep-link events from the test runner.
        (window as unknown as Record<string, unknown>).__emitTauri = (
          event: string,
          payload: unknown,
        ) => {
          for (const l of listeners) {
            if (l.event === event) l.cb({ event, id: 0, payload });
          }
        };
      } else {
        (window as unknown as Record<string, unknown>).__emitTauri = (
          event: string,
          payload: unknown,
        ) => {
          for (const l of listeners) {
            if (l.event === event) l.cb({ event, id: 0, payload });
          }
        };
      }
    },
    {
      handlerSrc: opts.handler.toString(),
      testSession: opts.testSession ?? null,
      captureKey: opts.captureKey ?? null,
    },
  );

  await page.goto('/');
  await page.locator('.ProseMirror').waitFor({ timeout: 5000 });
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Auto-bind on stray .md open
// ────────────────────────────────────────────────────────────────────────────

test('auto-bind: stray .md with no sidecar links to matching Claude session', async ({ page }) => {
  // The handler must be self-contained — no closure variables.
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'show_open_dialog') return '/tmp/stray.md';
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/stray.md') return '# Doc body that is long enough to match';
      throw new Error('sidecar not found'); // .comments.json miss → empty sidecar
    }
    if (cmd === 'find_session_for_markdown') {
      return {
        provider: 'claude-code',
        sessionId: 'autobound-session-xyz',
        cwd: '/tmp/proj',
        generatedAt: '2026-05-22T10:00:00Z',
      };
    }
    return null;
  };

  await setupWithIPC(page, { handler });

  // Trigger File → Open via Cmd+O (App.tsx wires this to handleOpen → openFile).
  await page.keyboard.down('Meta');
  await page.keyboard.press('o');
  await page.keyboard.up('Meta');

  // Footer should show the bound session id (Footer.tsx renders `aiSession.sessionId.slice(0,8)`).
  await expect(page.locator('.footer-ai-binding.linked')).toContainText('autoboun', {
    timeout: 3000,
  });
  // Title should show dirty bullet because auto-bind marks the file dirty.
  await page.waitForTimeout(150);
  expect(await page.title()).toContain('•');
});

test('auto-bind: no match leaves session unbound (no false link)', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'show_open_dialog') return '/tmp/orphan.md';
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/orphan.md') return '# Doc that matches nothing';
      throw new Error('sidecar not found');
    }
    if (cmd === 'find_session_for_markdown') return null;
    return null;
  };

  await setupWithIPC(page, { handler });

  await page.keyboard.down('Meta');
  await page.keyboard.press('o');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(300);

  // No linked-session chip in footer (still showing "Link to Claude session…").
  await expect(page.locator('.footer-ai-binding.linked')).toHaveCount(0);
  // The unlinked "Link to Claude session…" affordance should be present.
  await expect(page.locator('.footer-ai-binding').first()).toContainText(/Link to Claude/i);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Compaction detection (prompt branch selection)
// ────────────────────────────────────────────────────────────────────────────

async function fireAIReplyAndCaptureCompactionCall(
  page: Page,
): Promise<{ cmd: string; args: Record<string, unknown> }[]> {
  // Add a comment with @claude so useClaudeReply.ask fires.
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('content to comment on');
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(50);
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill('seed');
  await page.locator('.add-comment-compose .btn-primary').click();
  await page.waitForTimeout(150);
  await page.locator('.comment-reply-trigger').click();
  await page.locator('.comment-reply-input').fill('@claude evaluate');
  await page.locator('.comment-card .btn-primary').click();
  await page.waitForTimeout(400);
  return page.evaluate(
    () =>
      (window as unknown as Record<string, unknown>).__capturedCalls as {
        cmd: string;
        args: Record<string, unknown>;
      }[],
  );
}

test('compaction: non-compacted session sends diff form to claude', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'check_session_compacted') {
      return { compacted: false, originalMarkdown: 'original baseline text' };
    }
    if (cmd === 'spawn_claude_resume') {
      (window as unknown as Record<string, unknown>).__capturedPrompt = args.prompt;
      return 'mock-token-1';
    }
    if (cmd === 'cancel_claude_resume') return null;
    return null;
  };

  await setupWithIPC(page, {
    handler,
    testSession: {
      provider: 'claude-code',
      sessionId: 'sess-not-compacted',
      cwd: '/tmp/x',
      generatedAt: '2026-01-01T00:00:00Z',
    },
    captureKey: '__capturedCalls',
  });

  await fireAIReplyAndCaptureCompactionCall(page);

  // Verify check_session_compacted was invoked.
  const calls = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__capturedCalls as { cmd: string }[],
  );
  expect(calls.some((c) => c.cmd === 'check_session_compacted')).toBe(true);

  // Prompt should be the diff form ("here is the diff between…").
  const prompt = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__capturedPrompt as string,
  );
  expect(prompt).toContain('Your context is intact');
  expect(prompt).toContain('diff between what you originally wrote');
  expect(prompt).not.toContain('Your context was compacted');
});

test('compaction: compacted session sends full doc with compaction note', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'check_session_compacted') {
      return { compacted: true, originalMarkdown: null };
    }
    if (cmd === 'spawn_claude_resume') {
      (window as unknown as Record<string, unknown>).__capturedPrompt = args.prompt;
      return 'mock-token-2';
    }
    if (cmd === 'cancel_claude_resume') return null;
    return null;
  };

  await setupWithIPC(page, {
    handler,
    testSession: {
      provider: 'claude-code',
      sessionId: 'sess-compacted',
      cwd: '/tmp/x',
      generatedAt: '2026-01-01T00:00:00Z',
    },
    captureKey: '__capturedCalls',
  });

  await fireAIReplyAndCaptureCompactionCall(page);

  const prompt = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__capturedPrompt as string,
  );
  expect(prompt).toContain('Your context was compacted');
  expect(prompt).not.toContain('Your context is intact');
});

// ────────────────────────────────────────────────────────────────────────────
// 3. quill:// deep-link → openFilePath
// ────────────────────────────────────────────────────────────────────────────

test('deep-link: deep-link-open event opens the file at the payload path', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/linked.md') return '# Linked document content';
      throw new Error('sidecar not found');
    }
    if (cmd === 'find_session_for_markdown') return null;
    return null;
  };

  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  // Give App.tsx's useEffect a tick to register its listen('deep-link-open').
  await page.waitForTimeout(200);

  // Fire the event through our IPC shim.
  await page.evaluate(() => {
    (window as unknown as { __emitTauri: (e: string, p: unknown) => void }).__emitTauri(
      'deep-link-open',
      '/tmp/linked.md',
    );
  });

  // Editor should now contain the linked content.
  await expect(page.locator('.ProseMirror')).toContainText('Linked document content', {
    timeout: 3000,
  });
  // Footer filename should reflect the opened file.
  await expect(page.locator('.footer-filename')).toContainText('linked.md');
});

test('deep-link: empty payload is ignored (no crash, no file load)', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    (window as unknown as { __emitTauri: (e: string, p: unknown) => void }).__emitTauri(
      'deep-link-open',
      '',
    );
  });
  await page.waitForTimeout(200);

  // Filename stays at Untitled.
  await expect(page.locator('.footer-filename')).toContainText('Untitled');
});
