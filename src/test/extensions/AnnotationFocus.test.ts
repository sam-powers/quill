import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, afterEach } from 'vitest';
import {
  AnnotationFocus,
  ANNOTATION_FOCUS_KEY,
  findAnnotationRange,
} from '../../extensions/AnnotationFocus';
import { CommentMark } from '../../extensions/Comment';
import { TrackedInsert, TrackedDelete } from '../../extensions/TrackChanges';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, CommentMark, TrackedInsert, TrackedDelete, AnnotationFocus],
    content,
  });
}

function focusedText(editor: Editor): string {
  return Array.from(editor.view.dom.querySelectorAll('.annotation-focus'))
    .map((el) => el.textContent)
    .join('');
}

function addTracked(
  editor: Editor,
  markName: 'tracked_insert' | 'tracked_delete',
  from: number,
  to: number,
  id: string,
  pairId?: string,
) {
  const type = editor.schema.marks[markName];
  const dataTracked = {
    id,
    operation: markName === 'tracked_insert' ? 'insert' : 'delete',
    authorID: 'Anonymous',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(pairId ? { pairId } : {}),
  };
  editor.view.dispatch(
    editor.state.tr.addMark(from, to, type.create({ dataTracked, changeId: id })),
  );
}

function addTrackedInsert(editor: Editor, from: number, to: number, id: string) {
  addTracked(editor, 'tracked_insert', from, to, id);
}

describe('AnnotationFocus extension', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('decorates the text of a focused comment', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c1').run();
    editor.commands.setAnnotationFocus('comment', 'c1');

    expect(ANNOTATION_FOCUS_KEY.getState(editor.state)).toEqual({ kind: 'comment', id: 'c1' });
    expect(focusedText(editor)).toBe('Hello');
  });

  it('decorates the text of a focused suggestion', () => {
    editor = makeEditor('<p>Hello world</p>');
    addTrackedInsert(editor, 7, 12, 's1');
    editor.commands.setAnnotationFocus('suggestion', 's1');

    expect(focusedText(editor)).toBe('world');
  });

  it('does not modify the document or its serialized HTML', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c1').run();
    const htmlBefore = editor.getHTML();
    editor.commands.setAnnotationFocus('comment', 'c1');

    expect(editor.getHTML()).toBe(htmlBefore);
  });

  it('clearAnnotationFocus removes the decoration', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c1').run();
    editor.commands.setAnnotationFocus('comment', 'c1');
    editor.commands.clearAnnotationFocus();

    expect(ANNOTATION_FOCUS_KEY.getState(editor.state)).toBeNull();
    expect(focusedText(editor)).toBe('');
  });

  it('moves the decoration when focus switches to another annotation', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c1').run();
    addTrackedInsert(editor, 7, 12, 's1');

    editor.commands.setAnnotationFocus('comment', 'c1');
    expect(focusedText(editor)).toBe('Hello');

    editor.commands.setAnnotationFocus('suggestion', 's1');
    expect(focusedText(editor)).toBe('world');
  });

  it('follows the annotation through edits earlier in the document', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 7, to: 12 }).setComment('c1').run();
    editor.commands.setAnnotationFocus('comment', 'c1');
    editor.chain().setTextSelection(1).insertContentAt(1, 'XX').run();

    expect(focusedText(editor)).toBe('world');
  });

  it('focusing a replacement by pairId decorates both halves', () => {
    editor = makeEditor('<p>Hello world</p>');
    addTracked(editor, 'tracked_delete', 1, 6, 'd1', 'p1');
    addTracked(editor, 'tracked_insert', 7, 12, 'i1', 'p1');
    editor.commands.setAnnotationFocus('suggestion', 'p1');

    expect(focusedText(editor)).toBe('Helloworld');
  });

  it('focusing one half by its own id decorates only that half', () => {
    editor = makeEditor('<p>Hello world</p>');
    addTracked(editor, 'tracked_delete', 1, 6, 'd1', 'p1');
    addTracked(editor, 'tracked_insert', 7, 12, 'i1', 'p1');
    editor.commands.setAnnotationFocus('suggestion', 'd1');

    expect(focusedText(editor)).toBe('Hello');
  });

  it('renders nothing once the annotation is gone from the document', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c1').run();
    editor.commands.setAnnotationFocus('comment', 'c1');
    editor.commands.unsetComment('c1');

    expect(focusedText(editor)).toBe('');
  });
});

describe('findAnnotationRange', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('returns the live range of a comment mark', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('c1').run();

    expect(findAnnotationRange(editor.state.doc, 'comment', 'c1')).toEqual({ from: 1, to: 6 });
  });

  it('returns the live range of a tracked change', () => {
    editor = makeEditor('<p>Hello world</p>');
    addTrackedInsert(editor, 7, 12, 's1');

    expect(findAnnotationRange(editor.state.doc, 'suggestion', 's1')).toEqual({ from: 7, to: 12 });
  });

  it('tracks the comment as the document shifts (unlike the stored from/to)', () => {
    editor = makeEditor('<p>Hello world</p>');
    editor.chain().setTextSelection({ from: 7, to: 12 }).setComment('c1').run();
    editor.chain().setTextSelection(1).insertContentAt(1, 'XX').run();

    expect(findAnnotationRange(editor.state.doc, 'comment', 'c1')).toEqual({ from: 9, to: 14 });
  });

  it('returns null for an unknown id', () => {
    editor = makeEditor('<p>Hello world</p>');
    expect(findAnnotationRange(editor.state.doc, 'comment', 'nope')).toBeNull();
  });

  it('returns the combined range of both halves when given a pairId', () => {
    editor = makeEditor('<p>Hello world</p>');
    addTracked(editor, 'tracked_delete', 1, 6, 'd1', 'p1');
    addTracked(editor, 'tracked_insert', 7, 12, 'i1', 'p1');

    expect(findAnnotationRange(editor.state.doc, 'suggestion', 'p1')).toEqual({ from: 1, to: 12 });
  });
});
