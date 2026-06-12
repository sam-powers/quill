import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, afterEach } from 'vitest';
import { Find, findMatches, getFindState } from '../../extensions/Find';
import { TrackChanges, TrackedInsert, TrackedDelete } from '../../extensions/TrackChanges';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, Find, TrackedInsert, TrackedDelete, TrackChanges],
    content,
  });
}

function matchTexts(editor: Editor): string[] {
  return getFindState(editor.state).matches.map((m) => editor.state.doc.textBetween(m.from, m.to));
}

function decoratedTexts(editor: Editor): string[] {
  return Array.from(editor.view.dom.querySelectorAll('.find-match')).map(
    (el) => el.textContent ?? '',
  );
}

function activeDecoratedText(editor: Editor): string {
  return Array.from(editor.view.dom.querySelectorAll('.find-match-active'))
    .map((el) => el.textContent)
    .join('');
}

describe('findMatches', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('finds every occurrence with correct positions', () => {
    editor = makeEditor('<p>cat scat cat</p>');
    const matches = findMatches(editor.state.doc, 'cat');
    expect(matches).toEqual([
      { from: 1, to: 4 },
      { from: 6, to: 9 },
      { from: 10, to: 13 },
    ]);
  });

  it('is case-insensitive', () => {
    editor = makeEditor('<p>Cat CAT cat</p>');
    expect(findMatches(editor.state.doc, 'cAt')).toHaveLength(3);
  });

  it('returns no matches for an empty query', () => {
    editor = makeEditor('<p>anything</p>');
    expect(findMatches(editor.state.doc, '')).toEqual([]);
  });

  it('matches across mark boundaries (bold splits text nodes)', () => {
    editor = makeEditor('<p>He<strong>llo wo</strong>rld</p>');
    const matches = findMatches(editor.state.doc, 'hello world');
    expect(matches).toEqual([{ from: 1, to: 12 }]);
  });

  it('does not match across block boundaries', () => {
    editor = makeEditor('<p>Hello</p><p>world</p>');
    expect(findMatches(editor.state.doc, 'hello world')).toEqual([]);
  });

  it('returns non-overlapping matches', () => {
    editor = makeEditor('<p>aaaa</p>');
    expect(findMatches(editor.state.doc, 'aa')).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ]);
  });

  it('skips text struck out by a pending tracked deletion', () => {
    editor = makeEditor('<p>cat and cat</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('alice');
    // Delete the first "cat" in suggesting mode: it stays in the doc but
    // carries a tracked_delete mark, and search must not find it.
    editor.commands.deleteRange({ from: 1, to: 4 });
    expect(editor.state.doc.textContent).toBe('cat and cat');

    const matches = findMatches(editor.state.doc, 'cat');
    expect(matches).toHaveLength(1);
    expect(editor.state.doc.textBetween(matches[0].from, matches[0].to)).toBe('cat');
    expect(matches[0].from).toBeGreaterThan(4);
  });

  it('does not match across a pending tracked deletion', () => {
    editor = makeEditor('<p>scatter</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('alice');
    // Strike "att" out of "scatter": the visible text is "scer", but the
    // halves must not be glued together into a match.
    editor.commands.deleteRange({ from: 3, to: 6 });
    expect(findMatches(editor.state.doc, 'scer')).toEqual([]);
  });
});

describe('Find extension', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('setFindQuery computes matches and renders decorations', () => {
    editor = makeEditor('<p>cat and cat</p>');
    editor.commands.setFindQuery('cat');

    const state = getFindState(editor.state);
    expect(state.query).toBe('cat');
    expect(state.matches).toHaveLength(2);
    expect(decoratedTexts(editor)).toEqual(['cat', 'cat']);
  });

  it('never modifies the document', () => {
    editor = makeEditor('<p>cat and cat</p>');
    const htmlBefore = editor.getHTML();
    editor.commands.setFindQuery('cat');
    editor.commands.setActiveFindMatch(1);
    editor.commands.clearFind();

    expect(editor.getHTML()).toBe(htmlBefore);
  });

  it('starts at the first match at or after the cursor', () => {
    editor = makeEditor('<p>cat and cat and cat</p>');
    editor.commands.setTextSelection(6); // past the first "cat"
    editor.commands.setFindQuery('cat');

    expect(getFindState(editor.state).activeIndex).toBe(1);
    expect(activeDecoratedText(editor)).toBe('cat');
  });

  it('wraps to the first match when the cursor is past every match', () => {
    editor = makeEditor('<p>cat and dog</p>');
    editor.commands.setTextSelection(10);
    editor.commands.setFindQuery('cat');

    expect(getFindState(editor.state).activeIndex).toBe(0);
  });

  it('setActiveFindMatch moves the active highlight', () => {
    editor = makeEditor('<p>cat one cat two</p>');
    editor.commands.setTextSelection(1);
    editor.commands.setFindQuery('cat');
    editor.commands.setActiveFindMatch(1);

    expect(getFindState(editor.state).activeIndex).toBe(1);
    expect(editor.view.dom.querySelectorAll('.find-match-active')).toHaveLength(1);
  });

  it('setActiveFindMatchAfter activates the first match past a position', () => {
    editor = makeEditor('<p>cat one cat two cat</p>');
    editor.commands.setFindQuery('cat');
    const second = getFindState(editor.state).matches[1];
    editor.commands.setActiveFindMatchAfter(second.from);

    expect(getFindState(editor.state).activeIndex).toBe(1);
  });

  it('clearFind removes matches and decorations', () => {
    editor = makeEditor('<p>cat and cat</p>');
    editor.commands.setFindQuery('cat');
    editor.commands.clearFind();

    expect(getFindState(editor.state)).toEqual({ query: '', matches: [], activeIndex: 0 });
    expect(decoratedTexts(editor)).toEqual([]);
  });

  it('recomputes matches when the document changes', () => {
    editor = makeEditor('<p>cat</p>');
    editor.commands.setFindQuery('cat');
    expect(getFindState(editor.state).matches).toHaveLength(1);

    editor.commands.insertContentAt(4, ' cat');
    expect(matchTexts(editor)).toEqual(['cat', 'cat']);
  });

  it('clamps the active index when matches disappear', () => {
    editor = makeEditor('<p>cat one cat</p>');
    editor.commands.setFindQuery('cat');
    editor.commands.setActiveFindMatch(1);
    editor.commands.deleteRange({ from: 9, to: 12 }); // remove the second "cat"

    const state = getFindState(editor.state);
    expect(state.matches).toHaveLength(1);
    expect(state.activeIndex).toBe(0);
  });

  it('replacing in suggesting mode leaves the struck original unmatched', () => {
    editor = makeEditor('<p>cat and cat</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('alice');
    editor.commands.setFindQuery('cat');

    const match = getFindState(editor.state).matches[0];
    editor.chain().setTextSelection(match).insertContent('dog').run();

    // The insert lands first, then the original "cat" survives after it as a
    // pending deletion excluded from search; only the untouched second "cat"
    // remains a match.
    expect(editor.state.doc.textContent).toBe('dogcat and cat');
    expect(matchTexts(editor)).toEqual(['cat']);
  });
});
