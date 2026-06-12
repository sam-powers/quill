import { useEffect, useRef, useState } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import { getFindState } from '../extensions/Find';

interface FindBarProps {
  editor: TiptapEditor | null;
  onClose: () => void;
}

export default function FindBar({ editor, onClose }: FindBarProps) {
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  // Match data lives in the editor's plugin state; re-render on every
  // transaction so the counter and highlights stay live.
  const [, setTick] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => setTick((t) => t + 1);
    editor.on('transaction', refresh);
    return () => {
      editor.off('transaction', refresh);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setFindQuery(query);
  }, [editor, query]);

  // Clear the highlights when the bar goes away, however that happens.
  useEffect(() => {
    return () => {
      if (editor && !editor.isDestroyed) editor.commands.clearFind();
    };
  }, [editor]);

  // Cmd+F while the bar is already open re-focuses and selects the query, so
  // the shortcut always means "search for something (new)".
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        findInputRef.current?.focus();
        findInputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const state = editor && !editor.isDestroyed ? getFindState(editor.state) : null;
  const count = state?.matches.length ?? 0;
  const activeIndex = state?.activeIndex ?? 0;

  const goTo = (index: number) => {
    if (!editor || count === 0) return;
    const i = ((index % count) + count) % count;
    const match = getFindState(editor.state).matches[i];
    editor.chain().setActiveFindMatch(i).setTextSelection(match).scrollIntoView().run();
  };

  const next = () => goTo(activeIndex + 1);
  const prev = () => goTo(activeIndex - 1);

  const replaceOne = () => {
    if (!editor || count === 0) return;
    const match = getFindState(editor.state).matches[activeIndex];
    const chain = editor.chain().setTextSelection(match);
    if (replaceText) {
      chain.insertContent(replaceText);
    } else {
      chain.deleteSelection();
    }
    // Step past what was just inserted, otherwise a replacement containing
    // the query would be found again. The insertion always starts at
    // match.from — in suggesting mode TrackChanges keeps the original after
    // it as a pending deletion, which search already excludes.
    const insertionEnd = match.from + replaceText.length;
    chain.setActiveFindMatchAfter(insertionEnd).scrollIntoView().run();
  };

  const replaceAll = () => {
    if (!editor || count === 0) return;
    const matches = [...getFindState(editor.state).matches];
    const chain = editor.chain();
    // Back-to-front in one transaction: earlier positions are unaffected by
    // later replacements, and undo reverts the whole sweep at once.
    for (let i = matches.length - 1; i >= 0; i--) {
      chain.setTextSelection(matches[i]);
      if (replaceText) {
        chain.insertContent(replaceText);
      } else {
        chain.deleteSelection();
      }
    }
    chain.run();
  };

  const handleFindKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    }
    if (e.key === 'Escape') onClose();
  };

  const handleReplaceKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceOne();
    }
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="find-bar" role="search">
      <div className="find-bar-row">
        <input
          ref={findInputRef}
          className="find-bar-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleFindKeyDown}
          placeholder="Find"
          autoFocus
        />
        <span className="find-bar-count">
          {query ? (count > 0 ? `${activeIndex + 1} of ${count}` : 'No results') : ''}
        </span>
        <button
          className="find-bar-btn"
          onClick={prev}
          disabled={count === 0}
          title="Previous match (Shift+Enter)"
        >
          ↑
        </button>
        <button
          className="find-bar-btn"
          onClick={next}
          disabled={count === 0}
          title="Next match (Enter)"
        >
          ↓
        </button>
        <button className="find-bar-btn" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="find-bar-row">
        <input
          className="find-bar-input"
          type="text"
          value={replaceText}
          onChange={(e) => setReplaceText(e.target.value)}
          onKeyDown={handleReplaceKeyDown}
          placeholder="Replace with"
        />
        <button
          className="find-bar-btn find-bar-btn-text"
          onClick={replaceOne}
          disabled={count === 0}
        >
          Replace
        </button>
        <button
          className="find-bar-btn find-bar-btn-text"
          onClick={replaceAll}
          disabled={count === 0}
        >
          All
        </button>
      </div>
    </div>
  );
}
