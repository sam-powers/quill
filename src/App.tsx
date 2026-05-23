import { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import QuillEditor from './components/Editor';
import type { EditorRef, SelectionInfo } from './components/Editor';
import Toolbar from './components/Toolbar';
import Footer from './components/Footer';
import CommentLayer from './components/CommentLayer';
import SessionPicker from './components/SessionPicker';
import { useFileManager } from './hooks/useFileManager';
import { useComments } from './hooks/useComments';
import { useSuggestions } from './hooks/useSuggestions';
import { useClaudeReply } from './hooks/useClaudeReply';
import { getTrackedChanges } from './extensions/TrackChanges';
import type { AISessionBinding, SidecarFile, TrackedChangeInfo } from './types';
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
  const [editorKey] = useState(0);

  const [trackedChanges, setTrackedChanges] = useState<TrackedChangeInfo[]>([]);
  const [aiSession, setAISession] = useState<AISessionBinding | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { filePath, isDirty, markDirty, openFile, saveFile, saveFileAs, newFile } =
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
  const claudeReply = useClaudeReply({
    startAIReply,
    appendAIReplyChunk,
    finishAIReply,
    failAIReply,
    getDocMarkdown,
  });

  // Update macOS title bar dirty indicator
  useEffect(() => {
    const name = filePath ? filePath.split('/').pop() ?? 'Untitled' : 'Untitled';
    document.title = isDirty ? `${name} •` : name;
  }, [filePath, isDirty]);

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
  }, [openFile]);

  function loadFileResult(result: { content: string; sidecar: SidecarFile; filePath: string }) {
    editorRef.current?.setContent(result.content);
    setComments(result.sidecar.comments ?? []);
    setSuggestions(result.sidecar.suggestions ?? []);
    setAISession(result.sidecar.aiSession ?? null);
  }

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

  const handleAIReplyRequest = useCallback(
    (commentId: string, userText: string) => {
      if (!aiSession) return;
      const comment = comments.find((c) => c.id === commentId);
      if (!comment) return;
      // Fire-and-forget; useClaudeReply handles errors via failAIReply.
      void claudeReply.ask(comment, userText, aiSession);
    },
    [aiSession, comments, claudeReply],
  );

  const handlePickSession = useCallback((binding: AISessionBinding) => {
    setAISession(binding);
    setPickerOpen(false);
    markDirty();
  }, [markDirty]);

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
      />

      <div className="workspace" ref={scrollAreaRef}>
        <div className="editor-scroll-area">
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

        <CommentLayer
          editor={editor}
          comments={comments}
          activeCommentId={activeCommentId}
          selectionInfo={selectionInfo}
          author={AUTHOR}
          containerRef={commentLayerRef}
          trackedChanges={trackedChanges}
          isSuggesting={isSuggesting}
          aiSession={aiSession}
          onAddComment={handleAddComment}
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
