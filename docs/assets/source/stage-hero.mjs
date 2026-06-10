// Stages the README hero frames against the Vite dev server, using the same
// __quillMock / __quillTestSession IPC mocks the e2e suite installs, so every
// app frame is real UI. Rather than a handful of slides, this captures ~100
// micro-steps (typing, streaming, tracked changes landing) so the encoded GIF
// reads like a screen recording. encode-hero.mjs assembles the GIF from the
// frames.json manifest written here.
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
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1100, height: 740 },
  deviceScaleFactor: 2,
});

// Frame manifest: capture order + per-frame GIF delay (ms).
const manifest = [];
let seq = 0;
async function snap(page, delay, prepare) {
  if (prepare) await prepare();
  const file = `seq-${String(seq++).padStart(3, '0')}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  manifest.push({ file, delay });
}
// Extend the hold on the most recent frame instead of capturing a duplicate.
const hold = (ms) => (manifest[manifest.length - 1].delay += ms);

// ---------- Terminal scene (Claude researches and writes the report) ----------
const term = await ctx.newPage();
await term.goto(`file://${path.join(HERE, 'terminal.html')}`);
await term.waitForTimeout(300);

const ASK = 'Research Quill and write a doc about how I can use it in my work';
const SLASH = '/quill-integration:open-in-quill using-quill-at-work.md';

await snap(term, 800);
for (let i = 6; i < ASK.length + 6; i += 6) {
  await term.evaluate((t) => window.setText('#ask', t), ASK.slice(0, i));
  await snap(term, 70);
}
hold(500);
await term.evaluate(() => window.hide('#c1'));
await term.evaluate(() => window.reveal('#out1a'));
await snap(term, 900);
await term.evaluate(() => window.reveal('#out1b'));
await snap(term, 1200);
await term.evaluate(() => window.reveal('#slashline'));
await snap(term, 350);
for (let i = 5; i < SLASH.length + 5; i += 5) {
  await term.evaluate((t) => window.setText('#slashcmd', t), SLASH.slice(0, i));
  await snap(term, 60);
}
hold(400);
await term.evaluate(() => window.hide('#c2'));
await term.evaluate(() => window.reveal('#out2'));
await snap(term, 1800);
await term.close();
console.log('terminal scene done,', seq, 'frames');

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

// ---------- App scene ----------
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__quillTestSession = {
    provider: 'claude-code',
    sessionId: 'a3f8c21b-7d4e-4b2a-9c61-0f5e8d2b4a90',
    cwd: '/Users/sam/work',
    generatedAt: '2026-06-09T10:00:00Z',
  };
  // Mock spawn_claude_resume; the script below pushes ChunkEvents by hand so
  // the stream advances exactly one chunk per captured frame.
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

const appSnap = (delay) => snap(page, delay, () => cosmetics(page));

// The document Claude "wrote" in the terminal scene pours in quickly, a slice
// per frame — opening a file, not watching someone type (markdown input rules
// turn "# " into an H1).
const PARAGRAPHS = [
  '# Using Quill in My Work',
  'Quill is a desktop Markdown editor built around the review pass: tracked changes, inline comments, and an AI reviewer wired to the very Claude Code session that wrote the document. This doc covers where it fits in my week.',
  'The clearest fit is planning docs and client reports. I already draft those with Claude in the terminal; the missing piece was the editing pass. With Quill I send the draft straight from the session into a real editor, and every rewrite — mine or the AI’s — shows up as a suggestion to accept or reject, so nothing changes silently.',
  'It should also be noted that the review process is made considerably more efficient by the fact that comments are able to be anchored to specific passages, and that a question that is asked with @claude is answered by the same agent that was responsible for the writing of the draft.',
  'Everything stays a plain .md file on disk, with comments and suggestions in a sidecar. Drafts remain portable to git, wikis, and anything else that reads Markdown, and a doc with no review metadata is just a clean Markdown file.',
  'To set it up: install the quill-integration plugin, then run /quill-integration:open-in-quill from any session to send its draft into the editor, already linked for @claude review.',
];
const SLICE = 120;
for (const [i, text] of PARAGRAPHS.entries()) {
  if (i > 0) await page.keyboard.press('Enter');
  for (let off = 0; off < text.length; off += SLICE) {
    await page.keyboard.type(text.slice(off, off + SLICE), { delay: 0 });
    await appSnap(110);
  }
}
hold(1400);

// Types a comment into the compose box a few characters per frame, then posts.
async function composeComment(paraText, commentText) {
  const para = page.locator('.ProseMirror p', { hasText: paraText });
  await para.click({ clickCount: 3 });
  await page.waitForTimeout(200);
  await appSnap(500);
  await page.locator('.add-comment-btn').click();
  await page.waitForTimeout(200);
  await appSnap(400);
  const box = page.locator('.add-comment-compose textarea');
  for (let i = 6; i < commentText.length + 6; i += 6) {
    await box.fill(commentText.slice(0, i));
    await appSnap(80);
  }
  hold(350);
  await page.locator('.add-comment-compose .btn-primary').click();
  await page.waitForTimeout(400);
  await appSnap(600);
}

// Streams a reply a few words per frame.
async function streamReply(text, perFrameDelay) {
  const words = text.split(' ');
  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3).join(' ') + (i + 3 < words.length ? ' ' : '');
    await page.evaluate((t) => window.__aiPush({ kind: 'delta', text: t }), chunk);
    await appSnap(perFrameDelay);
  }
}

// ----- Scene 1: ask @claude a question in a comment (research, no rewrite) -----
await composeComment(
  'Everything stays a plain',
  '@claude if I send this to a teammate without Quill, what do they see?',
);
await streamReply(
  'Just clean Markdown — the review layer never touches the .md. Comments and suggestions live beside it in using-quill-at-work.comments.json, and Quill restores the full thread on open.',
  130,
);
await page.evaluate(() => window.__aiPush({ kind: 'done' }));
await page.waitForTimeout(400);
await appSnap(3200);

// Resolve the answered thread so the rail is clear for the rewrite scene.
await page.locator('.comment-resolve-btn').click();
await page.waitForTimeout(300);
await appSnap(600);

// ----- Scene 2: ask @claude to rewrite the wordy paragraph -----
await composeComment('It should also be noted', '@claude this is wordy and passive — tighten it.');
await streamReply('Tightened — active voice, half the words.', 130);

// The quill-edits fence streams next (held back from display), then the edits
// land as Claude-attributed tracked changes.
await page.evaluate(() => window.__aiPush({ kind: 'delta', text: '\n\n```quill-edits\n' }));
await appSnap(300);
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

// Final frame: tracked changes + suggestion cards. At full 2x resolution this
// is also docs/assets/hero.png.
await appSnap(5000);

fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(manifest, null, 2));
await browser.close();
console.log('all frames captured:', seq);
