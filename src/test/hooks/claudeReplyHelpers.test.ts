import { describe, it, expect } from 'vitest';
import { detectScope, splitVisible } from '../../hooks/useClaudeReply';

describe('detectScope', () => {
  it('defaults to highlight', () => {
    expect(detectScope('fix the grammar here')).toBe('highlight');
    expect(detectScope('rewrite this')).toBe('highlight');
  });

  it('widens to paragraph on explicit paragraph wording', () => {
    expect(detectScope('clean up the whole paragraph')).toBe('paragraph');
    expect(detectScope('rewrite this paragraph please')).toBe('paragraph');
  });

  it('widens to doc on explicit document wording', () => {
    expect(detectScope('restructure the whole doc')).toBe('doc');
    expect(detectScope('fix tone across the entire document')).toBe('doc');
  });

  it('prefers doc over paragraph when both appear', () => {
    expect(detectScope('the whole document, especially this paragraph')).toBe('doc');
  });
});

describe('splitVisible', () => {
  it('returns all text as visible when no fence', () => {
    const { visible, block } = splitVisible('Just a normal reply.');
    expect(visible).toBe('Just a normal reply.');
    expect(block).toBeNull();
  });

  it('strips a complete quill-edits block from visible text', () => {
    const raw = 'I tightened the grammar.\n\n```quill-edits\n{"summary":"x","edits":[]}\n```';
    const { visible, block } = splitVisible(raw);
    expect(visible).toBe('I tightened the grammar.');
    expect(block).toBe('{"summary":"x","edits":[]}');
  });

  it('treats an unterminated block as no block (closing fence not yet arrived)', () => {
    const raw = 'prose\n```quill-edits\n{"summary":"x"';
    const { visible, block } = splitVisible(raw);
    expect(visible).toBe('prose');
    expect(block).toBeNull();
  });

  it('never includes JSON in visible output even with surrounding prose', () => {
    const raw =
      'Here is the change. ```quill-edits\n{"summary":"s","edits":[{"find":"a","replace":"b"}]}\n```';
    const { visible } = splitVisible(raw);
    expect(visible).not.toContain('quill-edits');
    expect(visible).not.toContain('"find"');
  });
});
