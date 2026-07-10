import { describe, it, expect } from 'vitest';
import {
  sanitizeComments,
  sanitizeSuggestions,
  sanitizeAISession,
  sanitizeContextFolder,
} from '../../utils/annotationValidation';

const validComment = {
  id: 'c1',
  anchorText: 'hello',
  from: 3,
  to: 8,
  author: 'Sam',
  createdAt: '2026-01-01T00:00:00Z',
  resolved: false,
  replies: [],
};

const validSuggestion = {
  id: 's1',
  type: 'insertion',
  from: 1,
  to: 4,
  originalText: '',
  suggestedText: 'new',
  author: 'Claude',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
};

describe('sanitizeComments', () => {
  it('keeps a well-formed comment', () => {
    expect(sanitizeComments([validComment])).toEqual([validComment]);
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeComments(undefined)).toEqual([]);
    expect(sanitizeComments(null)).toEqual([]);
    expect(sanitizeComments('comments')).toEqual([]);
    expect(sanitizeComments({ 0: validComment })).toEqual([]);
  });

  it('drops records that are not objects or lack an id', () => {
    expect(sanitizeComments([null, 42, 'x', {}, { id: '' }])).toEqual([]);
  });

  it('drops comments with non-numeric or negative positions (would throw in doc.resolve)', () => {
    const bad = [
      { ...validComment, from: -1 },
      { ...validComment, to: NaN },
      { ...validComment, from: 'nope' },
      { ...validComment, to: Infinity },
      { ...validComment, from: undefined },
    ];
    expect(sanitizeComments(bad)).toEqual([]);
  });

  it('floors fractional positions and orders from <= to', () => {
    const [c] = sanitizeComments([{ ...validComment, from: 8.9, to: 3.2 }]);
    expect(c.from).toBe(3);
    expect(c.to).toBe(8);
  });

  it('coerces missing optional fields to safe defaults', () => {
    const [c] = sanitizeComments([{ id: 'c2', from: 0, to: 1 }]);
    expect(c).toMatchObject({
      id: 'c2',
      anchorText: '',
      author: '',
      createdAt: '',
      resolved: false,
      replies: [],
    });
  });

  it('drops malformed replies but keeps the comment', () => {
    const [c] = sanitizeComments([
      { ...validComment, replies: [null, { id: 'r1', text: 'hi' }, { text: 'no id' }] },
    ]);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0].id).toBe('r1');
  });

  it('keeps the good comments and drops the bad in a mixed array', () => {
    const result = sanitizeComments([validComment, { id: 'bad', from: -5, to: 2 }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });
});

describe('sanitizeSuggestions', () => {
  it('keeps a well-formed suggestion', () => {
    expect(sanitizeSuggestions([validSuggestion])).toEqual([validSuggestion]);
  });

  it('drops suggestions with an unknown type', () => {
    expect(sanitizeSuggestions([{ ...validSuggestion, type: 'replacement' }])).toEqual([]);
  });

  it('drops suggestions with bad positions', () => {
    expect(sanitizeSuggestions([{ ...validSuggestion, from: -2 }])).toEqual([]);
  });

  it('defaults an unknown status to pending', () => {
    const [s] = sanitizeSuggestions([{ ...validSuggestion, status: 'weird' }]);
    expect(s.status).toBe('pending');
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeSuggestions(null)).toEqual([]);
  });
});

describe('sanitizeAISession', () => {
  const valid = {
    provider: 'claude-code',
    sessionId: 'abc',
    cwd: '/home/me/project',
    linkedAt: '2026-01-01T00:00:00Z',
  };

  it('keeps a complete binding', () => {
    expect(sanitizeAISession(valid)).toEqual(valid);
  });

  it('drops a legacy createdByQuill flag, loading it as a plain binding', () => {
    // Old sidecars minted a session via Quill and stamped createdByQuill.
    // That path is gone; the field is ignored and the binding resumes normally.
    const sanitized = sanitizeAISession({ ...valid, createdByQuill: true });
    expect(sanitized).toEqual(valid);
    expect(sanitized).not.toHaveProperty('createdByQuill');
  });

  it('rejects a binding with the wrong provider', () => {
    expect(sanitizeAISession({ ...valid, provider: 'openai' })).toBeUndefined();
  });

  it('rejects a partial binding (all-or-nothing)', () => {
    expect(sanitizeAISession({ ...valid, sessionId: '' })).toBeUndefined();
    expect(sanitizeAISession({ ...valid, cwd: 42 })).toBeUndefined();
    expect(sanitizeAISession({})).toBeUndefined();
    expect(sanitizeAISession(null)).toBeUndefined();
  });
});

describe('sanitizeContextFolder', () => {
  it('keeps a non-empty string', () => {
    expect(sanitizeContextFolder('/refs')).toBe('/refs');
  });

  it('rejects empty strings and non-strings', () => {
    expect(sanitizeContextFolder('')).toBeUndefined();
    expect(sanitizeContextFolder(123)).toBeUndefined();
    expect(sanitizeContextFolder(null)).toBeUndefined();
  });
});
