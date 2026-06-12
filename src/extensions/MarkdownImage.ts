import Image from '@tiptap/extension-image';
import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * Directory of the currently open document. Relative image paths in the
 * Markdown (`./pic.png`, `images/a.jpg`) are resolved against it for
 * display. Null when the document has never been saved (nothing to resolve
 * against) — relative images then simply fail to load until first save.
 */
let imageBaseDir: string | null = null;

export function setImageBaseDir(dir: string | null) {
  imageBaseDir = dir;
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * Compute the src the <img> element should display. The document attribute
 * keeps whatever the Markdown said (so serialization is untouched); only the
 * rendered DOM gets the rewritten URL.
 */
export function resolveImageSrc(src: string): string {
  // Scheme-prefixed (https:, data:, asset:, file:, …) — display as-is.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return src;
  // Relative path: resolve against the open document's directory. Outside
  // Tauri (vitest, plain-Vite dev) there's no asset protocol to serve local
  // files, so leave the path alone.
  if (!imageBaseDir || !isTauri()) return src;
  const sep = imageBaseDir.includes('\\') ? '\\' : '/';
  const rel = src.replace(/^\.\//, '');
  return convertFileSrc(`${imageBaseDir}${sep}${rel}`);
}

/**
 * Image extension whose rendered src is resolved at draw time. tiptap-markdown
 * serializes from `node.attrs.src`, never the DOM, so `![alt](./pic.png)`
 * survives a round-trip byte-for-byte while still displaying the local file
 * through Tauri's asset protocol.
 */
export const MarkdownImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes };
    if (typeof attrs.src === 'string') {
      attrs.src = resolveImageSrc(attrs.src);
    }
    return ['img', attrs];
  },
}).configure({ inline: true });
