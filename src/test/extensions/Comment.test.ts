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

  // Resolving a comment removes its mark outright (handled in App via
  // `unsetComment`), so the resolved text carries no highlight at all. The
  // only re-stamp path is unresolve, which restores the mark over the
  // comment's stored range via `setCommentRange`.
  describe('resolve removes the mark', () => {
    it('leaves no comment mark after unsetComment (resolve path)', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();

      editor.commands.unsetComment('c-001');

      const marks = getCommentMarks(editor).filter((m) => m.commentId === 'c-001');
      expect(marks).toHaveLength(0);
    });

    it('renders no comment-mark span once resolved', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.chain().setTextSelection({ from: 1, to: 2 }).setComment('c-001').run();

      editor.commands.unsetComment('c-001');

      expect(editor.getHTML()).not.toContain('comment-mark');
    });
  });

  describe('setCommentRange (unresolve re-stamp)', () => {
    it('re-applies a comment mark over an explicit range', () => {
      editor = makeEditor('<p>Hello world</p>');
      // Resolve first (mark gone), then unresolve via the stored range.
      editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c-001').run();
      editor.commands.unsetComment('c-001');
      expect(getCommentMarks(editor).filter((m) => m.commentId === 'c-001')).toHaveLength(0);

      editor.commands.setCommentRange('c-001', 1, 6);

      const marks = getCommentMarks(editor).filter((m) => m.commentId === 'c-001');
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.every((m) => m.resolved === false)).toBe(true);
    });

    it('re-stamped marks render as active, not resolved', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setCommentRange('c-001', 1, 6);

      const html = editor.getHTML();
      expect(html).toContain('comment-mark comment-active');
      expect(html).toContain('data-resolved="false"');
    });

    it('clamps an out-of-bounds range instead of throwing', () => {
      editor = makeEditor('<p>Hello world</p>');
      // `to` past the end of the doc — clamped, not crashed.
      expect(() => editor.commands.setCommentRange('c-001', 1, 9999)).not.toThrow();
      expect(getCommentMarks(editor).filter((m) => m.commentId === 'c-001').length).toBeGreaterThan(
        0,
      );
    });

    it('is a no-op for a zero-width range', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setCommentRange('c-001', 3, 3);
      expect(getCommentMarks(editor).filter((m) => m.commentId === 'c-001')).toHaveLength(0);
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
