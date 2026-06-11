import type { TrackedChangeInfo } from '../types';

interface ReplacementCardProps {
  /** The delete half — the original text being replaced. */
  del: TrackedChangeInfo;
  /** The insert half — the replacement text. */
  ins: TrackedChangeInfo;
  isActive: boolean;
  top: number;
  /** All callbacks receive the shared pairId, resolving both halves at once. */
  onAccept: (pairId: string) => void;
  onReject: (pairId: string) => void;
  onClick: (pairId: string) => void;
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

function clip(text: string): string {
  return text.slice(0, 60) + (text.length > 60 ? '…' : '');
}

export default function ReplacementCard({
  del,
  ins,
  isActive,
  top,
  onAccept,
  onReject,
  onClick,
}: ReplacementCardProps) {
  const pairId = del.pairId ?? ins.pairId ?? del.id;
  const authorLabel = del.authorID === 'claude' ? 'Claude (AI)' : del.authorID;

  return (
    <div
      className={`suggestion-card suggestion-card-replace${isActive ? ' suggestion-card-active' : ''}`}
      style={{ top }}
      data-card-id={pairId}
      onClick={() => onClick(pairId)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className="suggestion-type-badge replace">Replacement</span>
        <span className="comment-author">{authorLabel}</span>
        <span className="comment-time">{timeAgo(del.createdAt)}</span>
      </div>

      <div className="comment-anchor-text">
        <span className="suggestion-replace-old">
          {'"'}
          {clip(del.text)}
          {'"'}
        </span>
        <span className="suggestion-replace-arrow"> → </span>
        <span className="suggestion-replace-new">
          {'"'}
          {clip(ins.text)}
          {'"'}
        </span>
      </div>

      <div className="suggestion-actions">
        <button
          className="suggestion-accept-btn"
          title="Accept replacement"
          onClick={(e) => {
            e.stopPropagation();
            onAccept(pairId);
          }}
        >
          ✓ Accept
        </button>
        <button
          className="suggestion-reject-btn"
          title="Reject replacement"
          onClick={(e) => {
            e.stopPropagation();
            onReject(pairId);
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
