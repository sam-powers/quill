import { useState, useEffect, useCallback, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import type { Comment, TrackedChangeInfo } from '../types';
import CommentCard from './CommentCard';
import SuggestionCard from './SuggestionCard';

interface CommentLayerProps {
  editor: Editor | null;
  comments: Comment[];
  activeCommentId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  trackedChanges: TrackedChangeInfo[];
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

function stackCards(cards: CardPosition[], heightFor: (id: string) => number): CardPosition[] {
  if (cards.length === 0) return cards;

  const sorted = [...cards].sort((a, b) => a.rawTop - b.rawTop);
  const result: CardPosition[] = [];
  let cursor = sorted[0].rawTop;

  for (const card of sorted) {
    const nudgedTop = Math.max(card.rawTop, cursor);
    result.push({ ...card, nudgedTop });
    cursor = nudgedTop + heightFor(card.cardId) + CARD_GAP;
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
  containerRef,
  trackedChanges,
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
  const [showResolved, setShowResolved] = useState(false);
  const heightsRef = useRef<Map<string, number>>(new Map());

  const visibleComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);
  const displayComments = showResolved ? comments : visibleComments;

  const pendingChanges = trackedChanges.filter((c) => c.status === 'pending');

  // Stable refs so reflow's identity doesn't change on every render
  // (which would otherwise re-run the editor.on effect → setState → loop).
  const editorRef = useRef(editor);
  const displayCommentsRef = useRef(displayComments);
  const pendingChangesRef = useRef(pendingChanges);
  editorRef.current = editor;
  displayCommentsRef.current = displayComments;
  pendingChangesRef.current = pendingChanges;

  const reflow = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;

    const rawCards: CardPosition[] = [];

    for (const comment of displayCommentsRef.current) {
      const top = getAnchorTop(ed, comment.id);
      rawCards.push({
        cardId: comment.id,
        type: 'comment',
        rawTop: top ?? comment.from * 0.5,
        nudgedTop: top ?? comment.from * 0.5,
      });
    }

    for (const change of pendingChangesRef.current) {
      const top = getChangeAnchorTop(ed, change.id);
      rawCards.push({
        cardId: change.id,
        type: 'suggestion',
        rawTop: top ?? change.from * 0.5,
        nudgedTop: top ?? change.from * 0.5,
      });
    }

    setCardPositions((prev) => {
      const next = stackCards(rawCards, (id) => heightsRef.current.get(id) ?? CARD_HEIGHT_ESTIMATE);
      if (
        prev.length === next.length &&
        prev.every((p, i) => p.cardId === next[i].cardId && p.nudgedTop === next[i].nudgedTop)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const containerEl = containerRef.current;
  useEffect(() => {
    if (!containerEl) return;
    const observer = new ResizeObserver(() => {
      const cards = containerEl.querySelectorAll<HTMLElement>('[data-card-id]');
      let changed = false;
      const seen = new Set<string>();
      cards.forEach((el) => {
        const id = el.dataset.cardId;
        if (!id) return;
        seen.add(id);
        const h = el.getBoundingClientRect().height;
        if (heightsRef.current.get(id) !== h) {
          heightsRef.current.set(id, h);
          changed = true;
        }
      });
      for (const id of heightsRef.current.keys()) {
        if (!seen.has(id)) {
          heightsRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(reflow);
      }
    });
    observer.observe(containerEl);
    const cards = containerEl.querySelectorAll<HTMLElement>('[data-card-id]');
    cards.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [containerEl, reflow, cardPositions.length]);

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
  }, [comments, trackedChanges, showResolved, reflow]);

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
