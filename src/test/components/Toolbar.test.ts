import { describe, it, expect } from 'vitest';
import { normalizeHref } from '../../components/Toolbar';

describe('normalizeHref', () => {
  it('passes through URLs with an explicit scheme', () => {
    expect(normalizeHref('https://example.com')).toBe('https://example.com');
    expect(normalizeHref('http://example.com/a?b=c')).toBe('http://example.com/a?b=c');
    expect(normalizeHref('mailto:sam@example.com')).toBe('mailto:sam@example.com');
  });

  it('passes through in-page and relative references', () => {
    expect(normalizeHref('#section')).toBe('#section');
    expect(normalizeHref('/docs/guide.md')).toBe('/docs/guide.md');
    expect(normalizeHref('./sibling.md')).toBe('./sibling.md');
  });

  it('prefixes bare domains with https://', () => {
    expect(normalizeHref('example.com')).toBe('https://example.com');
    expect(normalizeHref('sub.example.com/path')).toBe('https://sub.example.com/path');
  });

  it('trims whitespace and keeps empty input empty', () => {
    expect(normalizeHref('  example.com  ')).toBe('https://example.com');
    expect(normalizeHref('')).toBe('');
    expect(normalizeHref('   ')).toBe('');
  });
});
