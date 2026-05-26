import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import {
  locateEdit,
  mapRangeTextOffsetToPos,
  planEdits,
  rangeText,
  resolveScopeRange,
} from '../../utils/trackedEdits';

function makeEditor(content: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackChanges],
    content,
  });
}

describe('trackedEdits helpers', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = '';
  });

  describe('rangeText + mapRangeTextOffsetToPos across a bullet list', () => {
    it('reads list items as newline-separated plaintext and maps offsets back', () => {
      editor = makeEditor('<ul><li>buy milk</li><li>buy eggs</li></ul>');
      const doc = editor.state.doc;
      const text = rangeText(doc, 0, doc.content.size);
      // No markdown bullets; items separated by newline(s).
      expect(text).toContain('buy milk');
      expect(text).toContain('buy eggs');
      expect(text).not.toContain('- ');

      // Mapping the offset of "buy eggs" (in the second list item, after a
      // newline separator) back to a doc position should let us re-select
      // exactly that text via locateEdit's round-trip.
      const idx = text.indexOf('buy eggs');
      const pos = mapRangeTextOffsetToPos(doc, 0, doc.content.size, idx);
      expect(pos).not.toBeNull();

      const at = locateEdit(doc, 0, doc.content.size, 'buy eggs');
      expect(at).not.toBeNull();
      expect(at!.from).toBe(pos);
      expect(doc.textBetween(at!.from, at!.to, '\n', ' ')).toBe('buy eggs');
    });
  });

  describe('locateEdit', () => {
    it('finds a substring within a paragraph and returns positions that select it', () => {
      editor = makeEditor('<p>the cat are happy</p>');
      const doc = editor.state.doc;
      const at = locateEdit(doc, 0, doc.content.size, 'cat are');
      expect(at).not.toBeNull();
      expect(doc.textBetween(at!.from, at!.to)).toBe('cat are');
    });

    it('returns null when the text is absent', () => {
      editor = makeEditor('<p>hello world</p>');
      const doc = editor.state.doc;
      expect(locateEdit(doc, 0, doc.content.size, 'goodbye')).toBeNull();
    });
  });

  describe('resolveScopeRange', () => {
    it('returns comment bounds for highlight scope', () => {
      editor = makeEditor('<p>hello world</p>');
      const r = resolveScopeRange(editor.state.doc, { from: 1, to: 6 }, 'highlight');
      expect(r).toEqual({ from: 1, to: 6 });
    });

    it('expands to the enclosing paragraph for paragraph scope', () => {
      editor = makeEditor('<p>hello world</p>');
      const doc = editor.state.doc;
      const r = resolveScopeRange(doc, { from: 3, to: 5 }, 'paragraph');
      expect(r.from).toBe(1);
      expect(r.to).toBe(doc.content.size - 1);
    });

    it('covers the whole doc for doc scope', () => {
      editor = makeEditor('<p>a</p><p>b</p>');
      const doc = editor.state.doc;
      const r = resolveScopeRange(doc, { from: 1, to: 2 }, 'doc');
      expect(r).toEqual({ from: 0, to: doc.content.size });
    });
  });

  describe('planEdits', () => {
    it('places located edits back-to-front and counts skips', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha', replace: 'A' },
        { find: 'gamma', replace: 'G' },
        { find: 'missing', replace: 'X' },
      ]);
      expect(skipped).toBe(1);
      expect(placed).toHaveLength(2);
      // Back-to-front: gamma (later) comes first.
      expect(placed[0].from).toBeGreaterThan(placed[1].from);
      expect(placed[0].replace).toBe('G');
    });
  });

  describe('applying planned edits as tracked changes', () => {
    it('produces tracked delete+insert with the claude author and restores mode', () => {
      editor = makeEditor('<p>the cat are happy</p>');
      const doc = editor.state.doc;
      const { placed } = planEdits(doc, 0, doc.content.size, [
        { find: 'cat are', replace: 'cats are' },
      ]);

      // Simulate what App.applyTrackedEdits does.
      const storage = editor.storage as unknown as Record<
        string,
        { enabled: boolean; authorID: string }
      >;
      const priorEnabled = storage['trackChanges'].enabled;
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('claude');
      for (const e of placed) {
        editor.chain().setTextSelection({ from: e.from, to: e.to }).insertContent(e.replace).run();
      }
      editor.commands.setTrackChangesEnabled(priorEnabled);

      const changes = getTrackedChanges(editor);
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((c) => c.authorID === 'claude')).toBe(true);
      const ops = new Set(changes.map((c) => c.operation));
      expect(ops.has('delete')).toBe(true);
      expect(ops.has('insert')).toBe(true);

      // Mode restored to its prior (disabled) value.
      expect(storage['trackChanges'].enabled).toBe(priorEnabled);
    });
  });
});
