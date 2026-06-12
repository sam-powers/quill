import { describe, it, expect, afterEach } from 'vitest';
import { resolveImageSrc, setImageBaseDir } from '../../extensions/MarkdownImage';

type TauriWindow = Window & { __TAURI_INTERNALS__?: { convertFileSrc: (p: string) => string } };
const win = window as TauriWindow;

afterEach(() => {
  setImageBaseDir(null);
  delete win.__TAURI_INTERNALS__;
});

describe('resolveImageSrc', () => {
  it('passes scheme-prefixed URLs through untouched', () => {
    setImageBaseDir('/docs');
    expect(resolveImageSrc('https://x.com/i.png')).toBe('https://x.com/i.png');
    expect(resolveImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(resolveImageSrc('asset://localhost/x')).toBe('asset://localhost/x');
  });

  it('leaves relative paths alone when no base dir is set (unsaved doc)', () => {
    expect(resolveImageSrc('./pic.png')).toBe('./pic.png');
  });

  it('leaves relative paths alone outside Tauri', () => {
    setImageBaseDir('/Users/sam/docs');
    expect(resolveImageSrc('./pic.png')).toBe('./pic.png');
  });

  it('resolves relative paths against the base dir in Tauri', () => {
    win.__TAURI_INTERNALS__ = { convertFileSrc: (p: string) => `asset://localhost/${p}` };
    setImageBaseDir('/Users/sam/docs');
    expect(resolveImageSrc('./pic.png')).toBe('asset://localhost//Users/sam/docs/pic.png');
    expect(resolveImageSrc('images/a.jpg')).toBe('asset://localhost//Users/sam/docs/images/a.jpg');
  });
});
