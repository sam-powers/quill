import type { TrackedChangeInfo } from '../types';

interface SuggestionCardProps {
  change: TrackedChangeInfo;
  top: number;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SuggestionCard({ change, top, onAccept, onReject }: SuggestionCardProps) {
  const isInsert = change.operation === 'insert';
  const preview = change.text.slice(0, 60) + (change.text.length > 60 ? '…' : '');
  const authorLabel = change.authorID === 'claude' ? 'Claude (AI)' : change.authorID;

  return (
    <div
      className={`suggestion-card ${isInsert ? 'suggestion-card-insert' : 'suggestion-card-delete'}`}
      style={{ top }}
      data-card-id={change.id}
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
