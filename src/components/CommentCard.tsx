import { useState, useRef } from 'react';
import type { Comment, Reply } from '../types';
import { timeAgo } from '../utils/format';
import { classifyReplyError } from '../hooks/useClaudeReply';

interface CommentCardProps {
  comment: Comment;
  isActive: boolean;
  top: number;
  onReply: (commentId: string, text: string) => void;
  onAIReplyRequest: (commentId: string, userText: string) => void;
  onCancelAIReply: (replyId: string) => void;
  onRetryAIReply: (replyId: string) => void;
  onOpenSessionPicker: () => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => void;
  onDelete: (commentId: string) => void;
  onClick: (commentId: string) => void;
}

function ReplyErrorActions({
  message,
  onRetry,
  onRelink,
}: {
  message: string;
  onRetry: () => void;
  onRelink: () => void;
}) {
  const { retryable, kind } = classifyReplyError(message);
  const retryBtn = (
    <button className="btn-primary" onClick={onRetry}>
      Retry
    </button>
  );
  const relinkBtn = (primary: boolean) => (
    <button className={primary ? 'btn-primary' : 'btn-ghost'} onClick={onRelink}>
      Re-link session…
    </button>
  );

  // Which affordances to surface, driven by the classifier:
  //   auth     → not retryable; re-linking is the only path forward.
  //   session  → re-link is primary (session is gone), retry as fallback.
  //   else     → transient/unknown; retry is primary, re-link demoted.
  let actions: React.ReactNode;
  if (kind === 'auth') {
    actions = relinkBtn(true);
  } else if (kind === 'session') {
    actions = (
      <>
        {relinkBtn(true)}
        {retryable && (
          <button className="btn-ghost" onClick={onRetry}>
            Retry
          </button>
        )}
      </>
    );
  } else {
    actions = (
      <>
        {retryable && retryBtn}
        {relinkBtn(false)}
      </>
    );
  }
  return <div className="comment-reply-error-actions">{actions}</div>;
}

function ReplyView({
  reply,
  onCancel,
  onRetry,
  onRelink,
}: {
  reply: Reply;
  onCancel: () => void;
  onRetry: () => void;
  onRelink: () => void;
}) {
  const isAI = reply.authorKind === 'ai';
  return (
    <div className={`comment-reply${isAI ? ' comment-reply-ai' : ''}`}>
      <div className="comment-header">
        <span className="comment-author">
          {isAI && <span className="ai-badge">AI</span>}
          {reply.author}
        </span>
        <span className="comment-time">{timeAgo(reply.createdAt)}</span>
      </div>
      {reply.error ? (
        <div className="comment-reply-error">
          <p>{reply.error}</p>
          <ReplyErrorActions message={reply.error} onRetry={onRetry} onRelink={onRelink} />
        </div>
      ) : reply.cancelled ? (
        <div className="comment-reply-cancelled">
          <p>Reply stopped.</p>
          <button className="btn-primary" onClick={onRetry}>
            Re-run
          </button>
        </div>
      ) : (
        <>
          <p className="comment-reply-text">
            {reply.text}
            {reply.pending && reply.text.length === 0 && (
              <span className="ai-thinking">Claude is thinking…</span>
            )}
            {reply.pending && <span className="ai-spinner" aria-hidden="true" />}
          </p>
          {reply.pending && (
            <button className="btn-ghost btn-cancel-ai" onClick={onCancel}>
              Cancel
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function CommentCard({
  comment,
  isActive,
  top,
  onReply,
  onAIReplyRequest,
  onCancelAIReply,
  onRetryAIReply,
  onOpenSessionPicker,
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
    // No session linked yet is fine — the request handler opens the session
    // picker and fires the request once one is chosen.
    if (/@claude\b/i.test(trimmed)) {
      onAIReplyRequest(comment.id, trimmed);
    }
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
      data-card-id={comment.id}
      onClick={() => onClick(comment.id)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className="comment-avatar">
          {(comment.author.trim().charAt(0) || '?').toUpperCase()}
        </span>
        <span className="comment-author">{comment.author}</span>
        <span className="comment-time">{timeAgo(comment.createdAt)}</span>
        <button
          className="comment-resolve-btn"
          title={comment.resolved ? 'Unresolve' : 'Resolve'}
          onClick={(e) => {
            e.stopPropagation();
            if (comment.resolved) {
              onUnresolve(comment.id);
            } else {
              onResolve(comment.id);
            }
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

      <div className="comment-anchor-text">
        {'"'}
        {comment.anchorText.slice(0, 60)}
        {comment.anchorText.length > 60 ? '…' : ''}
        {'"'}
      </div>

      {comment.replies.map((reply) => (
        <ReplyView
          key={reply.id}
          reply={reply}
          onCancel={() => onCancelAIReply(reply.id)}
          onRetry={() => onRetryAIReply(reply.id)}
          onRelink={onOpenSessionPicker}
        />
      ))}

      {showReply ? (
        <form className="comment-reply-form" onSubmit={handleReplySubmit}>
          <textarea
            ref={textareaRef}
            className="comment-reply-input"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply… (type @claude to ask Claude)"
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
