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

  return {
    comments,
    setComments,
    addComment,
    addReply,
    resolveComment,
    unresolveComment,
    deleteComment,
  };
}
