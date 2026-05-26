import { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import QuillEditor from './components/Editor';
import type { EditorRef, SelectionInfo } from './components/Editor';
import Toolbar from './components/Toolbar';
import Footer from './components/Footer';
import CommentLayer from './components/CommentLayer';
import AddCommentButton from './components/AddCommentButton';
import SessionPicker from './components/SessionPicker';
import { useFileManager } from './hooks/useFileManager';
import { useComments } from './hooks/useComments';
import { useSuggestions } from './hooks/useSuggestions';
import { useClaudeReply } from './hooks/useClaudeReply';
import { getTrackedChanges } from './extensions/TrackChanges';
import { planEdits, rangeText, resolveScopeRange } from './utils/trackedEdits';
import type {
  AISessionBinding,
  Comment,
  EditScope,
  QuillEdit,
  SidecarFile,
  TrackedChangeInfo,
} from './types';
import './App.css';

const CLAUDE_AUTHOR_ID = 'claude';

const AUTHOR = 'Anonymous';

export default function App() {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const editorRef = useRef<EditorRef>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] = useState<SelectionInfo | null>(
    null,
  );
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const commentLayerRef = useRef<HTMLDivElement>(null);
  const zoomWrapperRef = useRef<HTMLDivElement>(null);
  const [editorKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [, setScrollTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const [trackedChanges, setTrackedChanges] = useState<TrackedChangeInfo[]>([]);
  const [aiSession, setAISession] = useState<AISessionBinding | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A @claude request made before a session was linked; fired once the user
  // picks a session via the picker we open for them.
  const pendingAIRequestRef = useRef<{ commentId: string; userText: string } | null>(null);

  const { filePath, isDirty, markDirty, openFile, openFilePath, saveFile, saveFileAs, newFile } =
    useFileManager();
  const {
    comments,
    setComments,
    addComment,
    addReply,
    resolveComment,
    unresolveComment,
    deleteComment,
    startAIReply,
    appendAIReplyChunk,
    finishAIReply,
    failAIReply,
  } = useComments();
  const { suggestions, setSuggestions } = useSuggestions();

  const getDocMarkdown = useCallback(() => editorRef.current?.getMarkdown() ?? '', []);

  // Read the live document text for a comment's anchored range and its
  // enclosing paragraph, as plaintext (matching how Claude's `find` strings are
  // expected to match). Uses the current doc, not the stale anchorText snapshot.
  const getRangeTexts = useCallback(
    (comment: Comment) => {
      const doc = editor?.state.doc;
      if (!doc) return { highlightText: comment.anchorText, paragraphText: comment.anchorText };
      const size = doc.content.size;
      const cFrom = Math.min(comment.from, size);
      const cTo = Math.min(comment.to, size);
      const $from = doc.resolve(cFrom);
      const pFrom = $from.start($from.depth);
      const pTo = $from.end($from.depth);
      return {
        highlightText: rangeText(doc, cFrom, cTo),
        paragraphText: rangeText(doc, pFrom, pTo),
      };
    },
    [editor],
  );

  // Apply Claude's quote-based edits as tracked-change suggestions. Forces
  // suggesting mode on (under Claude's author id) for the duration, applies each
  // located edit back-to-front, then restores the user's prior mode/author.
  const applyTrackedEdits = useCallback(
    (comment: Comment, edits: QuillEdit[], scope: EditScope) => {
      const ed = editor;
      if (!ed) return { applied: 0, skipped: edits.length };

      const range = resolveScopeRange(ed.state.doc, comment, scope);
      const { placed, skipped } = planEdits(ed.state.doc, range.from, range.to, edits);

      const trackStorage = (
        ed.storage as unknown as Record<string, { enabled: boolean; authorID: string }>
      )['trackChanges'] as { enabled: boolean; authorID: string } | undefined;
      const priorEnabled = trackStorage?.enabled ?? false;
      const priorAuthor = trackStorage?.authorID ?? AUTHOR;

      let applied = 0;
      try {
        ed.commands.setTrackChangesEnabled(true);
        ed.commands.setTrackChangesAuthor(CLAUDE_AUTHOR_ID);
        for (const e of placed) {
          // Back-to-front: applying a later edit doesn't shift earlier offsets.
          ed.chain().setTextSelection({ from: e.from, to: e.to }).insertContent(e.replace).run();
          applied++;
        }
      } finally {
        ed.commands.setTrackChangesEnabled(priorEnabled);
        ed.commands.setTrackChangesAuthor(priorAuthor);
      }
      return { applied, skipped };
    },
    [editor],
  );

  const claudeReply = useClaudeReply({
    startAIReply,
    appendAIReplyChunk,
    finishAIReply,
    failAIReply,
    getDocMarkdown,
    getRangeTexts,
    applyTrackedEdits,
  });

  // Re-render on scroll so button top tracks live coordsAtPos
  useEffect(() => {
    const el = scrollAreaRef.current?.querySelector('.editor-scroll-area');
    if (!el) return;
    const onScroll = () => {
      setScrollTick((t) => t + 1);
      setScrollTop((el as HTMLElement).scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Update macOS title bar dirty indicator
  useEffect(() => {
    const name = filePath ? (filePath.split('/').pop() ?? 'Untitled') : 'Untitled';
    document.title = isDirty ? `${name} •` : name;
  }, [filePath, isDirty]);

  const loadFileResult = useCallback(
    (result: { content: string; sidecar: SidecarFile; filePath: string }) => {
      editorRef.current?.setContent(result.content);
      setComments(result.sidecar.comments ?? []);
      setSuggestions(result.sidecar.suggestions ?? []);
      setAISession(result.sidecar.aiSession ?? null);
    },
    [setComments, setSuggestions],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const handler = await listen<string>('deep-link-open', async (e) => {
          const path = e.payload;
          if (!path) return;
          const result = await openFilePath(path);
          if (result) loadFileResult(result);
        });
        unlisten = handler;
      } catch (e) {
        // Non-Tauri context (e.g. plain dev server) — ignore.
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [openFilePath, loadFileResult]);

  // Test escape hatch: bind an AI session without going through SessionPicker.
  useEffect(() => {
    const seed = typeof window !== 'undefined' ? window.__quillTestSession : undefined;
    if (seed) setAISession(seed);
  }, []);

  function getMarkdown(): string {
    return editorRef.current?.getMarkdown() ?? '';
  }

  const handleSaveAs = useCallback(async () => {
    await saveFileAs(getMarkdown(), comments, suggestions, aiSession);
  }, [saveFileAs, comments, suggestions, aiSession]);

  const handleSave = useCallback(async () => {
    if (!filePath) {
      await handleSaveAs();
      return;
    }
    await saveFile(getMarkdown(), comments, suggestions, aiSession);
  }, [filePath, saveFile, comments, suggestions, aiSession, handleSaveAs]);

  const handleOpen = useCallback(async () => {
    const result = await openFile();
    if (!result) return;
    loadFileResult(result);
  }, [openFile, loadFileResult]);

  const handleNew = useCallback(() => {
    newFile();
    editorRef.current?.setContent('');
    setComments([]);
    setSuggestions([]);
    setAISession(null);
  }, [newFile, setComments, setSuggestions]);

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
  }, [handleSave, handleSaveAs, handleOpen, handleNew]);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => setTrackedChanges(getTrackedChanges(editor));
    editor.on('update', refresh);
    refresh();
    return () => {
      editor.off('update', refresh);
    };
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

  const handleAcceptChange = useCallback(
    (id: string) => {
      editor?.commands.acceptChange(id);
    },
    [editor],
  );

  const handleRejectChange = useCallback(
    (id: string) => {
      editor?.commands.rejectChange(id);
    },
    [editor],
  );

  const handleAddComment = useCallback(
    (text: string) => {
      const sel = pendingCommentSelection ?? selectionInfo;
      if (!sel || !editor) return;
      const { from, to, text: anchorText } = sel;
      const comment = addComment(anchorText, from, to, AUTHOR);
      // Apply comment mark
      editor.chain().focus().setTextSelection({ from, to }).setComment(comment.id).run();
      // Add the initial "comment body" as the first reply if user typed text
      if (text) {
        // The comment has no body field — treat the text as the first reply
        setTimeout(() => {
          addReply(comment.id, text, AUTHOR);
        }, 0);
        // Tagging @claude in the initial comment should ask Claude too — same
        // as tagging it in a later reply. We pass the just-created comment
        // directly rather than going through handleAIReplyRequest, which looks
        // up `comments` (the new comment isn't in that array until next render).
        if (/@claude\b/i.test(text)) {
          if (aiSession) {
            void claudeReply.ask(comment, text, aiSession);
          } else {
            pendingAIRequestRef.current = { commentId: comment.id, userText: text };
            setPickerOpen(true);
          }
        }
      }
      setActiveCommentId(comment.id);
      setPendingCommentSelection(null);
      setSelectionInfo(null);
    },
    [pendingCommentSelection, selectionInfo, editor, addComment, addReply, aiSession, claudeReply],
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

  const handleAIReplyRequest = useCallback(
    (commentId: string, userText: string) => {
      const comment = comments.find((c) => c.id === commentId);
      if (!comment) return;
      if (!aiSession) {
        // No session linked yet — stash the request and prompt the user to
        // link one. handlePickSession fires the stashed request afterwards.
        pendingAIRequestRef.current = { commentId, userText };
        setPickerOpen(true);
        return;
      }
      // Fire-and-forget; useClaudeReply handles errors via failAIReply.
      void claudeReply.ask(comment, userText, aiSession);
    },
    [aiSession, comments, claudeReply],
  );

  const handlePickSession = useCallback(
    (binding: AISessionBinding) => {
      setAISession(binding);
      setPickerOpen(false);
      markDirty();
      // If the picker was opened because of a @claude request with no session,
      // fire that request now against the freshly-linked session.
      const pending = pendingAIRequestRef.current;
      pendingAIRequestRef.current = null;
      if (pending) {
        const comment = comments.find((c) => c.id === pending.commentId);
        if (comment) void claudeReply.ask(comment, pending.userText, binding);
      }
    },
    [markDirty, comments, claudeReply],
  );

  const handleUnlinkSession = useCallback(() => {
    setAISession(null);
    markDirty();
  }, [markDirty]);

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

        {selectionInfo &&
          (() => {
            const commentLayer = commentLayerRef.current;
            const commentLayerRect = commentLayer?.getBoundingClientRect();
            // Fixed positioning: use viewport coordinates directly, no zoom math needed
            const rawTop = editor
              ? editor.view.coordsAtPos(selectionInfo.from).top
              : selectionInfo.top;
            const wrapperRect = zoomWrapperRef.current?.getBoundingClientRect();
            const top = wrapperRect ? wrapperRect.top + (rawTop - wrapperRect.top) / zoom : rawTop;
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
          scrollTop={scrollTop}
          aiSession={aiSession}
          onReply={(id, text) => addReply(id, text, AUTHOR)}
          onAIReplyRequest={handleAIReplyRequest}
          onCancelAIReply={claudeReply.cancel}
          onOpenSessionPicker={() => setPickerOpen(true)}
          onResolve={resolveComment}
          onUnresolve={unresolveComment}
          onDelete={handleDeleteComment}
          onActivate={handleActivateComment}
          onAcceptChange={handleAcceptChange}
          onRejectChange={handleRejectChange}
        />
      </div>

      <Footer
        editor={editor}
        filePath={filePath}
        isSuggesting={isSuggesting}
        isDirty={isDirty}
        zoom={zoom}
        onZoomChange={setZoom}
        aiSession={aiSession}
        onOpenSessionPicker={() => setPickerOpen(true)}
        onUnlinkSession={handleUnlinkSession}
      />

      <SessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickSession}
      />
    </div>
  );
}
