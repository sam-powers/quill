import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRecentFiles,
  addRecentFile,
  clearRecentFiles,
  MAX_RECENT_FILES,
} from '../../utils/recentFiles';

describe('recent files list', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(getRecentFiles()).toEqual([]);
  });

  it('adds most-recent first and persists', () => {
    addRecentFile('/docs/a.md');
    addRecentFile('/docs/b.md');
    expect(getRecentFiles()).toEqual(['/docs/b.md', '/docs/a.md']);
  });

  it('re-opening an entry moves it to the front without duplicating', () => {
    addRecentFile('/docs/a.md');
    addRecentFile('/docs/b.md');
    addRecentFile('/docs/a.md');
    expect(getRecentFiles()).toEqual(['/docs/a.md', '/docs/b.md']);
  });

  it('caps the list at MAX_RECENT_FILES, dropping the oldest', () => {
    for (let i = 0; i < MAX_RECENT_FILES + 3; i++) {
      addRecentFile(`/docs/${i}.md`);
    }
    const list = getRecentFiles();
    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0]).toBe(`/docs/${MAX_RECENT_FILES + 2}.md`);
    expect(list).not.toContain('/docs/0.md');
  });

  it('clear empties the list', () => {
    addRecentFile('/docs/a.md');
    expect(clearRecentFiles()).toEqual([]);
    expect(getRecentFiles()).toEqual([]);
  });

  it('ignores corrupt or non-array stored values', () => {
    localStorage.setItem('quill-recent-files', '{not json');
    expect(getRecentFiles()).toEqual([]);
    localStorage.setItem('quill-recent-files', '"a string"');
    expect(getRecentFiles()).toEqual([]);
    localStorage.setItem('quill-recent-files', '[1, "/docs/a.md", null]');
    expect(getRecentFiles()).toEqual(['/docs/a.md']);
  });

  it('addRecentFile returns the updated list for direct menu sync', () => {
    expect(addRecentFile('/docs/a.md')).toEqual(['/docs/a.md']);
  });
});
