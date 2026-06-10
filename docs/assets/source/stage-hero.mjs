// Stages the README hero frames against the Vite dev server, using the same
// __quillMock / __quillTestSession IPC mocks the e2e suite installs, so every
// app frame is real UI. Then encode-hero.mjs assembles the GIF.
//
// Usage (from the repo root):
//   npm run dev          # leave running on :1420
//   node docs/assets/source/stage-hero.mjs
//
// Frames land in docs/assets/source/frames/ (gitignored output, regenerate at will).
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'frames');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1100, height: 740 },
  deviceScaleFactor: 2,
});

// ---------- Terminal frames (CLI launch scene) ----------
for (const step of [1, 2]) {
  const page = await ctx.newPage();
  await page.goto(`file://${path.join(HERE, 'terminal.html')}?step=${step}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t${step}.png` });
  await page.close();
}
console.log('terminal frames done');

// Cosmetic touch-ups applied right before each screenshot (React re-renders
// revert DOM patches): the footer shows an "opened" file name instead of
// Untitled, and the comment author reads Sam instead of the hardcoded
// Anonymous (src/App.tsx AUTHOR).
async function cosmetics(page) {
  await page.evaluate(() => {
    const f = document.querySelector('.footer-filename');
    if (f) f.childNodes[0].textContent = 'using-quill-at-work.md';
    document.querySelectorAll('.comment-author').forEach((el) => {
      if (el.textContent === 'Anonymous') el.textContent = 'Sam';
    });
    document.querySelectorAll('.comment-avatar').forEach((el) => {
      if (el.textContent === 'A') el.textContent = 'S';
    });
  });
}

// ---------- App frames ----------
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__quillTestSession = {
    provider: 'claude-code',
    sessionId: 'a3f8c21b-7d4e-4b2a-9c61-0f5e8d2b4a90',
    cwd: '/Users/sam/work',
    generatedAt: '2026-06-09T10:00:00Z',
  };
  // Mock spawn_claude_resume; the script below pushes ChunkEvents by hand so
  // each frame catches the stream at a chosen moment.
  window.__quillMock = {
    spawn: (_args, onEvent) => {
      window.__aiPush = (ev) => onEvent(ev);
      return 'mock-token';
    },
    cancel: () => {},
  };
});

await page.goto('http://localhost:1420/');
const editor = page.locator('.ProseMirror');
await editor.waitFor({ timeout: 10000 });
await editor.click();
await page.waitForTimeout(200);

// Type the document Claude "wrote" in the terminal scene (markdown input
// rules turn "# " into an H1).
const PARAGRAPHS = [
  '# Using Quill in My Work',
  'Quill is a desktop Markdown editor built around the review pass: tracked changes, inline comments, and an AI reviewer wired to the very Claude Code session that wrote the document. This doc covers where it fits in my week.',
  'The clearest fit is planning docs and client reports. I already draft those with Claude in the terminal; the missing piece was the editing pass. With Quill I send the draft straight from the session into a real editor, and every rewrite — mine or the AI’s — shows up as a suggestion to accept or reject, so nothing changes silently.',
  'It should also be noted that the review process is made considerably more efficient by the fact that comments are able to be anchored to specific passages, and that a question that is asked with @claude is answered by the same agent that was responsible for the writing of the draft.',
  'Everything stays a plain .md file on disk, with comments and suggestions in a sidecar. Drafts remain portable to git, wikis, and anything else that reads Markdown, and a doc with no review metadata is just a clean Markdown file.',
  'To set it up: install the quill-integration plugin, then run /quill-integration:open-in-quill from any session to send its draft into the editor, already linked for @claude review.',
];
for (const [i, text] of PARAGRAPHS.entries()) {
  if (i > 0) await page.keyboard.press('Enter');
  await page.keyboard.type(text, { delay: 1 });
}
await page.waitForTimeout(300);

