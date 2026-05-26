import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditScope, QuillEdit } from '../types';

/**
 * Read the plain text of a document range the same way Claude was shown it.
 * We pass '\n' as the block separator and ' ' as the leaf separator so list
 * items and paragraphs become newline-separated plaintext (no markdown syntax)
 * — matching what `getRangeTexts` sends in the prompt and what Claude's `find`
 * strings are expected to match.
 */
export function rangeText(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', ' ');
}

/**
 * Map an offset into `rangeText(doc, from, to)` back to an absolute ProseMirror
 * position. Because `textBetween` injects separator characters at node
 * boundaries that don't correspond to a single document position, we rebuild
 * the same string while tracking, for each emitted character, the doc position
 * it should map to. Returns the absolute position, or null if `offset` is out
 * of bounds.
 *
 * The mapping array has length (text.length + 1): index i is the position just
 * before the i-th emitted character, and the final entry is `to` (end of range).
 */
export function mapRangeTextOffsetToPos(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  offset: number,
): number | null {
  // Rebuild the same string `rangeText` produces while recording the absolute
  // position of each emitted character. `textBetween('\n', ' ')` walks text and
  // text-leaf nodes in document order, inserting one '\n' between leaf blocks
  // (paragraphs, list items) and a ' ' for non-text leaf nodes. We only need to
  // know the position of *real* text characters precisely; any injected
  // separator is anchored to the position just after the preceding text run, so
  // a `find` that starts on a real character always maps to a valid spot.
  const map: number[] = [];
  let prevTextEnd: number | null = null;
  let emittedText = false;

  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const start = Math.max(pos, from);
      const end = Math.min(pos + node.nodeSize, to);
      if (emittedText && prevTextEnd !== null && end > start) {
        // textBetween inserted a '\n' separator between the previous text run
        // and this one; map it to the boundary after the previous run.
        map.push(prevTextEnd);
      }
      for (let p = start; p < end; p++) {
        map.push(p);
      }
      if (end > start) {
        prevTextEnd = end;
        emittedText = true;
      }
      return false;
    }
    return true;
  });

  // Final boundary: end of range.
  map.push(to);

  if (offset < 0 || offset >= map.length) return null;
  return map[offset];
}

/**
 * Given a target range and a `find` string, locate the first occurrence within
 * the range's plaintext and return its absolute from/to document positions.
 * Returns null when `find` is not present verbatim.
 */
export function locateEdit(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  find: string,
): { from: number; to: number } | null {
  const text = rangeText(doc, rangeFrom, rangeTo);
  const idx = text.indexOf(find);
  if (idx === -1) return null;
  const absFrom = mapRangeTextOffsetToPos(doc, rangeFrom, rangeTo, idx);
  const absTo = mapRangeTextOffsetToPos(doc, rangeFrom, rangeTo, idx + find.length);
  if (absFrom === null || absTo === null) return null;
  return { from: absFrom, to: absTo };
}

/** Resolve the absolute from/to bounds for an edit scope around a comment. */
export function resolveScopeRange(
  doc: ProseMirrorNode,
  comment: { from: number; to: number },
  scope: EditScope,
): { from: number; to: number } {
  if (scope === 'doc') return { from: 0, to: doc.content.size };
  if (scope === 'paragraph') {
    const $from = doc.resolve(Math.min(comment.from, doc.content.size));
    return { from: $from.start($from.depth), to: $from.end($from.depth) };
  }
  return { from: comment.from, to: comment.to };
}

/** A located edit ready to apply, in document order. */
export interface PlacedEdit {
  from: number;
  to: number;
  replace: string;
}

/**
 * Pure planning step: turn quote-based edits into absolute-position edits,
 * sorted back-to-front so applying them in order keeps earlier positions valid.
 * Edits whose `find` can't be located are reported via `skipped`.
 */
export function planEdits(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  edits: QuillEdit[],
): { placed: PlacedEdit[]; skipped: number } {
  const placed: PlacedEdit[] = [];
  let skipped = 0;
  for (const edit of edits) {
    const at = locateEdit(doc, rangeFrom, rangeTo, edit.find);
    if (!at) {
      skipped++;
      continue;
    }
    placed.push({ from: at.from, to: at.to, replace: edit.replace });
  }
  placed.sort((a, b) => b.from - a.from);
  return { placed, skipped };
}
