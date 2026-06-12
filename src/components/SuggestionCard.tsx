import type { TrackedChangeInfo } from '../types';
import { timeAgo, clip } from '../utils/format';

interface SuggestionCardProps {
  change: TrackedChangeInfo;
  isActive: boolean;
  top: number;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onClick: (id: string) => void;
}

export default function SuggestionCard({
  change,
  isActive,
  top,
  onAccept,
  onReject,
  onClick,
}: SuggestionCardProps) {
  const isInsert = change.operation === 'insert';
  const preview = clip(change.text);
  const authorLabel = change.authorID === 'claude' ? 'Claude (AI)' : change.authorID;

  return (
    <div
      className={`suggestion-card ${isInsert ? 'suggestion-card-insert' : 'suggestion-card-delete'}${isActive ? ' suggestion-card-active' : ''}`}
      style={{ top }}
      data-card-id={change.id}
      onClick={() => onClick(change.id)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className={`suggestion-type-badge ${isInsert ? 'insert' : 'delete'}`}>
          {isInsert ? 'Insertion' : 'Deletion'}
        </span>
        <span className="comment-author">{authorLabel}</span>
        <span className="comment-time">{timeAgo(change.createdAt)}</span>
      </div>

      {preview && (
        <div className="comment-anchor-text">
          {'"'}
          {preview}
          {'"'}
        </div>
      )}

      <div className="suggestion-actions">
        <button
          className="suggestion-accept-btn"
          title="Accept change"
          onClick={(e) => {
            e.stopPropagation();
            onAccept(change.id);
          }}
        >
          ✓ Accept
        </button>
        <button
          className="suggestion-reject-btn"
          title="Reject change"
          onClick={(e) => {
            e.stopPropagation();
            onReject(change.id);
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
