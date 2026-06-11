import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export type AnnotationKind = 'comment' | 'suggestion';

export interface AnnotationFocusTarget {
  kind: AnnotationKind;
  id: string;
}

export const ANNOTATION_FOCUS_KEY = new PluginKey<AnnotationFocusTarget | null>('annotationFocus');

// A suggestion target id may be a change id or a replacement's pairId — the
// latter matches both halves, so the whole replacement highlights as one.
function nodeMatches(node: ProseMirrorNode, target: AnnotationFocusTarget): boolean {
  return node.marks.some((mark) =>
    target.kind === 'comment'
      ? mark.type.name === 'comment' && mark.attrs.commentId === target.id
      : (mark.type.name === 'tracked_insert' || mark.type.name === 'tracked_delete') &&
        (mark.attrs.dataTracked?.id === target.id || mark.attrs.dataTracked?.pairId === target.id),
  );
}

// Live range of an annotation in the document. Comments carry a stored
// from/to, but those go stale as the doc is edited — the marks are the truth.
export function findAnnotationRange(
  doc: ProseMirrorNode,
  kind: AnnotationKind,
  id: string,
): { from: number; to: number } | null {
  const target: AnnotationFocusTarget = { kind, id };
  let from: number | null = null;
  let to: number | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText || !nodeMatches(node, target)) return;
    if (from === null || pos < from) from = pos;
    if (to === null || pos + node.nodeSize > to) to = pos + node.nodeSize;
  });
  return from !== null && to !== null ? { from, to } : null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    annotationFocus: {
      /** Intensify the in-text highlight of one comment or suggestion. */
      setAnnotationFocus: (kind: AnnotationKind, id: string) => ReturnType;
      /** Remove the focus highlight, if any. */
      clearAnnotationFocus: () => ReturnType;
    };
  }
}

/**
 * Highlights the text of the currently active annotation (comment or tracked
 * change) with an `annotation-focus` decoration. A decoration rather than a
 * DOM class toggle because ProseMirror re-renders mark elements at will,
 * wiping any class added by hand; and rather than a mark because it must
 * never touch the document. The decorated ranges are recomputed from the
 * live marks on every state change, so they follow edits for free.
 */
export const AnnotationFocus = Extension.create({
  name: 'annotationFocus',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: ANNOTATION_FOCUS_KEY,

        state: {
          init: () => null,
          apply(tr, value: AnnotationFocusTarget | null) {
            const meta = tr.getMeta(ANNOTATION_FOCUS_KEY) as
              | AnnotationFocusTarget
              | null
              | undefined;
            return meta === undefined ? value : meta;
          },
        },

        props: {
          decorations(state) {
            const target = ANNOTATION_FOCUS_KEY.getState(state);
            if (!target) return null;
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !nodeMatches(node, target)) return;
              decorations.push(
                Decoration.inline(pos, pos + node.nodeSize, { class: 'annotation-focus' }),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setAnnotationFocus:
        (kind: AnnotationKind, id: string) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(ANNOTATION_FOCUS_KEY, { kind, id }));
          return true;
        },
      clearAnnotationFocus:
        () =>
        ({ state, tr, dispatch }) => {
          // No-op when already clear, so callers can invoke unconditionally
          // without dispatching useless transactions.
          if (ANNOTATION_FOCUS_KEY.getState(state) == null) return true;
          if (dispatch) dispatch(tr.setMeta(ANNOTATION_FOCUS_KEY, null));
          return true;
        },
    };
  },
});
