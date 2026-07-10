import { describe, it, expect } from 'vitest';
import {
  COMMENTS_FENCE,
  EDITS_FENCE,
  buildReviewPrompt,
  extractFencedBlock,
  fenceHoldback,
  reviewVisible,
} from '../../hooks/useDocumentReview';
import type { ReviewOptions } from '../../hooks/useDocumentReview';

const BOTH: ReviewOptions = { guidance: 'tighten it', makeComments: true, makeSuggestions: true };

describe('extractFencedBlock', () => {
  it('returns the body of a complete block', () => {
    const raw = 'prose\n```quill-comments\n{"comments":[]}\n```\nmore';
    expect(extractFencedBlock(raw, COMMENTS_FENCE)).toBe('{"comments":[]}');
  });

  it('returns null when the fence is absent or unterminated', () => {
    expect(extractFencedBlock('plain prose', COMMENTS_FENCE)).toBeNull();
    expect(extractFencedBlock('x\n```quill-comments\n{"comments"', COMMENTS_FENCE)).toBeNull();
  });

  it('extracts each block independently when both are present', () => {
    const raw = [
      'Overall solid.',
      '```quill-comments',
      '{"comments":[{"find":"a","comment":"b"}]}',
      '```',
      '```quill-edits',
      '{"summary":"s","edits":[{"find":"c","replace":"d"}]}',
      '```',
    ].join('\n');
    expect(extractFencedBlock(raw, COMMENTS_FENCE)).toBe(
      '{"comments":[{"find":"a","comment":"b"}]}',
    );
    expect(extractFencedBlock(raw, EDITS_FENCE)).toBe(
      '{"summary":"s","edits":[{"find":"c","replace":"d"}]}',
    );
  });
});

describe('reviewVisible', () => {
  it('passes fence-free prose through unchanged', () => {
    expect(reviewVisible('A clear, well-paced draft.')).toBe('A clear, well-paced draft.');
  });

  it('cuts at the first fence, whichever kind comes first', () => {
    expect(reviewVisible('assessment\n```quill-edits\n{}')).toBe('assessment');
    expect(reviewVisible('assessment\n```quill-comments\n{}')).toBe('assessment');
    expect(reviewVisible('assessment\n```quill-comments\nx\n```\n```quill-edits\ny\n```')).toBe(
      'assessment',
    );
  });
});

describe('fenceHoldback', () => {
  it('holds back nothing for ordinary prose', () => {
    expect(fenceHoldback('The intro works well.')).toBe(0);
  });

  it('holds back a partial fence prefix at the end of the stream', () => {
    expect(fenceHoldback('prose\n``')).toBe(2);
    expect(fenceHoldback('prose\n```quill-co')).toBe('```quill-co'.length);
    expect(fenceHoldback('prose\n```quill-ed')).toBe('```quill-ed'.length);
  });

  it('does not hold back text that merely contains backticks mid-stream', () => {
    expect(fenceHoldback('use `code` style')).toBe(0);
  });
});

describe('buildReviewPrompt', () => {
  it('includes the guidance verbatim and the document', () => {
    const prompt = buildReviewPrompt(BOTH, 'doc body here', null);
    expect(prompt).toContain('User guidance for this review: tighten it');
    expect(prompt).toContain('doc body here');
    expect(prompt).toContain('review of the FULL document');
  });

  it('falls back to a generic review when guidance is blank', () => {
    const prompt = buildReviewPrompt({ ...BOTH, guidance: '  ' }, 'doc', null);
    expect(prompt).toContain('No specific guidance was given');
  });

  it('describes both blocks when both outputs are requested', () => {
    const prompt = buildReviewPrompt(BOTH, 'doc', null);
    expect(prompt).toContain('```quill-comments');
    expect(prompt).toContain('```quill-edits');
  });

  it('forbids edits in comments-only mode', () => {
    const prompt = buildReviewPrompt({ ...BOTH, makeSuggestions: false }, 'doc', null);
    expect(prompt).toContain('```quill-comments');
    expect(prompt).not.toContain('```quill-edits');
    expect(prompt).toContain('the user asked for comments only');
  });

  it('forbids comments in suggestions-only mode', () => {
    const prompt = buildReviewPrompt({ ...BOTH, makeComments: false }, 'doc', null);
    expect(prompt).toContain('```quill-edits');
    expect(prompt).not.toContain('```quill-comments');
    expect(prompt).toContain('tracked-change suggestions only');
  });

  it('frames the doc as one Claude previously authored', () => {
    const prompt = buildReviewPrompt(BOTH, 'doc', null);
    expect(prompt).toContain('previously authored');
  });

  it('lists the reference folder manifest when a context is provided', () => {
    const prompt = buildReviewPrompt(BOTH, 'doc', {
      folder: '/refs/research',
      files: ['sources.md'],
    });
    expect(prompt).toContain('=== REFERENCE FOLDER ===');
    expect(prompt).toContain('/refs/research');
    expect(prompt).toContain('- sources.md');
  });

  it('omits the reference section without a context', () => {
    expect(buildReviewPrompt(BOTH, 'doc', null)).not.toContain('REFERENCE FOLDER');
  });
});