await cosmetics(page);
await page.screenshot({ path: `${OUT}/a1.png` });
console.log('a1 done');

// ----- Scene 1: ask @claude a question in a comment (research, no rewrite) -----
const sidecarPara = page.locator('.ProseMirror p', { hasText: 'Everything stays a plain' });
await sidecarPara.click({ clickCount: 3 });
await page.waitForTimeout(200);
await page.locator('.add-comment-btn').click();
await page
  .locator('.add-comment-compose textarea')
  .fill('@claude if I send this to a teammate without Quill, what do they see?');
await page.locator('.add-comment-compose .btn-primary').click();
await page.waitForTimeout(400);

// Frame: the answer starts streaming into the thread.
await page.evaluate(() =>
  window.__aiPush({ kind: 'delta', text: 'Just clean Markdown — the review layer ' }),
);
await page.waitForTimeout(300);
await cosmetics(page);
await page.screenshot({ path: `${OUT}/a2.png` });
console.log('a2 done');

// Frame: the researched answer, complete.
await page.evaluate(() =>
  window.__aiPush({
    kind: 'delta',
    text: 'never touches the .md. Comments and suggestions live beside it in using-quill-at-work.comments.json, and Quill restores the full thread on open.',
  }),
);
await page.evaluate(() => window.__aiPush({ kind: 'done' }));
await page.waitForTimeout(500);
await cosmetics(page);
await page.screenshot({ path: `${OUT}/a3.png` });
console.log('a3 done');

// Resolve the answered thread so the rail is clear for the rewrite scene.
await page.locator('.comment-resolve-btn').click();
await page.waitForTimeout(300);

// ----- Scene 2: ask @claude to rewrite the wordy paragraph -----
const para = page.locator('.ProseMirror p', { hasText: 'It should also be noted' });
await para.click({ clickCount: 3 });
await page.waitForTimeout(200);
await page.locator('.add-comment-btn').click();
await page
  .locator('.add-comment-compose textarea')
  .fill('@claude this is wordy and passive — tighten it.');
await page.locator('.add-comment-compose .btn-primary').click();
await page.waitForTimeout(400);

// Frame: streaming begins (spinner + partial reply).
await page.evaluate(() => window.__aiPush({ kind: 'delta', text: 'Tightened — active ' }));
await page.waitForTimeout(300);
await cosmetics(page);
await page.screenshot({ path: `${OUT}/a4.png` });
console.log('a4 done');

// Frame: prose complete; the quill-edits fence is held back from display.
await page.evaluate(() =>
  window.__aiPush({ kind: 'delta', text: 'voice, half the words.\n\n```quill-edits\n' }),
);
await page.waitForTimeout(300);
await cosmetics(page);
await page.screenshot({ path: `${OUT}/a5.png` });
console.log('a5 done');

// Finish the stream: edits become Claude-attributed tracked changes.
await page.evaluate(() =>
  window.__aiPush({
    kind: 'delta',
    text:
      JSON.stringify({
        summary: 'Tightened the paragraph and made it active voice.',
        edits: [
          {
            find: 'It should also be noted that the review process is made considerably more efficient by the fact that comments are able to be anchored to specific passages',
            replace:
              'Anchoring comments to specific passages makes the review pass far more efficient',
          },
          {
            find: 'that a question that is asked with @claude is answered by the same agent that was responsible for the writing of the draft',
            replace: '@claude questions go straight to the agent that wrote the draft',
          },
        ],
      }) + '\n```',
  }),
);
await page.evaluate(() => window.__aiPush({ kind: 'done' }));
await page.waitForTimeout(800);

await cosmetics(page);
// Frame: final state — reply complete, tracked changes + suggestion cards.
// This frame, at full 2x resolution, is also docs/assets/hero.png.
await page.screenshot({ path: `${OUT}/a6.png` });
console.log('a6 done');

await browser.close();
console.log('all frames captured');
