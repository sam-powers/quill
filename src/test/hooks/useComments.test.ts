import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useComments } from '../../hooks/useComments';

describe('useComments', () => {
  describe('addComment', () => {
    it('adds a comment with the correct fields', () => {
      const { result } = renderHook(() => useComments());
      let comment: ReturnType<typeof result.current.addComment>;

      act(() => {
        comment = result.current.addComment('hello world', 0, 11, 'Alice');
      });

      expect(result.current.comments).toHaveLength(1);
      const c = result.current.comments[0];
      expect(c.anchorText).toBe('hello world');
      expect(c.from).toBe(0);
      expect(c.to).toBe(11);
      expect(c.author).toBe('Alice');
      expect(c.resolved).toBe(false);
      expect(c.replies).toEqual([]);
      expect(c.id).toBeTruthy();
      expect(c.id).toBe(comment!.id);
    });

    it('assigns unique IDs to multiple comments', () => {
      const { result } = renderHook(() => useComments());
      act(() => {
        result.current.addComment('first', 0, 5, 'Alice');
        result.current.addComment('second', 6, 12, 'Bob');
      });
      const ids = result.current.comments.map((c) => c.id);
      expect(new Set(ids).size).toBe(2);
    });

    it('sets a valid ISO createdAt timestamp', () => {
      const before = Date.now();
      const { result } = renderHook(() => useComments());
      act(() => {
        result.current.addComment('text', 0, 4, 'Alice');
      });
      const after = Date.now();
      const ts = Date.parse(result.current.comments[0].createdAt);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('addReply', () => {
    it('adds a reply to the correct comment', () => {
      const { result } = renderHook(() => useComments());
      let commentId: string;
      act(() => {
        const c = result.current.addComment('text', 0, 4, 'Alice');
        commentId = c.id;
      });
      act(() => {
        result.current.addReply(commentId!, 'Great point', 'Bob');
      });
      expect(result.current.comments[0].replies).toHaveLength(1);
      const reply = result.current.comments[0].replies[0];
      expect(reply.text).toBe('Great point');
      expect(reply.author).toBe('Bob');
      expect(reply.id).toBeTruthy();
    });

    it('does not affect other comments when adding a reply', () => {
      const { result } = renderHook(() => useComments());
      let id1: string;
      act(() => {
        id1 = result.current.addComment('first', 0, 5, 'Alice').id;
        result.current.addComment('second', 6, 11, 'Alice');
      });
      act(() => {
        result.current.addReply(id1!, 'reply', 'Bob');
      });
      expect(result.current.comments[1].replies).toHaveLength(0);
    });

    it('does nothing when commentId does not exist', () => {
      const { result } = renderHook(() => useComments());
      act(() => {
        result.current.addComment('text', 0, 4, 'Alice');
      });
      act(() => {
        result.current.addReply('nonexistent-id', 'reply', 'Bob');
      });
      expect(result.current.comments[0].replies).toHaveLength(0);
    });
  });

  describe('resolveComment', () => {
    it('sets resolved to true', () => {
      const { result } = renderHook(() => useComments());
      let id: string;
      act(() => {
        id = result.current.addComment('text', 0, 4, 'Alice').id;
      });
      act(() => {
        result.current.resolveComment(id!);
      });
      expect(result.current.comments[0].resolved).toBe(true);
    });

    it('does not affect other comments', () => {
      const { result } = renderHook(() => useComments());
      let id1: string;
      act(() => {
        id1 = result.current.addComment('first', 0, 5, 'Alice').id;
        result.current.addComment('second', 6, 11, 'Alice');
      });
      act(() => {
        result.current.resolveComment(id1!);
      });
      expect(result.current.comments[1].resolved).toBe(false);
    });
  });

  describe('unresolveComment', () => {
    it('sets resolved back to false', () => {
      const { result } = renderHook(() => useComments());
      let id: string;
      act(() => {
        id = result.current.addComment('text', 0, 4, 'Alice').id;
      });
      act(() => {
        result.current.resolveComment(id!);
      });
      act(() => {
        result.current.unresolveComment(id!);
      });
      expect(result.current.comments[0].resolved).toBe(false);
    });
  });

  describe('deleteComment', () => {
    it('removes the comment from the array', () => {
      const { result } = renderHook(() => useComments());
      let id: string;
      act(() => {
        id = result.current.addComment('text', 0, 4, 'Alice').id;
      });
      act(() => {
        result.current.deleteComment(id!);
      });
      expect(result.current.comments).toHaveLength(0);
    });

    it('only removes the targeted comment', () => {
      const { result } = renderHook(() => useComments());
      let id1: string;
      act(() => {
        id1 = result.current.addComment('first', 0, 5, 'Alice').id;
        result.current.addComment('second', 6, 11, 'Alice');
      });
      act(() => {
        result.current.deleteComment(id1!);
      });
      expect(result.current.comments).toHaveLength(1);
      expect(result.current.comments[0].anchorText).toBe('second');
    });

    it('is a no-op when id does not exist', () => {
      const { result } = renderHook(() => useComments());
      act(() => {
        result.current.addComment('text', 0, 4, 'Alice');
      });
      act(() => {
        result.current.deleteComment('nonexistent');
      });
      expect(result.current.comments).toHaveLength(1);
    });
  });

  describe('retryAIReply', () => {
    // Set up a comment carrying a single failed AI reply, returning both ids.
    function withFailedReply() {
      const { result } = renderHook(() => useComments());
      let commentId = '';
      let replyId = '';
      act(() => {
        commentId = result.current.addComment('text', 0, 4, 'Alice').id;
      });
      act(() => {
        replyId = result.current.startAIReply(commentId);
      });
      act(() => {
        result.current.appendAIReplyChunk(commentId, replyId, 'partial answer');
      });
      act(() => {
        result.current.failAIReply(commentId, replyId, 'API Error: overloaded');
      });
      return { result, commentId, replyId };
    }

    it('resets the same reply to a pending state without appending a new one', () => {
      const { result, commentId, replyId } = withFailedReply();
      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0].error).toBe('API Error: overloaded');

      act(() => {
        result.current.retryAIReply(commentId, replyId);
      });

      const replies = result.current.comments[0].replies;
      expect(replies).toHaveLength(1); // reused, not appended
      const r = replies[0];
      expect(r.id).toBe(replyId); // id is stable
      expect(r.pending).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.text).toBe(''); // streamed text cleared
      expect(r.authorKind).toBe('ai');
    });

    it('is a no-op for an unknown replyId', () => {
      const { result, commentId } = withFailedReply();
      const before = result.current.comments[0].replies[0];

      act(() => {
        result.current.retryAIReply(commentId, 'nonexistent-reply');
      });

      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0]).toEqual(before);
    });
  });
});
