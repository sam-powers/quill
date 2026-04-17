import { useState, useRef } from 'react';
import type { Comment } from '../types';

interface CommentCardProps {
  comment: Comment;
  isActive: boolean;
  top: number;
  onReply: (commentId: string, text: string) => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => void;
  onDelete: (commentId: string) => void;
  onClick: (commentId: string) => void;
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function CommentCard({
  comment,
  isActive,
  top,
  onReply,
  onResolve,
  onUnresolve,
  onDelete,
  onClick,
}: CommentCardProps) {
  const [replyText, setReplyText] = useState('');
  const [showReply, setShowReply] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleReplySubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(comment.id, trimmed);
    setReplyText('');
    setShowReply(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleReplySubmit(e as unknown as React.FormEvent);
    }
    if (e.key === 'Escape') {
      setShowReply(false);
      setReplyText('');
    }
  }

  return (
    <div
      className={`comment-card${isActive ? ' comment-card-active' : ''}${comment.resolved ? ' comment-card-resolved' : ''}`}
      style={{ top }}
      onClick={() => onClick(comment.id)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className="comment-author">{comment.author}</span>
        <span className="comment-time">{timeAgo(comment.createdAt)}</span>
        <button
          className="comment-resolve-btn"
          title={comment.resolved ? 'Unresolve' : 'Resolve'}
          onClick={(e) => {
            e.stopPropagation();
            comment.resolved ? onUnresolve(comment.id) : onResolve(comment.id);
          }}
        >
          {comment.resolved ? '↺' : '✓'}
        </button>
        <button
          className="comment-delete-btn"
          title="Delete comment"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(comment.id);
          }}
        >
          ×
        </button>
      </div>

      <div className="comment-anchor-text">"{comment.anchorText.slice(0, 60)}{comment.anchorText.length > 60 ? '…' : ''}"</div>

      {comment.replies.map((reply) => (
        <div key={reply.id} className="comment-reply">
          <span className="comment-author">{reply.author}</span>
          <span className="comment-time">{timeAgo(reply.createdAt)}</span>
          <p className="comment-reply-text">{reply.text}</p>
        </div>
      ))}

      {showReply ? (
        <form className="comment-reply-form" onSubmit={handleReplySubmit}>
          <textarea
            ref={textareaRef}
            className="comment-reply-input"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply… (Cmd+Enter to post)"
            rows={2}
            autoFocus
          />
          <div className="comment-reply-actions">
            <button type="submit" className="btn-primary" disabled={!replyText.trim()}>
              Reply
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setShowReply(false);
                setReplyText('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        !comment.resolved && (
          <button
            className="comment-reply-trigger"
            onClick={(e) => {
              e.stopPropagation();
              setShowReply(true);
              setTimeout(() => textareaRef.current?.focus(), 0);
            }}
          >
            Reply
          </button>
        )
      )}
    </div>
  );
}
