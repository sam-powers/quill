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
    if (f) f.childNodes[0].textContent = 'eu-market-entry.md';
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
    cwd: '/Users/sam/work/eu-expansion',
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
await page.keyboard.type('# EU Market Entry — Recommendation', { delay: 1 });
await page.keyboard.press('Enter');
await page.keyboard.type(
  'Recommendation: launch in Germany first, with the Netherlands as a fast follow. Both score highest on payment readiness and time-to-localize.',
  { delay: 1 },
);
await page.keyboard.press('Enter');
await page.keyboard.type(
  'It was determined by our analysis that an initial launch in Germany would be the option that is most advantageous, due to the fact that it has the largest market in the region and localization requirements are able to be satisfied by our existing tooling.',
  { delay: 1 },
);
await page.keyboard.press('Enter');
await page.keyboard.type(
  'Pricing should mirror the US tiers at launch; revisit after the first quarter of revenue data.',
  { delay: 1 },
);
await page.waitForTimeout(300);

await cosmetics(page);
await page.screenshot({ path: `${OUT}/a1.png` });
console.log('a1 done');

// Select the wordy paragraph (triple-click) and post an @claude comment.
const para = page.locator('.ProseMirror p', { hasText: 'determined by our analysis' });
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
await page.screenshot({ path: `${OUT}/a2.png` });
console.log('a2 done');

// Frame: prose complete; the quill-edits fence is held back from display.
await page.evaluate(() =>
  window.__aiPush({ kind: 'delta', text: 'voice, half the words.\n\n```quill-edits\n' }),
);
await page.waitForTimeout(300);
await cosmetics(page);
await page.screenshot({ path: `${OUT}/a3.png` });
console.log('a3 done');

// Finish the stream: edits become Claude-attributed tracked changes.
await page.evaluate(() =>
  window.__aiPush({
    kind: 'delta',
    text:
      JSON.stringify({
        summary: 'Tightened the paragraph and made it active voice.',
        edits: [
          {
            find: 'It was determined by our analysis that an initial launch in Germany would be the option that is most advantageous, due to the fact that',
            replace: 'Our analysis points to Germany for the initial launch:',
          },
          {
            find: 'localization requirements are able to be satisfied by our existing tooling',
            replace: 'our existing tooling already covers localization',
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
await page.screenshot({ path: `${OUT}/a4.png` });
console.log('a4 done');

await browser.close();
console.log('all frames captured');
