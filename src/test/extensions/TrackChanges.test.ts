import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { closeHistory } from '@tiptap/pm/history';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  getTrackedChanges,
} from '../../extensions/TrackChanges';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackChanges],
    content,
  });
}

function hasMarkOfType(editor: Editor, markName: string): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.marks.some((m) => m.type.name === markName)) {
      found = true;
    }
  });
  return found;
}

function getMarkAttrs(editor: Editor, markName: string): Record<string, unknown>[] {
  const attrs: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    node.marks.filter((m) => m.type.name === markName).forEach((m) => attrs.push(m.attrs));
  });
  return attrs;
}

function getTextContent(editor: Editor): string {
  return editor.state.doc.textContent;
}

describe('TrackChanges extension', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  describe('tracking disabled (default)', () => {
    beforeEach(() => {
      editor = makeEditor('<p>Hello world</p>');
    });

    it('inserting text creates no tracked_insert mark', () => {
      // Position 7 = after the space in "Hello world", giving "Hello beautiful world"
      editor.commands.insertContentAt(7, 'beautiful ');
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(getTextContent(editor)).toBe('Hello beautiful world');
    });

    it('deleting text creates no tracked_delete mark', () => {
      // Delete "Hello"
      editor.commands.deleteRange({ from: 1, to: 6 });
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe(' world');
    });
  });

  describe('tracking enabled', () => {
    beforeEach(() => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('alice');
    });

    it('inserting text wraps the new text in a tracked_insert mark', () => {
      editor.commands.insertContentAt(7, 'beautiful ');
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(true);
      const attrs = getMarkAttrs(editor, 'tracked_insert');
      expect(attrs[0].dataTracked).toMatchObject({
        authorID: 'alice',
        status: 'pending',
        operation: 'insert',
      });
    });

    it('deleting text wraps the deleted text in a tracked_delete mark (text stays in doc)', () => {
      // Delete "Hello" (positions 1–6)
      editor.commands.deleteRange({ from: 1, to: 6 });
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(true);
      // Text should still be present in the document
      expect(getTextContent(editor)).toContain('Hello');
    });

    it('replacing text produces both a tracked_insert and tracked_delete mark', () => {
      // Replace "Hello" with "Hi" using the chain API
      editor.chain().setTextSelection({ from: 1, to: 6 }).insertContent('Hi').run();
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(true);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(true);
    });

    it('bold formatting is NOT tracked (only ReplaceSteps are intercepted)', () => {
      editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
      // Bold should be applied
      const hasBold = (() => {
        let found = false;
        editor.state.doc.descendants((node) => {
          if (node.marks.some((m) => m.type.name === 'bold')) found = true;
        });
        return found;
      })();
      expect(hasBold).toBe(true);
      // But no track marks should exist for formatting changes
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
    });
  });

  describe('acceptChange', () => {
    it('accepting an insertion removes the tracked_insert mark, leaving plain text', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('alice');
      editor.commands.insertContentAt(7, 'beautiful ');

      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      const id = changes[0].id;

      editor.commands.acceptChange(id);
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(getTextContent(editor)).toContain('beautiful');
    });

    it('accepting a deletion physically removes the marked text from the document', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.deleteRange({ from: 1, to: 6 });

      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      const id = changes[0].id;

      editor.commands.acceptChange(id);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).not.toContain('Hello');
    });
  });

  describe('rejectChange', () => {
    it('rejecting an insertion removes the inserted text from the document', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.insertContentAt(7, 'beautiful ');

      const changes = getTrackedChanges(editor);
      const id = changes[0].id;

      editor.commands.rejectChange(id);
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(getTextContent(editor)).not.toContain('beautiful');
    });

    it('rejecting a deletion removes the tracked_delete mark, restoring the text as plain', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.deleteRange({ from: 1, to: 6 });

      const changes = getTrackedChanges(editor);
      const id = changes[0].id;

      editor.commands.rejectChange(id);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      // Text still present and no longer marked
      expect(getTextContent(editor)).toContain('Hello');
    });
  });

  describe('acceptAllChanges', () => {
    it('removes all pending insert marks and deletes all pending deleted text', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.insertContentAt(7, 'beautiful ');
      editor.commands.deleteRange({ from: 1, to: 6 });

      editor.commands.acceptAllChanges();
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
    });
  });

  describe('rejectAllChanges', () => {
    it('removes all inserted text and all delete marks', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.insertContentAt(7, 'beautiful ');
      editor.commands.deleteRange({ from: 1, to: 6 });

      editor.commands.rejectAllChanges();
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
    });
  });

  describe('replacement pairing', () => {
    beforeEach(() => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('alice');
    });

    function replaceHelloWithHi() {
      // One ReplaceStep that both deletes and inserts — typing over a selection.
      editor.chain().setTextSelection({ from: 1, to: 6 }).insertContent('Hi').run();
    }

    it('replacing text gives both halves a shared pairId', () => {
      replaceHelloWithHi();
      const changes = getTrackedChanges(editor);
      const del = changes.find((c) => c.operation === 'delete');
      const ins = changes.find((c) => c.operation === 'insert');
      expect(del?.pairId).toBeTruthy();
      expect(del?.pairId).toBe(ins?.pairId);
    });

    it('a pure insertion has no pairId', () => {
      editor.commands.insertContentAt(7, 'beautiful ');
      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0].pairId).toBeUndefined();
    });

    it('a pure deletion has no pairId', () => {
      editor.commands.deleteRange({ from: 1, to: 6 });
      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0].pairId).toBeUndefined();
    });

    it('continued typing after a replacement extends the same pair', () => {
      replaceHelloWithHi();
      const pairId = getTrackedChanges(editor).find((c) => c.operation === 'insert')?.pairId;
      // The caret sits at the end of "Hi" (position 3); keep typing there.
      editor.commands.insertContentAt(3, '!');

      const inserts = getTrackedChanges(editor).filter((c) => c.operation === 'insert');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].text).toBe('Hi!');
      expect(inserts[0].pairId).toBe(pairId);
    });

    it('acceptChange(pairId) resolves both halves: old text removed, new text kept', () => {
      replaceHelloWithHi();
      const pairId = getTrackedChanges(editor)[0].pairId!;

      editor.commands.acceptChange(pairId);
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe('Hi world');
    });

    it('rejectChange(pairId) resolves both halves: old text restored, new text removed', () => {
      replaceHelloWithHi();
      const pairId = getTrackedChanges(editor)[0].pairId!;

      editor.commands.rejectChange(pairId);
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe('Hello world');
    });

    it('resolving by pairId is a single undo step', () => {
      replaceHelloWithHi();
      const pairId = getTrackedChanges(editor)[0].pairId!;

      // Close the history group so undo targets the accept alone — without
      // this, the accept merges into the replacement's group (newGroupDelay).
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.acceptChange(pairId);
      editor.commands.undo();
      // One undo restores BOTH halves — they were resolved in one transaction.
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(true);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(true);
    });
  });

  describe('getTrackedChanges', () => {
    it('returns an empty array when no changes exist', () => {
      editor = makeEditor('<p>Hello world</p>');
      expect(getTrackedChanges(editor)).toEqual([]);
    });

    it('returns a TrackedChangeInfo for each tracked change', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('bob');
      editor.commands.insertContentAt(7, 'beautiful ');

      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        operation: 'insert',
        authorID: 'bob',
        status: 'pending',
        text: 'beautiful ',
      });
      expect(changes[0].id).toBeTruthy();
    });
  });
});
