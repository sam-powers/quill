import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  classifyReplyError,
  detectScope,
  splitVisible,
} from '../../hooks/useClaudeReply';
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
    const prompt = buildPrompt(
      comment,
      'Can you tighten it?',
      'doc',
      RANGES,
      'highlight',
      null,
      null,
    );
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
    const prompt = buildPrompt(
      comment,
      'Can you tighten it?',
      'doc',
      RANGES,
      'highlight',
      null,
      null,
    );
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(1);
    expect(prompt).toContain('- Sam: Earlier question');
  });

  it('keeps an earlier identical message that is not the trailing reply', () => {
    const comment = makeComment([
      { text: 'Can you tighten it?', authorKind: 'user' },
      { text: 'Done — see the suggestion.', authorKind: 'ai', author: 'Claude' },
    ]);
    const prompt = buildPrompt(
      comment,
      'Can you tighten it?',
      'doc',
      RANGES,
      'highlight',
      null,
      null,
    );
    // Once as history, once as the new message.
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(2);
  });

  it('excludes pending (still-streaming) replies', () => {
    const comment = makeComment([
      { text: 'half-streamed ans', authorKind: 'ai', author: 'Claude', pending: true },
    ]);
    const prompt = buildPrompt(comment, 'follow-up', 'doc', RANGES, 'highlight', null, null);
    expect(prompt).not.toContain('half-streamed');
  });
});

describe('buildPrompt fresh session', () => {
  it('claims prior authorship by default', () => {
    const prompt = buildPrompt(makeComment([]), 'question', 'doc', RANGES, 'highlight', null, null);
    expect(prompt).toContain('you previously authored');
  });

  it('never claims authorship for a Quill-created session and sends the full doc plainly', () => {
    const prompt = buildPrompt(
      makeComment([]),
      'question',
      'doc body',
      RANGES,
      'highlight',
      null,
      null,
      true,
    );
    expect(prompt).not.toContain('previously authored');
    expect(prompt).not.toContain('since you wrote');
    expect(prompt).toContain('the user is editing in Quill');
    expect(prompt).toContain('Here is the full current document:');
    expect(prompt).toContain('doc body');
  });
});

describe('buildPrompt context folder', () => {
  it('lists the folder and its file manifest when a context is provided', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(comment, 'check my facts', 'doc', RANGES, 'highlight', null, {
      folder: '/refs/research',
      files: ['sources.md', 'notes/interview.txt'],
    });
    expect(prompt).toContain('=== REFERENCE FOLDER ===');
    expect(prompt).toContain('/refs/research');
    expect(prompt).toContain('- sources.md');
    expect(prompt).toContain('- notes/interview.txt');
  });

  it('notes an empty folder instead of listing nothing', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(comment, 'check my facts', 'doc', RANGES, 'highlight', null, {
      folder: '/refs/empty',
      files: [],
    });
    expect(prompt).toContain('(no readable documents found in the folder)');
  });

  it('omits the section entirely without a context', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(comment, 'check my facts', 'doc', RANGES, 'highlight', null, null);
    expect(prompt).not.toContain('REFERENCE FOLDER');
  });

  it('includes the section in the compaction-diff prompt branch too', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(
      comment,
      'check my facts',
      'doc v2',
      RANGES,
      'highlight',
      { compacted: false, originalMarkdown: 'doc v1' },
      { folder: '/refs/research', files: ['sources.md'] },
    );
    expect(prompt).toContain('=== REFERENCE FOLDER ===');
    expect(prompt).toContain('- sources.md');
  });
});

describe('classifyReplyError', () => {
  it('classifies session-loss errors as session (retryable, re-link primary)', () => {
    expect(classifyReplyError('No conversation found for this session')).toEqual({
      retryable: true,
      kind: 'session',
    });
    expect(classifyReplyError('Invalid session ID')).toEqual({ retryable: true, kind: 'session' });
    expect(classifyReplyError('session not found')).toEqual({ retryable: true, kind: 'session' });
  });

  it('classifies auth errors as auth and not retryable', () => {
    for (const msg of [
      'Authentication failed',
      'Unauthorized',
      'HTTP 401',
      'Please login again',
      'Invalid API key',
      'missing credentials',
    ]) {
      expect(classifyReplyError(msg)).toEqual({ retryable: false, kind: 'auth' });
    }
  });

  it('classifies transient/API errors as transient (retryable)', () => {
    for (const msg of [
      'API Error: something went wrong',
      'HTTP 429 Too Many Requests',
      'status 503',
      'Overloaded',
      'request timeout',
      'network unreachable',
      'rate limit exceeded',
      'ECONNRESET',
      'Unsupported parameter: thinking.type',
    ]) {
      expect(classifyReplyError(msg)).toEqual({ retryable: true, kind: 'transient' });
    }
  });

  it('matches case-insensitively', () => {
    expect(classifyReplyError('NO CONVERSATION FOUND').kind).toBe('session');
    expect(classifyReplyError('OVERLOADED').kind).toBe('transient');
    expect(classifyReplyError('UNAUTHORIZED').kind).toBe('auth');
  });

  it('orders session before transient when both could match', () => {
    // A session-loss message that also mentions a timeout must lead with re-link.
    expect(classifyReplyError('No conversation found (timeout)').kind).toBe('session');
  });

  it('does not false-match ordinary words (negative control)', () => {
    // "author" contains "auth" but must NOT classify as auth; a plain sentence
    // with no error markers is unknown.
    expect(classifyReplyError('The author revised the document.')).toEqual({
      retryable: true,
      kind: 'unknown',
    });
  });

  it('anchors the 401 and login auth markers to word boundaries', () => {
    // A port/line number that merely contains the digits "401", or a hostname
    // that contains "login" as a substring, must not force a non-retryable auth
    // verdict onto an otherwise-retryable transient failure.
    expect(classifyReplyError('connection refused on port 24010')).toEqual({
      retryable: true,
      kind: 'unknown',
    });
    expect(classifyReplyError('timeout reaching mylogin.internal host')).toEqual({
      retryable: true,
      kind: 'transient',
    });
    // The real markers still classify as auth.
    expect(classifyReplyError('server returned 401').kind).toBe('auth');
    expect(classifyReplyError('please login again').kind).toBe('auth');
  });

  it('treats empty and whitespace input as unknown without throwing', () => {
    expect(classifyReplyError('')).toEqual({ retryable: true, kind: 'unknown' });
    expect(classifyReplyError('   ')).toEqual({ retryable: true, kind: 'unknown' });
    // @ts-expect-error — guarding the runtime nullish path
    expect(classifyReplyError(undefined)).toEqual({ retryable: true, kind: 'unknown' });
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
