import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Comment, Reply } from '../types';

interface UseCommentsReturn {
  comments: Comment[];
  setComments: React.Dispatch<React.SetStateAction<Comment[]>>;
  addComment: (anchorText: string, from: number, to: number, author: string) => Comment;
  addReply: (commentId: string, text: string, author: string) => void;
  resolveComment: (commentId: string) => void;
  unresolveComment: (commentId: string) => void;
  deleteComment: (commentId: string) => void;
  startAIReply: (commentId: string) => string;
  appendAIReplyChunk: (commentId: string, replyId: string, chunk: string) => void;
  finishAIReply: (commentId: string, replyId: string) => void;
  failAIReply: (commentId: string, replyId: string, message: string) => void;
  retryAIReply: (commentId: string, replyId: string) => void;
}

export function useComments(): UseCommentsReturn {
  const [comments, setComments] = useState<Comment[]>([]);

  const addComment = useCallback(
    (anchorText: string, from: number, to: number, author: string): Comment => {
      const comment: Comment = {
        id: uuidv4(),
        anchorText,
        from,
        to,
        author,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      };
      setComments((prev) => [...prev, comment]);
      return comment;
    },
    [],
  );

  const addReply = useCallback((commentId: string, text: string, author: string) => {
    const reply: Reply = {
      id: uuidv4(),
      author,
      text,
      createdAt: new Date().toISOString(),
      authorKind: 'user',
    };
    setComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c)),
    );
  }, []);

  const resolveComment = useCallback((commentId: string) => {
    setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, resolved: true } : c)));
  }, []);

  const unresolveComment = useCallback((commentId: string) => {
    setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, resolved: false } : c)));
  }, []);

  const deleteComment = useCallback((commentId: string) => {
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  }, []);

  const startAIReply = useCallback((commentId: string): string => {
    const replyId = uuidv4();
    const reply: Reply = {
      id: replyId,
      author: 'Claude',
      text: '',
      createdAt: new Date().toISOString(),
      authorKind: 'ai',
      pending: true,
    };
    setComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c)),
    );
    return replyId;
  }, []);

  const appendAIReplyChunk = useCallback((commentId: string, replyId: string, chunk: string) => {
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? {
              ...c,
              replies: c.replies.map((r) =>
                r.id === replyId ? { ...r, text: r.text + chunk } : r,
              ),
            }
          : c,
      ),
    );
  }, []);

  const finishAIReply = useCallback((commentId: string, replyId: string) => {
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? {
              ...c,
              replies: c.replies.map((r) => (r.id === replyId ? { ...r, pending: false } : r)),
            }
          : c,
      ),
    );
  }, []);

  const failAIReply = useCallback((commentId: string, replyId: string, message: string) => {
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? {
              ...c,
              replies: c.replies.map((r) =>
                r.id === replyId ? { ...r, pending: false, error: message } : r,
              ),
            }
          : c,
      ),
    );
  }, []);

  // Reset an existing (errored) AI reply in place so a retry reuses the same
  // entry rather than appending a new one — clears the error, resets the
  // streamed text, and marks it pending again. Unknown ids are a no-op.
  const retryAIReply = useCallback((commentId: string, replyId: string) => {
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? {
              ...c,
              replies: c.replies.map((r) =>
                r.id === replyId ? { ...r, pending: true, error: undefined, text: '' } : r,
              ),
            }
          : c,
      ),
    );
  }, []);

  return {
    comments,
    setComments,
    addComment,
    addReply,
    resolveComment,
    unresolveComment,
    deleteComment,
    startAIReply,
    appendAIReplyChunk,
    finishAIReply,
    failAIReply,
    retryAIReply,
  };
}
