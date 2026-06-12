import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect } from 'vitest';
import { MarkdownImage } from '../../extensions/MarkdownImage';

// Mirrors the Markdown-relevant extension set in components/Editor.tsx —
// keep the two in sync, or these guarantees say nothing about the app.
function roundTrip(md: string): string {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        trailingNode: false,
        link: { openOnClick: false },
      }),
      MarkdownImage,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: md,
  });
  const out = (editor.storage as unknown as Record<string, { getMarkdown: () => string }>)[
    'markdown'
  ].getMarkdown();
  editor.destroy();
  return out;
}

/** Load → serialize must preserve the construct, and serializing the result
 * again must be a fixed point (no drift on repeated open/save cycles). */
function expectStable(md: string, mustContain: string[]) {
  const out = roundTrip(md);
  for (const fragment of mustContain) {
    expect(out).toContain(fragment);
  }
  expect(roundTrip(out)).toBe(out);
}

describe('markdown round-trip fidelity', () => {
  it('block images survive with their original src', () => {
    expectStable('Before\n\n![alt text](./pic.png)\n\nAfter', [
      '![alt text](./pic.png)',
      'Before',
      'After',
    ]);
  });

  it('inline images stay inline', () => {
    const out = roundTrip('text ![icon](https://x.com/i.png) more');
    expect(out).toBe('text ![icon](https://x.com/i.png) more');
  });

  it('images with titles keep the title', () => {
    expectStable('![alt](./p.png "the title")', ['![alt](./p.png "the title")']);
  });

  it('tables keep their cells', () => {
    expectStable('| a | b |\n| - | - |\n| 1 | 2 |', ['| a |', '| 1 |', '| 2 |']);
  });

  it('formatted table cells keep their formatting', () => {
    expectStable('| a | b |\n| --- | --- |\n| **bold** | [x](https://x.com) |', [
      '**bold**',
      '[x](https://x.com)',
    ]);
  });

  it('task lists keep their checked state', () => {
    expectStable('- [ ] todo\n- [x] done', ['[ ] todo', '[x] done']);
  });

  it('nested task lists keep their structure', () => {
    expectStable('- [ ] parent\n  - [x] child', ['[ ] parent', '[x] child']);
  });

  it('links round-trip exactly', () => {
    expect(roundTrip('A [link](https://example.com) here.')).toBe(
      'A [link](https://example.com) here.',
    );
  });

  it('core formatting round-trips exactly', () => {
    const md = '# Title\n\nSome **bold**, *italic*, ~~struck~~, and `code`.\n\n> A quote.';
    expect(roundTrip(md)).toBe(md);
  });
});
