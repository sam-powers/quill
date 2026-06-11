import { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import QuillEditor from './components/Editor';
import type { AnnotationClickInfo, EditorRef, SelectionInfo } from './components/Editor';
import Toolbar from './components/Toolbar';
import Footer from './components/Footer';
import CommentLayer from './components/CommentLayer';
import AddCommentButton from './components/AddCommentButton';
import SessionPicker from './components/SessionPicker';
import AppModal from './components/AppModal';
import { useFileManager } from './hooks/useFileManager';
import { useComments } from './hooks/useComments';
import { useSuggestions } from './hooks/useSuggestions';
import { useClaudeReply } from './hooks/useClaudeReply';
import { getTrackedChanges } from './extensions/TrackChanges';
import { findAnnotationRange } from './extensions/AnnotationFocus';
import type { AnnotationKind } from './extensions/AnnotationFocus';
import { planEdits, rangeText, resolveScopeRange } from './utils/trackedEdits';
import { basename, dirname } from './utils/path';
import { sidecarPath } from './utils/sidecarPath';
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
  // The one annotation (comment or suggestion) currently in focus: its card
  // is outlined and its text highlighted. Set by clicking either side.
  const [activeAnnotation, setActiveAnnotation] = useState<{
    kind: AnnotationKind;
    id: string;
  } | null>(null);
  const activeCommentId = activeAnnotation?.kind === 'comment' ? activeAnnotation.id : null;
  const activeSuggestionId = activeAnnotation?.kind === 'suggestion' ? activeAnnotation.id : null;
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
  // Whether a real native menu owns the file-operation accelerators. Defaults
  // to false so JS handles the shortcuts (dev server / e2e); flipped to true
  // once the backend confirms a native menu exists (see effect below).
  const [hasNativeMenu, setHasNativeMenu] = useState(false);

  const [trackedChanges, setTrackedChanges] = useState<TrackedChangeInfo[]>([]);
  const [aiSession, setAISession] = useState<AISessionBinding | null>(null);
  // Folder of reference documents linked to this doc (persisted in the
  // sidecar). Claude gets read access to it plus a file manifest per ask.
  const [contextFolder, setContextFolder] = useState<string | null>(null);
  // Ref mirror so useClaudeReply reads the live value at ask time without the
  // hook's options identity churning on every link/unlink.
  const contextFolderRef = useRef(contextFolder);
  contextFolderRef.current = contextFolder;
  const [pickerOpen, setPickerOpen] = useState(false);
  // A @claude request made before a session was linked; fired once the user
  // picks a session via the picker we open for them.
  const pendingAIRequestRef = useRef<{ commentId: string; userText: string } | null>(null);

  // In-app dialogs (window.alert/confirm are unreliable in Tauri webviews):
  // a notice with a single OK, and the unsaved-changes guard holding the
  // destructive action to run once the user decides what to do with the doc.
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [discardGuard, setDiscardGuard] = useState<{ run: () => void } | null>(null);

  const showError = useCallback(
    (title: string, message: string) => setNotice({ title, message }),
    [],
  );

  const { filePath, isDirty, markDirty, openFile, openFilePath, saveFile, saveFileAs, newFile } =
    useFileManager(showError);

  // Live dirty flag for listeners registered once (close-requested, deep-link)
  // so they don't need to re-register on every edit.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // Run `action` immediately if there are no unsaved changes; otherwise ask
  // the user (Save / Don't Save / Cancel) and run it once the doc is safe.
  const guardDirty = useCallback((action: () => void) => {
    if (!isDirtyRef.current) {
      action();
    } else {
      setDiscardGuard({ run: action });
    }
  }, []);
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
    getContextFolder: useCallback(() => contextFolderRef.current, []),
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
    const name = filePath ? basename(filePath) : 'Untitled';
    document.title = isDirty ? `${name} •` : name;
  }, [filePath, isDirty]);

  const loadFileResult = useCallback(
    (result: {
      content: string;
      sidecar: SidecarFile;
      filePath: string;
      sidecarError?: string | null;
    }) => {
      editorRef.current?.setContent(result.content);
      setComments(result.sidecar.comments ?? []);
      setSuggestions(result.sidecar.suggestions ?? []);
      const session = result.sidecar.aiSession ?? null;
      // A sidecar that exists but failed to parse means real comments/suggestions
      // may be at risk. Warn loudly; the save path keeps the on-disk file intact.
      if (result.sidecarError) {
        const name = sidecarPath(result.filePath);
        setNotice({
          title: 'Comments file could not be read',
          message:
            `${name}\n\n${result.sidecarError}\n\n` +
            `Your comments and suggestions are NOT loaded, but the file on disk is preserved. ` +
            `Saving will not overwrite it. Fix or remove the file, then reopen.`,
        });
      }
      setAISession(session);
      setContextFolder(result.sidecar.contextFolder ?? null);
      // Force the session choice up front: if we opened a non-empty doc with no
      // linked Claude session, surface the picker so the user binds one (and can
      // then call @claude from within the doc). Auto-bind is intentionally not
      // attempted — the user picks.
      if (!session && result.content.trim().length > 0) {
        setPickerOpen(true);
      }
    },
    [setComments, setSuggestions],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { invoke } = await import('@tauri-apps/api/core');
        const handler = await listen<string>('deep-link-open', (e) => {
          const path = e.payload;
          if (!path) return;
          // A deep link can arrive while the user has unsaved work in another
          // document — that replacement is as destructive as File → Open.
          guardDirty(() => {
            void (async () => {
              const result = await openFilePath(path);
              if (result) loadFileResult(result);
            })();
          });
        });
        unlisten = handler;

        // Cold start: the launch URL was emitted before this listener existed,
        // so it was dropped. Drain the buffered path the backend stashed.
        const pending = await invoke<string | null>('take_pending_deep_link');
        if (pending) {
          const result = await openFilePath(pending);
          if (result) loadFileResult(result);
        }
      } catch (e) {
        // Non-Tauri context (e.g. plain dev server) — ignore.
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [openFilePath, loadFileResult, guardDirty]);

  // Test escape hatch: bind an AI session without going through SessionPicker.
  useEffect(() => {
    const seed = typeof window !== 'undefined' ? window.__quillTestSession : undefined;
    if (seed) setAISession(seed);
  }, []);

  function getMarkdown(): string {
    return editorRef.current?.getMarkdown() ?? '';
  }

  const handleSaveAs = useCallback(async () => {
    return saveFileAs(getMarkdown(), comments, suggestions, aiSession, contextFolder);
  }, [saveFileAs, comments, suggestions, aiSession, contextFolder]);

  const handleSave = useCallback(async () => {
    if (!filePath) {
      return handleSaveAs();
    }
    return saveFile(getMarkdown(), comments, suggestions, aiSession, contextFolder);
  }, [filePath, saveFile, comments, suggestions, aiSession, contextFolder, handleSaveAs]);

  const performOpen = useCallback(async () => {
    const result = await openFile();
    if (!result) return;
    loadFileResult(result);
  }, [openFile, loadFileResult]);

  const performNew = useCallback(() => {
    newFile();
    editorRef.current?.setContent('');
    setComments([]);
    setSuggestions([]);
    setAISession(null);
    setContextFolder(null);
  }, [newFile, setComments, setSuggestions]);

  // New / Open replace the document, so both run through the unsaved-changes
  // guard. Quit goes through the same guard, then asks the backend to exit
  // (the menu's Quit item is custom — emitting an event instead of quitting —
  // precisely so this guard gets a chance to run).
  const handleOpen = useCallback(
    () => guardDirty(() => void performOpen()),
    [guardDirty, performOpen],
  );

  const handleNew = useCallback(() => guardDirty(performNew), [guardDirty, performNew]);

  const handleQuit = useCallback(() => {
    guardDirty(() => {
      void (async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('exit_app');
      })();
    });
  }, [guardDirty]);

  // Guard the native window close (traffic-light button): when dirty, prevent
  // the close and route through the same Save / Don't Save / Cancel dialog.
  // Outside Tauri (dev server / e2e) getCurrentWindow() throws and no guard is
  // installed.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested((event) => {
          if (!isDirtyRef.current) return;
          event.preventDefault();
          setDiscardGuard({ run: () => void win.destroy() });
        });
      } catch {
        // Non-Tauri context.
      }
    })();
    return () => unlisten?.();
  }, []);

  // Native application menu (File → New/Open/Save/Save As). The Rust side owns
  // the accelerators and emits an event per item; we map each to the same
  // handler the in-app shortcuts use. In a non-Tauri context (plain dev server)
  // the listeners simply never fire.
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const wire = async (event: string, fn: () => void) => {
          unlisteners.push(await listen(event, () => fn()));
        };
        await wire('menu-new', handleNew);
        await wire('menu-open', handleOpen);
        await wire('menu-save', () => void handleSave());
        await wire('menu-save-as', () => void handleSaveAs());
        await wire('menu-quit', handleQuit);
      } catch {
        // Non-Tauri context — no native menu.
      }
    })();
    return () => unlisteners.forEach((u) => u());
  }, [handleNew, handleOpen, handleSave, handleSaveAs, handleQuit]);

  // Detect whether a real native menu is present. We can't infer this from
  // `__TAURI_INTERNALS__`: the e2e suite mocks that global but has no native
  // menu, so it must keep handling shortcuts in JS. The `has_native_menu`
  // command exists only in the real backend (the e2e IPC mock returns null for
  // it), making it the authoritative signal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const native = await invoke<boolean>('has_native_menu');
        if (!cancelled) setHasNativeMenu(native === true);
      } catch {
        // Non-Tauri context, or command absent (e2e) — keep JS shortcuts.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyboard shortcuts. Under Tauri the native menu owns the file-operation
  // accelerators (New/Open/Save/Save As), so we skip them here to avoid
  // double-firing (e.g. opening two file dialogs). Outside Tauri (plain dev
  // server / e2e) there is no native menu, so we keep handling them in JS.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) {
        if (e.key === 'Escape') setActiveAnnotation(null);
        return;
      }

      if (!hasNativeMenu) {
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
  }, [handleSave, handleSaveAs, handleOpen, handleNew, hasNativeMenu]);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => setTrackedChanges(getTrackedChanges(editor));
    editor.on('update', refresh);
    refresh();
    return () => {
      editor.off('update', refresh);
    };
  }, [editor]);

  // Mirror the active annotation into the editor as a focus decoration so
  // its text is visibly highlighted alongside the outlined card.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (activeAnnotation) {
      editor.commands.setAnnotationFocus(activeAnnotation.kind, activeAnnotation.id);
    } else {
      editor.commands.clearAnnotationFocus();
    }
  }, [editor, activeAnnotation]);

  // Drop the focus when the annotation it points at goes away (resolved,
  // accepted, rejected, deleted) — a stale focus would point at nothing.
  const clearActiveIf = useCallback((kind: AnnotationKind, id: string) => {
    setActiveAnnotation((prev) => (prev?.kind === kind && prev.id === id ? null : prev));
  }, []);

  // A click in the editor reports every annotation layered under it (or none —
  // clicking plain text dismisses the focus). Focus the innermost one, by
  // smallest live range, like Google Docs.
  const handleAnnotationClick = useCallback(
    ({ commentIds, suggestionIds }: AnnotationClickInfo) => {
      const doc = editor?.state.doc;
      if (!doc) return;
      const candidates: { kind: AnnotationKind; id: string; size: number }[] = [];
      for (const id of commentIds) {
        const range = findAnnotationRange(doc, 'comment', id);
        if (range) candidates.push({ kind: 'comment', id, size: range.to - range.from });
      }
      for (const id of suggestionIds) {
        const range = findAnnotationRange(doc, 'suggestion', id);
        if (range) candidates.push({ kind: 'suggestion', id, size: range.to - range.from });
      }
      if (candidates.length === 0) {
        setActiveAnnotation(null);
        return;
      }
      candidates.sort((a, b) => a.size - b.size);
      const winner = candidates[0];
      // A replacement half promotes to its pairId, so the whole pair — old
      // and new text — focuses together along with its single card.
      if (winner.kind === 'suggestion') {
        const pairId = trackedChanges.find((c) => c.id === winner.id)?.pairId;
        if (pairId) {
          setActiveAnnotation({ kind: 'suggestion', id: pairId });
          return;
        }
      }
      setActiveAnnotation({ kind: winner.kind, id: winner.id });
    },
    [editor, trackedChanges],
  );

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
      clearActiveIf('suggestion', id);
    },
    [editor, clearActiveIf],
  );

  const handleRejectChange = useCallback(
    (id: string) => {
      editor?.commands.rejectChange(id);
      clearActiveIf('suggestion', id);
    },
    [editor, clearActiveIf],
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
        // The comment has no body field — treat the text as the first reply.
        // Must run before claudeReply.ask() queues its pending AI reply, or
        // Claude's answer renders above the user's question in the thread.
        addReply(comment.id, text, AUTHOR);
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
      setActiveAnnotation({ kind: 'comment', id: comment.id });
      setPendingCommentSelection(null);
      setSelectionInfo(null);
    },
    [pendingCommentSelection, selectionInfo, editor, addComment, addReply, aiSession, claudeReply],
  );

  const handleSelectionChange = useCallback((info: SelectionInfo | null) => {
    setSelectionInfo(info);
    if (info) setPendingCommentSelection(info);
  }, []);

  // Keep the target range visibly highlighted while the comment composer is
  // open (the native selection highlight disappears when the textarea takes
  // focus). Rendered as a decoration, so it never dirties the document; it
  // hands off to the real comment mark on submit and vanishes on cancel.
  const handleComposingChange = useCallback(
    (composing: boolean) => {
      if (!editor || editor.isDestroyed) return;
      if (composing) {
        const sel = pendingCommentSelection ?? selectionInfo;
        if (sel) editor.commands.setPendingCommentRange(sel.from, sel.to);
      } else {
        editor.commands.clearPendingCommentRange();
      }
    },
    [editor, pendingCommentSelection, selectionInfo],
  );

  const handleDeleteComment = useCallback(
    (commentId: string) => {
      deleteComment(commentId);
      editor?.commands.unsetComment(commentId);
      clearActiveIf('comment', commentId);
    },
    [deleteComment, editor, clearActiveIf],
  );

  // Resolving hides the card (unless "Show resolved" is on), so it also
  // drops the focus rather than leaving an outline on a vanished card.
  const handleResolveComment = useCallback(
    (commentId: string) => {
      resolveComment(commentId);
      clearActiveIf('comment', commentId);
    },
    [resolveComment, clearActiveIf],
  );

  const handleActivateComment = useCallback(
    (commentId: string) => {
      setActiveAnnotation((prev) =>
        prev?.kind === 'comment' && prev.id === commentId
          ? null
          : { kind: 'comment', id: commentId },
      );
      // Scroll the anchor into view
      if (editor) {
        const dom = editor.view.dom.querySelector(`[data-comment-id="${commentId}"]`);
        dom?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },
    [editor],
  );

  const handleActivateSuggestion = useCallback(
    (id: string) => {
      setActiveAnnotation((prev) =>
        prev?.kind === 'suggestion' && prev.id === id ? null : { kind: 'suggestion', id },
      );
      if (editor) {
        // `id` may be a replacement's pairId, which no data-change-id
        // attribute carries — resolve the live range and scroll to its start.
        const range = findAnnotationRange(editor.state.doc, 'suggestion', id);
        if (range) {
          const { node } = editor.view.domAtPos(range.from);
          const el = node instanceof HTMLElement ? node : node.parentElement;
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
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

  const handleLinkContextFolder = useCallback(() => {
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const folder = await invoke<string | null>('show_folder_dialog');
        if (folder) {
          setContextFolder(folder);
          markDirty();
        }
      } catch (e) {
        console.error('Failed to pick context folder:', e);
        showError('Could not link folder', String(e));
      }
    })();
  }, [markDirty, showError]);

  const handleUnlinkContextFolder = useCallback(() => {
    setContextFolder(null);
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
              onAnnotationClick={handleAnnotationClick}
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
                onComposingChange={handleComposingChange}
              />
            );
          })()}

        <CommentLayer
          editor={editor}
          comments={comments}
          activeCommentId={activeCommentId}
          activeSuggestionId={activeSuggestionId}
          containerRef={commentLayerRef}
          trackedChanges={trackedChanges}
          scrollTop={scrollTop}
          onReply={(id, text) => addReply(id, text, AUTHOR)}
          onAIReplyRequest={handleAIReplyRequest}
          onCancelAIReply={claudeReply.cancel}
          onOpenSessionPicker={() => setPickerOpen(true)}
          onResolve={handleResolveComment}
          onUnresolve={unresolveComment}
          onDelete={handleDeleteComment}
          onActivate={handleActivateComment}
          onActivateSuggestion={handleActivateSuggestion}
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
        contextFolder={contextFolder}
        onLinkContextFolder={handleLinkContextFolder}
        onUnlinkContextFolder={handleUnlinkContextFolder}
      />

      <SessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickSession}
        newSessionCwd={filePath ? dirname(filePath) : null}
      />

      {discardGuard && (
        <AppModal
          title="Unsaved changes"
          message="This document has unsaved changes. Save them before continuing?"
          buttons={[
            {
              label: 'Save',
              kind: 'primary',
              onClick: async () => {
                // Stays open if the save dialog is cancelled or the save
                // fails — the unsaved document is still at stake.
                const saved = await handleSave();
                if (saved) {
                  setDiscardGuard(null);
                  discardGuard.run();
                }
              },
            },
            {
              label: "Don't Save",
              kind: 'danger',
              onClick: () => {
                setDiscardGuard(null);
                discardGuard.run();
              },
            },
            {
              label: 'Cancel',
              kind: 'ghost',
              onClick: () => setDiscardGuard(null),
            },
          ]}
        />
      )}

      {notice && (
        <AppModal
          title={notice.title}
          message={notice.message}
          buttons={[{ label: 'OK', kind: 'primary', onClick: () => setNotice(null) }]}
        />
      )}
    </div>
  );
}
