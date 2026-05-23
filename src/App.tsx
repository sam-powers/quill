import { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import QuillEditor from './components/Editor';
import type { EditorRef, SelectionInfo } from './components/Editor';
import Toolbar from './components/Toolbar';
import Footer from './components/Footer';
import CommentLayer from './components/CommentLayer';
import AddCommentButton from './components/AddCommentButton';
import { useFileManager } from './hooks/useFileManager';
import { useComments } from './hooks/useComments';
import { useSuggestions } from './hooks/useSuggestions';
import { getTrackedChanges } from './extensions/TrackChanges';
import type { SidecarFile, TrackedChangeInfo } from './types';
import './App.css';

const AUTHOR = 'Anonymous';

export default function App() {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const editorRef = useRef<EditorRef>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] = useState<SelectionInfo | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const commentLayerRef = useRef<HTMLDivElement>(null);
  const zoomWrapperRef = useRef<HTMLDivElement>(null);
  const [editorKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [, setScrollTick] = useState(0);

  const [trackedChanges, setTrackedChanges] = useState<TrackedChangeInfo[]>([]);

  const { filePath, isDirty, markDirty, openFile, saveFile, saveFileAs, newFile } =
    useFileManager();
  const { comments, setComments, addComment, addReply, resolveComment, unresolveComment, deleteComment } =
    useComments();
  const { suggestions, setSuggestions } =
    useSuggestions();

// Re-render on scroll so button top tracks live coordsAtPos
  useEffect(() => {
    const el = scrollAreaRef.current?.querySelector('.editor-scroll-area');
    if (!el) return;
    const onScroll = () => setScrollTick((t) => t + 1);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Update macOS title bar dirty indicator
  useEffect(() => {
    const name = filePath ? filePath.split('/').pop() ?? 'Untitled' : 'Untitled';
    document.title = isDirty ? `${name} •` : name;
  }, [filePath, isDirty]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      if (e.key === 's' && e.shiftKey) {
        e.preventDefault();
        handleSaveAs();
        return;
      }
      if (e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.key === 'o') {
        e.preventDefault();
        handleOpen();
        return;
      }
      if (e.key === 'n') {
        e.preventDefault();
        handleNew();
        return;
      }
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoom((z) => Math.min(2.4, Math.round((z + 0.12) * 100) / 100));
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(0.6, Math.round((z - 0.12) * 100) / 100));
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
        return;
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  function getMarkdown(): string {
    return editorRef.current?.getMarkdown() ?? '';
  }

  async function handleSave() {
    if (!filePath) {
      await handleSaveAs();
      return;
    }
    await saveFile(getMarkdown(), comments, suggestions);
  }

  async function handleSaveAs() {
    await saveFileAs(getMarkdown(), comments, suggestions);
  }

  async function handleOpen() {
    const result = await openFile();
    if (!result) return;
    loadFileResult(result);
  }

  function loadFileResult(result: { content: string; sidecar: SidecarFile; filePath: string }) {
    editorRef.current?.setContent(result.content);
    setComments(result.sidecar.comments ?? []);
    setSuggestions(result.sidecar.suggestions ?? []);
  }

  function handleNew() {
    newFile();
    editorRef.current?.setContent('');
    setComments([]);
    setSuggestions([]);
  }

  useEffect(() => {
    if (!editor) return;
    const refresh = () => setTrackedChanges(getTrackedChanges(editor));
    editor.on('update', refresh);
    refresh();
    return () => { editor.off('update', refresh); };
  }, [editor]);

  function handleToggleSuggesting() {
    setIsSuggesting((v) => !v);
  }

  function handleAcceptAll() {
    editor?.commands.acceptAllChanges();
  }

  function handleRejectAll() {
    editor?.commands.rejectAllChanges();
  }

  const handleAcceptChange = useCallback((id: string) => {
    editor?.commands.acceptChange(id);
  }, [editor]);

  const handleRejectChange = useCallback((id: string) => {
    editor?.commands.rejectChange(id);
  }, [editor]);

  const handleAddComment = useCallback(
    (text: string) => {
      const sel = pendingCommentSelection ?? selectionInfo;
      if (!sel || !editor) return;
      const { from, to, text: anchorText } = sel;
      const comment = addComment(anchorText, from, to, AUTHOR);
      // Apply comment mark
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .setComment(comment.id)
        .run();
      // Add the initial "comment body" as the first reply if user typed text
      if (text) {
        // The comment has no body field — treat the text as the first reply
        setTimeout(() => {
          addReply(comment.id, text, AUTHOR);
        }, 0);
      }
      setActiveCommentId(comment.id);
      setPendingCommentSelection(null);
      setSelectionInfo(null);
    },
    [pendingCommentSelection, selectionInfo, editor, addComment, addReply],
  );

  const handleSelectionChange = useCallback((info: SelectionInfo | null) => {
    setSelectionInfo(info);
    if (info) setPendingCommentSelection(info);
  }, []);

  const handleDeleteComment = useCallback(
    (commentId: string) => {
      deleteComment(commentId);
      editor?.commands.unsetComment(commentId);
      if (activeCommentId === commentId) setActiveCommentId(null);
    },
    [deleteComment, editor, activeCommentId],
  );

  const handleActivateComment = useCallback(
    (commentId: string) => {
      setActiveCommentId((prev) => (prev === commentId ? null : commentId));
      // Scroll the anchor into view
      if (editor) {
        const dom = editor.view.dom.querySelector(`[data-comment-id="${commentId}"]`);
        dom?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },
    [editor],
  );

  // Re-anchor comments after content loads by fuzzy-matching anchorText
  // (basic implementation: positions from sidecar are trusted on first load)

  return (
    <div className="app">
      <Toolbar
        editor={editor}
        isSuggesting={isSuggesting}
        onToggleSuggesting={handleToggleSuggesting}
        onAcceptAll={handleAcceptAll}
        onRejectAll={handleRejectAll}
        hasPendingChanges={trackedChanges.some((c) => c.status === 'pending')}
      />

      <div className="workspace" ref={scrollAreaRef}>
        <div className="editor-scroll-area">
          <div className="editor-page-zoom-wrapper" ref={zoomWrapperRef} style={{ zoom }}>
          <QuillEditor
            key={editorKey}
            ref={editorRef}
            initialContent=""
            isSuggesting={isSuggesting}
            authorID={AUTHOR}
            onUpdate={markDirty}
            onSelectionChange={handleSelectionChange}
            onEditorReady={setEditor}
          />
          </div>
        </div>

        {selectionInfo && (() => {
          const commentLayer = commentLayerRef.current;
          const commentLayerRect = commentLayer?.getBoundingClientRect();
          // Fixed positioning: use viewport coordinates directly, no zoom math needed
          const rawTop = editor ? editor.view.coordsAtPos(selectionInfo.from).top : selectionInfo.top;
          const wrapperRect = zoomWrapperRef.current?.getBoundingClientRect();
          const top = wrapperRect
            ? wrapperRect.top + (rawTop - wrapperRect.top) / zoom
            : rawTop;
          const left = commentLayerRect ? commentLayerRect.left - 36 : undefined;
          return (
            <AddCommentButton
              top={top}
              left={left}
              visible
              author={AUTHOR}
              onAdd={handleAddComment}
            />
          );
        })()}

        <CommentLayer
          editor={editor}
          comments={comments}
          activeCommentId={activeCommentId}
          containerRef={commentLayerRef}
          trackedChanges={trackedChanges}
          onReply={(id, text) => addReply(id, text, AUTHOR)}
          onResolve={resolveComment}
          onUnresolve={unresolveComment}
          onDelete={handleDeleteComment}
          onActivate={handleActivateComment}
          onAcceptChange={handleAcceptChange}
          onRejectChange={handleRejectChange}
        />
      </div>

      <Footer editor={editor} filePath={filePath} isSuggesting={isSuggesting} isDirty={isDirty} zoom={zoom} onZoomChange={setZoom} />
    </div>
  );
}
