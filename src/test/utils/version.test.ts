import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../../utils/version';

describe('isNewerVersion', () => {
  it('detects a newer patch, minor, and major version', () => {
    expect(isNewerVersion('0.3.1', '0.3.0')).toBe(true);
    expect(isNewerVersion('0.4.0', '0.3.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });

  it('returns false for the same or an older version', () => {
    expect(isNewerVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.2.9', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.3.0', '1.0.0')).toBe(false);
  });

  it('accepts a leading "v" on either side (GitHub tag style)', () => {
    expect(isNewerVersion('v0.4.0', '0.3.0')).toBe(true);
    expect(isNewerVersion('v0.3.0', 'v0.3.0')).toBe(false);
  });

  it('treats missing segments as zero', () => {
    expect(isNewerVersion('0.4', '0.3.9')).toBe(true);
    expect(isNewerVersion('0.3', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.3.1', '0.3')).toBe(true);
  });

  it('compares numerically, not lexicographically', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
  });

  it('returns false for unparseable input', () => {
    expect(isNewerVersion('latest', '0.3.0')).toBe(false);
    expect(isNewerVersion('', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.4.0', 'unknown')).toBe(false);
  });
});
