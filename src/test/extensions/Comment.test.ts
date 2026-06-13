import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, afterEach } from 'vitest';
import { CommentMark } from '../../extensions/Comment';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, CommentMark],
    content,
  });
}

function getCommentMarks(editor: Editor) {
  const marks: Array<{ commentId: string; resolved: boolean }> = [];
  editor.state.doc.descendants((node) => {
    node.marks
      .filter((m) => m.type.name === 'comment')
      .forEach((m) => marks.push({ commentId: m.attrs.commentId, resolved: m.attrs.resolved }));
  });
  return marks;
}

describe('CommentMark extension', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  describe('setComment', () => {
    it('applies a comment mark with the correct commentId and resolved:false', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();

      const marks = getCommentMarks(editor);
      // ProseMirror applies one mark per text node, not per character
      expect(marks.length).toBeGreaterThanOrEqual(1);
      expect(marks[0].commentId).toBe('c-001');
      expect(marks[0].resolved).toBe(false);
    });

    it('can apply different comment marks to different ranges independently', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      editor.chain().setTextSelection({ from: 7, to: 12 }).setComment('c-002').run();

      const marks = getCommentMarks(editor);
      const ids = [...new Set(marks.map((m) => m.commentId))];
      expect(ids).toContain('c-001');
      expect(ids).toContain('c-002');
    });
  });

  describe('unsetComment', () => {
    it('removes marks for the targeted commentId across all nodes', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      editor.commands.unsetComment('c-001');

      const marks = getCommentMarks(editor);
      expect(marks.filter((m) => m.commentId === 'c-001')).toHaveLength(0);
    });

    it('leaves other comment marks intact when removing one', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      editor.chain().setTextSelection({ from: 7, to: 12 }).setComment('c-002').run();

      editor.commands.unsetComment('c-001');

      const marks = getCommentMarks(editor);
      expect(marks.filter((m) => m.commentId === 'c-001')).toHaveLength(0);
      expect(marks.filter((m) => m.commentId === 'c-002').length).toBeGreaterThan(0);
    });

    it('is a no-op when the commentId does not exist', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      const before = getCommentMarks(editor).length;

      editor.commands.unsetComment('nonexistent');
      expect(getCommentMarks(editor)).toHaveLength(before);
    });
  });

  describe('setCommentResolved', () => {
    it('re-stamps the mark resolved attr to true', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();

      editor.commands.setCommentResolved('c-001', true);

      const marks = getCommentMarks(editor).filter((m) => m.commentId === 'c-001');
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.every((m) => m.resolved === true)).toBe(true);
    });

    it('re-stamps the mark resolved attr back to false', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      editor.commands.setCommentResolved('c-001', true);

      editor.commands.setCommentResolved('c-001', false);

      const marks = getCommentMarks(editor).filter((m) => m.commentId === 'c-001');
      expect(marks.every((m) => m.resolved === false)).toBe(true);
    });

    it('only re-stamps the targeted commentId', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      editor.chain().setTextSelection({ from: 7, to: 12 }).setComment('c-002').run();

      editor.commands.setCommentResolved('c-001', true);

      const marks = getCommentMarks(editor);
      expect(marks.filter((m) => m.commentId === 'c-001').every((m) => m.resolved)).toBe(true);
      expect(marks.filter((m) => m.commentId === 'c-002').every((m) => !m.resolved)).toBe(true);
    });

    it('keeps the mark on the text so resolved comments can still re-anchor', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      const before = getCommentMarks(editor).filter((m) => m.commentId === 'c-001').length;

      editor.commands.setCommentResolved('c-001', true);

      const after = getCommentMarks(editor).filter((m) => m.commentId === 'c-001').length;
      expect(after).toBe(before);
    });

    it('is a no-op when the commentId does not exist', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();

      editor.commands.setCommentResolved('nonexistent', true);

      const marks = getCommentMarks(editor).filter((m) => m.commentId === 'c-001');
      expect(marks.every((m) => m.resolved === false)).toBe(true);
    });

    it('renders a resolved comment with class comment-resolved', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 2 }).setComment('c-001').run();

      editor.commands.setCommentResolved('c-001', true);

      const html = editor.getHTML();
      expect(html).toContain('comment-mark comment-resolved');
      expect(html).toContain('data-resolved="true"');
    });
  });

  describe('HTML rendering', () => {
    it('renders an unresolved comment with class comment-active', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 2 }).setComment('c-001').run();
      const html = editor.getHTML();
      expect(html).toContain('comment-mark comment-active');
      expect(html).toContain('data-comment-id="c-001"');
      expect(html).toContain('data-resolved="false"');
    });
  });
});
