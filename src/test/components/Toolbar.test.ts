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

  it('passes through tel: links', () => {
    expect(normalizeHref('tel:+15551234567')).toBe('tel:+15551234567');
  });

  it('rejects dangerous schemes by returning empty', () => {
    // These would be persisted into the saved .md and later clickable.
    expect(normalizeHref('javascript:alert(1)')).toBe('');
    expect(normalizeHref('JavaScript:alert(1)')).toBe('');
    expect(normalizeHref('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(normalizeHref('vbscript:msgbox(1)')).toBe('');
    expect(normalizeHref('file:///etc/passwd')).toBe('');
  });
});
