import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pendingComment: {
      setPendingCommentRange: (from: number, to: number) => ReturnType;
      clearPendingCommentRange: () => ReturnType;
    };
  }
}

interface PendingRange {
  from: number;
  to: number;
}

export const PENDING_COMMENT_KEY = new PluginKey<PendingRange | null>('pendingComment');

/**
 * Keeps the to-be-commented range visibly highlighted while the comment
 * composer is open. The native selection highlight disappears as soon as the
 * composer textarea takes focus; this decoration stands in for it until the
 * comment is shipped (becomes a real comment mark) or cancelled.
 *
 * A decoration, not a mark: it never touches the document, so it can't dirty
 * the file or leak into the serialized Markdown.
 */
export const PendingComment = Extension.create({
  name: 'pendingComment',

  addProseMirrorPlugins() {
    return [
      new Plugin<PendingRange | null>({
        key: PENDING_COMMENT_KEY,

        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(PENDING_COMMENT_KEY) as PendingRange | null | undefined;
            if (meta !== undefined) return meta;
            if (!value || !tr.docChanged) return value;
            // Keep the range anchored through concurrent edits (e.g. a Claude
            // reply landing tracked changes while the composer is open).
            // Insertions at either boundary stay outside the range.
            const from = tr.mapping.map(value.from, 1);
            const to = tr.mapping.map(value.to, -1);
            return from < to ? { from, to } : null;
          },
        },

        props: {
          decorations(state) {
            const range = PENDING_COMMENT_KEY.getState(state);
            if (!range) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, { class: 'pending-comment' }),
            ]);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setPendingCommentRange:
        (from: number, to: number) =>
        ({ tr, dispatch }) => {
          if (from >= to) return false;
          if (dispatch) dispatch(tr.setMeta(PENDING_COMMENT_KEY, { from, to }));
          return true;
        },
      clearPendingCommentRange:
        () =>
        ({ state, tr, dispatch }) => {
          if (PENDING_COMMENT_KEY.getState(state) == null) return true;
          if (dispatch) dispatch(tr.setMeta(PENDING_COMMENT_KEY, null));
          return true;
        },
    };
  },
});
