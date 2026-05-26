import { useState, useRef } from 'react';

interface AddCommentButtonProps {
  top: number;
  left?: number;
  visible: boolean;
  author: string;
  onAdd: (text: string) => void;
}

export default function AddCommentButton({
  top,
  left,
  visible,
  author,
  onAdd,
}: AddCommentButtonProps) {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (!visible) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setText('');
    setComposing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSubmit(e as unknown as React.FormEvent);
    }
    if (e.key === 'Escape') {
      setComposing(false);
      setText('');
    }
  }

  if (!composing) {
    return (
      <button
        className="add-comment-btn"
        style={{ position: 'fixed', top, ...(left !== undefined ? { left } : {}) }}
        title="Add comment"
        onClick={() => {
          setComposing(true);
          setTimeout(() => textareaRef.current?.focus(), 0);
        }}
      >
        +
      </button>
    );
  }

  return (
    <div
      className="add-comment-compose"
      style={{ position: 'fixed', top: top - 12, ...(left !== undefined ? { left } : {}) }}
    >
      <div className="comment-header">
        <span className="comment-author">{author}</span>
      </div>
      <form onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          className="comment-reply-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment… (Cmd+Enter to post)"
          rows={3}
          autoFocus
        />
        <div className="comment-reply-actions">
          <button type="submit" className="btn-primary" disabled={!text.trim()}>
            Comment
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setComposing(false);
              setText('');
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
