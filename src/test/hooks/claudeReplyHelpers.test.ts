import { describe, it, expect } from 'vitest';
import { buildPrompt, detectScope, splitVisible } from '../../hooks/useClaudeReply';
import type { Comment, Reply } from '../../types';

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

function makeComment(replies: Partial<Reply>[]): Comment {
  return {
    id: 'c1',
    anchorText: 'anchor',
    from: 1,
    to: 7,
    author: 'Sam',
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: replies.map((r, i) => ({
      id: `r${i}`,
      author: 'Sam',
      text: '',
      createdAt: new Date().toISOString(),
      ...r,
    })),
  };
}

const RANGES = { highlightText: 'anchor', paragraphText: 'anchor paragraph' };

describe('buildPrompt thread handling', () => {
  it('includes prior replies and the new message exactly once', () => {
    const comment = makeComment([
      { text: 'What does this mean?', authorKind: 'user' },
      { text: 'It refers to the intro.', authorKind: 'ai', author: 'Claude' },
    ]);
    const prompt = buildPrompt(comment, 'Can you tighten it?', 'doc', RANGES, 'highlight', null);
    expect(prompt).toContain('- Sam: What does this mean?');
    expect(prompt).toContain('- Claude: It refers to the intro.');
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(1);
    expect(prompt).toContain('- User just said: Can you tighten it?');
  });

  it('drops the trailing thread copy of the just-posted message', () => {
    // The reply state may flush before the prompt is built, so the user's new
    // message can already be the last reply — it must not be listed twice.
    const comment = makeComment([
      { text: 'Earlier question', authorKind: 'user' },
      { text: 'Can you tighten it?', authorKind: 'user' },
    ]);
    const prompt = buildPrompt(comment, 'Can you tighten it?', 'doc', RANGES, 'highlight', null);
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(1);
    expect(prompt).toContain('- Sam: Earlier question');
  });

  it('keeps an earlier identical message that is not the trailing reply', () => {
    const comment = makeComment([
      { text: 'Can you tighten it?', authorKind: 'user' },
      { text: 'Done — see the suggestion.', authorKind: 'ai', author: 'Claude' },
    ]);
    const prompt = buildPrompt(comment, 'Can you tighten it?', 'doc', RANGES, 'highlight', null);
    // Once as history, once as the new message.
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(2);
  });

  it('excludes pending (still-streaming) replies', () => {
    const comment = makeComment([
      { text: 'half-streamed ans', authorKind: 'ai', author: 'Claude', pending: true },
    ]);
    const prompt = buildPrompt(comment, 'follow-up', 'doc', RANGES, 'highlight', null);
    expect(prompt).not.toContain('half-streamed');
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
