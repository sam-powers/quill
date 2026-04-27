import { useState, useEffect, useCallback, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import type { Comment, TrackedChangeInfo } from '../types';
import CommentCard from './CommentCard';
import AddCommentButton from './AddCommentButton';
import SuggestionCard from './SuggestionCard';
import type { SelectionInfo } from './Editor';

interface CommentLayerProps {
  editor: Editor | null;
  comments: Comment[];
  activeCommentId: string | null;
  selectionInfo: SelectionInfo | null;
  author: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  trackedChanges: TrackedChangeInfo[];
  isSuggesting: boolean;
  onAddComment: (text: string) => void;
  onReply: (commentId: string, text: string) => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => void;
  onDelete: (commentId: string) => void;
  onActivate: (commentId: string) => void;
  onAcceptChange: (id: string) => void;
  onRejectChange: (id: string) => void;
}

interface CardPosition {
  cardId: string;
  type: 'comment' | 'suggestion';
  rawTop: number;
  nudgedTop: number;
}

const CARD_HEIGHT_ESTIMATE = 120;
const CARD_GAP = 8;

function stackCards(cards: CardPosition[]): CardPosition[] {
  if (cards.length === 0) return cards;

  const sorted = [...cards].sort((a, b) => a.rawTop - b.rawTop);
  const result: CardPosition[] = [];
  let cursor = sorted[0].rawTop;

  for (const card of sorted) {
    const nudgedTop = Math.max(card.rawTop, cursor);
    result.push({ ...card, nudgedTop });
    cursor = nudgedTop + CARD_HEIGHT_ESTIMATE + CARD_GAP;
  }

  return result;
}

function getAnchorTop(editor: Editor, commentId: string): number | null {
  try {
    const view = editor.view;
    const dom = view.dom;
    const el = dom.querySelector(`[data-comment-id="${commentId}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const containerRect = dom.closest('.editor-scroll-area')?.getBoundingClientRect();
    if (!containerRect) return null;
    return rect.top - containerRect.top + (dom.closest('.editor-scroll-area')?.scrollTop ?? 0);
  } catch {
    return null;
  }
}

function getChangeAnchorTop(editor: Editor, changeId: string): number | null {
  try {
    const view = editor.view;
    const dom = view.dom;
    const el = dom.querySelector(`[data-change-id="${changeId}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const containerRect = dom.closest('.editor-scroll-area')?.getBoundingClientRect();
    if (!containerRect) return null;
    return rect.top - containerRect.top + (dom.closest('.editor-scroll-area')?.scrollTop ?? 0);
  } catch {
    return null;
  }
}

export default function CommentLayer({
  editor,
  comments,
  activeCommentId,
  selectionInfo,
  author,
  containerRef,
  trackedChanges,
  isSuggesting,
  onAddComment,
  onReply,
  onResolve,
  onUnresolve,
  onDelete,
  onActivate,
  onAcceptChange,
  onRejectChange,
}: CommentLayerProps) {
  const [cardPositions, setCardPositions] = useState<CardPosition[]>([]);
  const rafRef = useRef<number>(0);

  const visibleComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);
  const [showResolved, setShowResolved] = useState(false);
  const displayComments = showResolved ? comments : visibleComments;

  const pendingChanges = isSuggesting ? trackedChanges.filter((c) => c.status === 'pending') : [];

  const reflow = useCallback(() => {
    if (!editor) return;

    const rawCards: CardPosition[] = [];

    for (const comment of displayComments) {
      const top = getAnchorTop(editor, comment.id);
      rawCards.push({
        cardId: comment.id,
        type: 'comment',
        rawTop: top ?? comment.from * 0.5,
        nudgedTop: top ?? comment.from * 0.5,
      });
    }

    for (const change of pendingChanges) {
      const top = getChangeAnchorTop(editor, change.id);
      rawCards.push({
        cardId: change.id,
        type: 'suggestion',
        rawTop: top ?? change.from * 0.5,
        nudgedTop: top ?? change.from * 0.5,
      });
    }

    setCardPositions(stackCards(rawCards));
  }, [editor, displayComments, pendingChanges]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(reflow);
    };
    editor.on('update', onUpdate);
    editor.on('selectionUpdate', onUpdate);
    reflow();
    return () => {
      editor.off('update', onUpdate);
      editor.off('selectionUpdate', onUpdate);
      cancelAnimationFrame(rafRef.current);
    };
  }, [editor, reflow]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(reflow);
  }, [comments, trackedChanges, reflow]);

  const addBtnTop = selectionInfo
    ? (() => {
        if (!containerRef.current) return selectionInfo.top;
        const rect = containerRef.current.getBoundingClientRect();
        const scrollTop = containerRef.current.scrollTop;
        return selectionInfo.top - rect.top + scrollTop;
      })()
    : 0;

  return (
    <div className="comment-layer" ref={containerRef as React.RefObject<HTMLDivElement>}>
      {resolvedComments.length > 0 && (
        <button
          className="show-resolved-btn"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? 'Hide' : 'Show'} {resolvedComments.length} resolved
        </button>
      )}

      <AddCommentButton
        top={addBtnTop}
        visible={!!selectionInfo}
        author={author}
        onAdd={onAddComment}
      />

      {displayComments.map((comment) => {
        const pos = cardPositions.find((p) => p.cardId === comment.id);
        const top = pos?.nudgedTop ?? comment.from * 0.5;
        return (
          <CommentCard
            key={comment.id}
            comment={comment}
            isActive={comment.id === activeCommentId}
            top={top}
            onReply={onReply}
            onResolve={onResolve}
            onUnresolve={onUnresolve}
            onDelete={onDelete}
            onClick={onActivate}
          />
        );
      })}

      {pendingChanges.map((change) => {
        const pos = cardPositions.find((p) => p.cardId === change.id);
        const top = pos?.nudgedTop ?? change.from * 0.5;
        return (
          <SuggestionCard
            key={change.id}
            change={change}
            top={top}
            onAccept={onAcceptChange}
            onReject={onRejectChange}
          />
        );
      })}
    </div>
  );
}
