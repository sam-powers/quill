import { useState } from 'react';
import type { ReviewOptions, ReviewPhase } from '../hooks/useDocumentReview';

/**
 * Pre-filled into the guidance box so a plain "Submit" already asks for a
 * useful review; the user edits or replaces it for a focused pass
 * ("make 20% shorter", "check against the interview notes", …).
 */
export const DEFAULT_REVIEW_GUIDANCE =
  'Review for tone, clarity, and flow. Flag anything confusing, redundant, or inconsistent.';

interface ReviewModalProps {
  phase: ReviewPhase;
  /** Kick off the review with the chosen options. */
  onSubmit: (options: ReviewOptions) => void;
  /** Stop a streaming review (discards partial output). */
  onCancelStream: () => void;
  /** Close the modal (idle / done / error states). */
  onClose: () => void;
}

function doneSummary(phase: Extract<ReviewPhase, { status: 'done' }>): string {
  const parts: string[] = [];
  if (phase.commentsAdded > 0) {
    parts.push(`${phase.commentsAdded} comment${phase.commentsAdded === 1 ? '' : 's'} added`);
  }
  if (phase.suggestionsApplied > 0) {
    parts.push(
      `${phase.suggestionsApplied} suggestion${phase.suggestionsApplied === 1 ? '' : 's'} proposed`,
    );
  }
  if (phase.skipped > 0) {
    parts.push(`${phase.skipped} couldn't be placed`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No comments or suggestions were made.';
}

/**
 * The "Review full document" dialog: guidance + what-to-produce checkboxes,
 * then Claude's streaming assessment, then a result summary. Comments and
 * suggestions land in the document behind the modal as it finishes.
 */
export default function ReviewModal({
  phase,
  onSubmit,
  onCancelStream,
  onClose,
}: ReviewModalProps) {
  const [guidance, setGuidance] = useState(DEFAULT_REVIEW_GUIDANCE);
  const [makeComments, setMakeComments] = useState(true);
  const [makeSuggestions, setMakeSuggestions] = useState(true);

  const composing = phase.status === 'idle';
  const streaming = phase.status === 'streaming';

  return (
    <div
      className="app-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Review full document"
    >
      <div className="app-modal review-modal">
        <h2 className="app-modal-title">Review full document</h2>

        {composing && (
          <>
            <label className="review-modal-label" htmlFor="review-guidance">
              Guidance for this review
            </label>
            <textarea
              id="review-guidance"
              className="review-modal-guidance"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              rows={3}
              autoFocus
            />
            <div className="review-modal-checks">
              <label className="review-modal-check">
                <input
                  type="checkbox"
                  checked={makeComments}
                  onChange={(e) => setMakeComments(e.target.checked)}
                />
                Make comments
              </label>
              <label className="review-modal-check">
                <input
                  type="checkbox"
                  checked={makeSuggestions}
                  onChange={(e) => setMakeSuggestions(e.target.checked)}
                />
                Make suggestions
              </label>
            </div>
            <div className="app-modal-actions">
              <button className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!makeComments && !makeSuggestions}
                title={
                  !makeComments && !makeSuggestions
                    ? 'Pick at least one: comments or suggestions'
                    : undefined
                }
                onClick={() => onSubmit({ guidance, makeComments, makeSuggestions })}
              >
                Submit
              </button>
            </div>
          </>
        )}

        {streaming && (
          <>
            <div className="review-modal-stream" aria-live="polite">
              {phase.text || 'Claude is reading the document…'}
              <span className="streaming-cursor" />
            </div>
            <div className="app-modal-actions">
              <button className="btn-ghost" onClick={onCancelStream}>
                Cancel
              </button>
            </div>
          </>
        )}

        {phase.status === 'done' && (
          <>
            {phase.text && <div className="review-modal-stream">{phase.text}</div>}
            <p className="review-modal-summary">{doneSummary(phase)}</p>
            <div className="app-modal-actions">
              <button className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}

        {phase.status === 'error' && (
          <>
            <p className="app-modal-message review-modal-error">{phase.message}</p>
            <div className="app-modal-actions">
              <button className="btn-ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
