import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      setComment: (commentId: string) => ReturnType;
      unsetComment: (commentId: string) => ReturnType;
      setCommentResolved: (commentId: string, resolved: boolean) => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => ({ 'data-comment-id': attrs.commentId }),
      },
      resolved: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-resolved') === 'true',
        renderHTML: (attrs) => ({ 'data-resolved': String(attrs.resolved) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'mark[data-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const resolved = HTMLAttributes['data-resolved'] === 'true';
    return [
      'mark',
      mergeAttributes(HTMLAttributes, {
        class: `comment-mark ${resolved ? 'comment-resolved' : 'comment-active'}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        (commentId: string) =>
        ({ commands }) => {
          return commands.setMark(this.name, { commentId, resolved: false });
        },
      unsetComment:
        (commentId: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc } = state;
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === this.name && mark.attrs.commentId === commentId) {
                tr.removeMark(pos, pos + node.nodeSize, mark.type);
              }
            });
          });
          dispatch(tr);
          return true;
        },
      // Re-stamp the mark's `resolved` attr so the in-text highlight follows
      // the card's resolved state (dotted underline vs. highlighted). The mark
      // stays on the text either way, so "Show resolved" can still re-anchor.
      setCommentResolved:
        (commentId: string, resolved: boolean) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc } = state;
          const markType = state.schema.marks[this.name];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === this.name && mark.attrs.commentId === commentId) {
                const from = pos;
                const to = pos + node.nodeSize;
                tr.removeMark(from, to, markType);
                tr.addMark(from, to, markType.create({ ...mark.attrs, resolved }));
              }
            });
          });
          dispatch(tr);
          return true;
        },
    };
  },
});
