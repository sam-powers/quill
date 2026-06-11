import { describe, it, expect } from 'vitest';
import { basename, dirname } from '../../utils/path';

describe('basename', () => {
  it('returns the last segment of a POSIX path', () => {
    expect(basename('/Users/sam/docs/notes.md')).toBe('notes.md');
  });

  it('returns the last segment of a Windows path', () => {
    expect(basename('C:\\Users\\sam\\docs\\notes.md')).toBe('notes.md');
  });

  it('handles mixed separators', () => {
    expect(basename('C:\\Users\\sam/docs/notes.md')).toBe('notes.md');
  });

  it('returns a bare filename unchanged', () => {
    expect(basename('notes.md')).toBe('notes.md');
  });

  it('ignores a trailing separator', () => {
    expect(basename('/Users/sam/docs/')).toBe('docs');
    expect(basename('C:\\Users\\sam\\')).toBe('sam');
  });
});

describe('dirname', () => {
  it('returns the containing directory of a POSIX path', () => {
    expect(dirname('/Users/sam/docs/notes.md')).toBe('/Users/sam/docs');
  });

  it('returns the containing directory of a Windows path', () => {
    expect(dirname('C:\\Users\\sam\\docs\\notes.md')).toBe('C:\\Users\\sam\\docs');
  });

  it('returns the root for a file directly under it', () => {
    expect(dirname('/notes.md')).toBe('/');
  });

  it('returns null for a bare filename', () => {
    expect(dirname('notes.md')).toBeNull();
  });
});
