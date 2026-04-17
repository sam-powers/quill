import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      setComment: (commentId: string) => ReturnType;
      unsetComment: (commentId: string) => ReturnType;
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
    };
  },
});
