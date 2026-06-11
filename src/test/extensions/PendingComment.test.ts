import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, afterEach } from 'vitest';
import { PendingComment, PENDING_COMMENT_KEY } from '../../extensions/PendingComment';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, PendingComment],
    content,
  });
}

function getRange(editor: Editor) {
  return PENDING_COMMENT_KEY.getState(editor.state) ?? null;
}

function decoratedText(editor: Editor): string {
  return Array.from(editor.view.dom.querySelectorAll('.pending-comment'))
    .map((el) => el.textContent)
    .join('');
}

describe('PendingComment extension', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('renders an inline decoration over the range', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.commands.setPendingCommentRange(1, 6);

    expect(getRange(editor)).toEqual({ from: 1, to: 6 });
    expect(decoratedText(editor)).toBe('Hello');
  });

  it('does not modify the document or its serialized HTML', () => {
    editor = makeEditor('<p>Hello world</p>');
    const htmlBefore = editor.getHTML();
    editor.commands.setPendingCommentRange(1, 6);

    expect(editor.getHTML()).toBe(htmlBefore);
  });

  it('clearPendingCommentRange removes the decoration', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.commands.setPendingCommentRange(1, 6);
    editor.commands.clearPendingCommentRange();

    expect(getRange(editor)).toBeNull();
    expect(decoratedText(editor)).toBe('');
  });

  it('rejects an empty range', () => {
    editor = makeEditor('<p>Hello world</p>');
    expect(editor.commands.setPendingCommentRange(3, 3)).toBe(false);
    expect(getRange(editor)).toBeNull();
  });

  it('maps the range through edits earlier in the document', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.commands.setPendingCommentRange(7, 12); // "world"
    editor.chain().setTextSelection(1).insertContentAt(1, 'XX').run();

    expect(getRange(editor)).toEqual({ from: 9, to: 14 });
    expect(decoratedText(editor)).toBe('world');
  });

  it('clears itself when the range is deleted entirely', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.commands.setPendingCommentRange(7, 12); // "world"
    editor.commands.deleteRange({ from: 6, to: 12 });

    expect(getRange(editor)).toBeNull();
    expect(decoratedText(editor)).toBe('');
  });

  it('survives setting a new range over an existing one', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.commands.setPendingCommentRange(1, 6);
    editor.commands.setPendingCommentRange(7, 12);

    expect(getRange(editor)).toEqual({ from: 7, to: 12 });
    expect(decoratedText(editor)).toBe('world');
  });
});
