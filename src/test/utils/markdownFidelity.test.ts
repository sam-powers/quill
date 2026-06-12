import { describe, it, expect } from 'vitest';
import { detectLossyConstructs } from '../../utils/markdownFidelity';

describe('detectLossyConstructs', () => {
  it('returns empty for plain Markdown', () => {
    expect(
      detectLossyConstructs('# Title\n\nSome **bold** text and a [link](https://x.com).'),
    ).toEqual([]);
  });

  it('returns empty for constructs the editor supports', () => {
    const md = [
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '- [ ] todo',
      '- [x] done',
      '',
      '![alt](./pic.png)',
    ].join('\n');
    expect(detectLossyConstructs(md)).toEqual([]);
  });

  it('detects footnote references and definitions', () => {
    expect(detectLossyConstructs('A claim[^1].\n\n[^1]: The source.')).toEqual(['footnotes']);
    expect(detectLossyConstructs('A claim[^note].')).toEqual(['footnotes']);
  });

  it('detects raw HTML tags', () => {
    expect(detectLossyConstructs('Before\n\n<div class="x">hi</div>\n\nAfter')).toEqual([
      'HTML tags',
    ]);
    expect(detectLossyConstructs('line one<br/>line two')).toEqual(['HTML tags']);
    expect(detectLossyConstructs('text </span> text')).toEqual(['HTML tags']);
  });

  it('detects HTML comments', () => {
    expect(detectLossyConstructs('text <!-- hidden note --> text')).toEqual(['HTML tags']);
  });

  it('reports both when both are present', () => {
    expect(detectLossyConstructs('A[^1] and <b>bold</b>.\n\n[^1]: src')).toEqual([
      'footnotes',
      'HTML tags',
    ]);
  });

  it('does not flag autolinks or comparison operators', () => {
    expect(detectLossyConstructs('Visit <https://example.com> or email <a@b.com>.')).toEqual([]);
    expect(detectLossyConstructs('When x < y and y > z, nothing happens.')).toEqual([]);
  });

  it('ignores constructs inside fenced code blocks', () => {
    const md = '```html\n<div>not real</div>\n[^1]: not a footnote\n```\n\nplain text';
    expect(detectLossyConstructs(md)).toEqual([]);
  });

  it('ignores constructs inside inline code', () => {
    expect(detectLossyConstructs('Use `<br>` to break, and `[^x]` for footnotes.')).toEqual([]);
  });

  it('still detects constructs outside code', () => {
    const md = '```\nsafe\n```\n\nBut here is <em>real html</em>.';
    expect(detectLossyConstructs(md)).toEqual(['HTML tags']);
  });
});
