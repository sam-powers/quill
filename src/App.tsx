import { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import QuillEditor from './components/Editor';
import type { AnnotationClickInfo, EditorRef, SelectionInfo } from './components/Editor';
import Toolbar from './components/Toolbar';
import Footer from './components/Footer';
import CommentLayer, { computeBottomSpacer } from './components/CommentLayer';
import AddCommentButton from './components/AddCommentButton';
import SessionPicker from './components/SessionPicker';
import FindBar from './components/FindBar';
import AppModal from './components/AppModal';
import ReviewModal from './components/ReviewModal';
import UpdateBanner from './components/UpdateBanner';
import { useFileManager, stripTransientReplyState } from './hooks/useFileManager';
import { useDraftAutosave } from './hooks/useDraftAutosave';
import type { DraftSnapshot } from './hooks/useDraftAutosave';
import { useUpdateCheck } from './hooks/useUpdateCheck';
import { useComments } from './hooks/useComments';
import { useSuggestions } from './hooks/useSuggestions';
import { useClaudeReply } from './hooks/useClaudeReply';
import { useDocumentReview } from './hooks/useDocumentReview';
import type { ReviewOptions } from './hooks/useDocumentReview';
import { getTrackedChanges } from './extensions/TrackChanges';
import { setImageBaseDir } from './extensions/MarkdownImage';
import { detectLossyConstructs } from './utils/markdownFidelity';
import { findAnnotationRange } from './extensions/AnnotationFocus';
import type { AnnotationKind } from './extensions/AnnotationFocus';
import { locateEdit, planEdits, rangeText, resolveScopeRange } from './utils/trackedEdits';
import { basename, dirname } from './utils/path';
import {
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  syncRecentMenu,
} from './utils/recentFiles';
import { sidecarPath } from './utils/sidecarPath';
import type {
  AISessionBinding,
  Comment,
  DraftFile,
  EditScope,
  QuillEdit,
  SidecarFile,
  TrackedChangeInfo,
} from './types';
import './App.css';

const CLAUDE_AUTHOR_ID = 'claude';

const AUTHOR = 'Anonymous';

// Breathing room (px) left above/below a card when it's scrolled into view, and
// the extra scroll range the bottom spacer adds past the lowest card's bottom.
const CARD_SCROLL_MARGIN = 24;

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
  const [editorKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [scrollTick, setScrollTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  // Lowest comment/suggestion card bottom (document space), reported by
  // CommentLayer. Drives `bottomSpacer` so a below-fold card can be scrolled
  // fully into view (see the effect below).
  const [maxCardBottom, setMaxCardBottom] = useState(0);
  const [bottomSpacer, setBottomSpacer] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  // Whether a real native menu owns the file-operation accelerators. Defaults
  // to false so JS handles the shortcuts (dev server / e2e); flipped to true
  // once the backend confirms a native menu exists (see effect below).
  const [hasNativeMenu, setHasNativeMenu] = useState(false);

  // Newer published release, if any (production builds check GitHub once on
  // launch). The banner links out; the user installs when they choose.
  const updateCheck = useUpdateCheck({ currentVersion: __APP_VERSION__ });

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
  // The "Review full document" modal, plus a review request made before a
  // session was linked (resumed once the user picks one, like AI replies).
  const [reviewOpen, setReviewOpen] = useState(false);
  const pendingReviewRef = useRef(false);

  // In-app dialogs (window.alert/confirm are unreliable in Tauri webviews):
  // a notice with a single OK, and the unsaved-changes guard holding the
  // destructive action to run once the user decides what to do with the doc.
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [discardGuard, setDiscardGuard] = useState<{ run: () => void } | null>(null);

  const showError = useCallback(
    (title: string, message: string) => setNotice({ title, message }),
    [],
  );

  const {
    filePath,
    isDirty,
    markDirty,
    openFile,
    openFilePath,
    saveFile,
    saveFileAs,
    newFile,
    restoreDraft,
  } = useFileManager(showError);

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
    cancelAIReply,
    retryAIReply,
  } = useComments();
  const { suggestions, setSuggestions } = useSuggestions();

  const getDocMarkdown = useCallback(() => editorRef.current?.getMarkdown() ?? '', []);

  // Crash-recovery autosave: while dirty, the document (plus annotations and
  // links) is snapshotted to draft.json every few seconds; a clean state
  // deletes it. On launch we offer any leftover draft for recovery below.
  const getDraftSnapshot = useCallback(
    (): DraftSnapshot => ({
      filePath,
      content: getDocMarkdown(),
      // draft.json is a second on-disk persistence path, so it needs the same
      // transient-reply strip the sidecar gets — otherwise a crash mid-stream
      // recovers a stuck spinner / dead-Retry card the fresh hook can't drive.
      comments: stripTransientReplyState(comments),
      suggestions,
      aiSession,
      contextFolder,
    }),
    [filePath, getDocMarkdown, comments, suggestions, aiSession, contextFolder],
  );
  const { readDraft, deleteDraft } = useDraftAutosave({
    isDirty,
    getSnapshot: getDraftSnapshot,
  });

  // A draft left behind by a crashed/killed run, awaiting the user's
  // Recover / Discard decision.
  const [recoveryDraft, setRecoveryDraft] = useState<DraftFile | null>(null);

  useEffect(() => {
    void (async () => {
      const draft = await readDraft();
      if (draft) setRecoveryDraft(draft);
    })();
  }, [readDraft]);

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
    (comment: { from: number; to: number }, edits: QuillEdit[], scope: EditScope) => {
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
    cancelAIReply,
    retryAIReply,
    getDocMarkdown,
    getRangeTexts,
    applyTrackedEdits,
    getContextFolder: useCallback(() => contextFolderRef.current, []),
  });

  // Doc-scoped wrapper for the full-document review: the same tracked-edit
  // pipeline, always over the whole document (the anchor range is unused).
  const applyDocTrackedEdits = useCallback(
    (edits: QuillEdit[]) => applyTrackedEdits({ from: 0, to: 0 }, edits, 'doc'),
    [applyTrackedEdits],
  );

  // Anchor one Claude review comment: locate `find` in the whole document,
  // mark the range, and attach the remark as a finished AI reply so it renders
  // with the Claude styling. False when the quote isn't found verbatim.
  const addClaudeComment = useCallback(
    (find: string, body: string): boolean => {
      const ed = editor;
      if (!ed || find.trim().length === 0 || body.trim().length === 0) return false;
      const doc = ed.state.doc;
      const range = locateEdit(doc, 0, doc.content.size, find);
      if (!range || range.from === range.to) return false;
      const comment = addComment(
        rangeText(doc, range.from, range.to),
        range.from,
        range.to,
        'Claude',
      );
      ed.chain().setTextSelection({ from: range.from, to: range.to }).setComment(comment.id).run();
      const replyId = startAIReply(comment.id);
      appendAIReplyChunk(comment.id, replyId, body);
      finishAIReply(comment.id, replyId);
      return true;
    },
    [editor, addComment, startAIReply, appendAIReplyChunk, finishAIReply],
  );

  const docReview = useDocumentReview({
    getDocMarkdown,
    getContextFolder: useCallback(() => contextFolderRef.current, []),
    applyTrackedEdits: applyDocTrackedEdits,
    addClaudeComment,
  });

  // Re-render on scroll so the comment column tracks the document (cards are
  // translated by scrollTop) and the add-comment button tracks coordsAtPos.
  // Keyed on `editor` so the listener attaches once the editor subtree has
  // mounted `.editor-scroll-area` — with an empty dep array the query could
  // run before the element existed, leaving scrollTop stuck at 0 (cards never
  // move on scroll).
  useEffect(() => {
    const el = scrollAreaRef.current?.querySelector('.editor-scroll-area');
    if (!el) return;
    const onScroll = () => {
      setScrollTick((t) => t + 1);
      setScrollTop((el as HTMLElement).scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Sync once on attach in case the document is already scrolled.
    setScrollTop((el as HTMLElement).scrollTop);
    return () => el.removeEventListener('scroll', onScroll);
  }, [editor]);

  // Size the bottom spacer so the lowest comment/suggestion card can be
  // scrolled fully into view. The card column is overflow-hidden and its cards
  // paint at `nudgedTop − scrollTop`, so a card whose bottom sits past the
  // document's own content is unreachable without extra scroll range. We
  // measure the scroll area's *natural* content height (scrollHeight minus the
  // spacer we already added, so the spacer's own height doesn't feed back) and
  // extend it just enough via `computeBottomSpacer`. A `prev === next` guard
  // keeps this from looping. Normal docs get spacer 0 (no trailing dead space).
  useEffect(() => {
    const el = scrollAreaRef.current?.querySelector('.editor-scroll-area') as HTMLElement | null;
    if (!el) return;
    const baseContentHeight = el.scrollHeight - bottomSpacer;
    const next = computeBottomSpacer(maxCardBottom, baseContentHeight, CARD_SCROLL_MARGIN);
    setBottomSpacer((prev) => (prev === next ? prev : next));
  }, [maxCardBottom, bottomSpacer, scrollTick, zoom, editor]);

  // Re-render once after a zoom change so the add-comment button re-reads
  // coordsAtPos: the render that applies the new zoom still measures the old
  // layout (the style lands in the DOM after render), so without this the
  // button sits one zoom level behind.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setScrollTick((t) => t + 1));
    return () => cancelAnimationFrame(raf);
  }, [zoom]);

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
      // Must precede setContent: ProseMirror draws the document (and thus
      // resolves image srcs) synchronously when content is set.
      setImageBaseDir(dirname(result.filePath));
      void syncRecentMenu(addRecentFile(result.filePath));
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
      } else {
        // Warn before the user edits, not after they've saved over the file.
        const lossy = detectLossyConstructs(result.content);
        if (lossy.length > 0) {
          setNotice({
            title: 'Some formatting may not survive',
            message:
              `This file contains ${lossy.join(' and ')}, which Quill cannot edit yet. ` +
              `Those parts will be altered if you save this document from Quill. ` +
              `To keep them intact, edit this file in another tool.`,
          });
        }
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
    const path = await saveFileAs(getMarkdown(), comments, suggestions, aiSession, contextFolder);
    // The document gained (or moved) a directory — relative image paths now
    // resolve against it for anything drawn from here on.
    if (path) {
      setImageBaseDir(dirname(path));
      void syncRecentMenu(addRecentFile(path));
    }
    return path;
  }, [saveFileAs, comments, suggestions, aiSession, contextFolder]);

  const handleSave = useCallback(async () => {
    if (!filePath) {
      return handleSaveAs();
    }
    return saveFile(getMarkdown(), comments, suggestions, aiSession, contextFolder);
  }, [filePath, saveFile, comments, suggestions, aiSession, contextFolder, handleSaveAs]);

  // Export to PDF is print-to-PDF: the `@media print` rules in App.css strip
  // the chrome and the track-changes/comment markup, leaving a clean copy of
  // the document, and the OS print dialog offers "Save as PDF". We set
  // document.title first so that dialog defaults the filename to the doc's
  // name instead of "Quill"; it's restored after the dialog returns
  // (window.print blocks synchronously until then).
  const handleExportPdf = useCallback(() => {
    const docName = filePath ? basename(filePath).replace(/\.md$/i, '') : 'Untitled';
    const prevTitle = document.title;
    document.title = docName;
    try {
      window.print();
    } finally {
      document.title = prevTitle;
    }
  }, [filePath]);

  const performOpen = useCallback(async () => {
    const result = await openFile();
    if (!result) return;
    loadFileResult(result);
  }, [openFile, loadFileResult]);

  const performNew = useCallback(() => {
    newFile();
    setImageBaseDir(null);
    editorRef.current?.setContent('');
    setComments([]);
    setSuggestions([]);
    setAISession(null);
    setContextFolder(null);
  }, [newFile, setComments, setSuggestions]);

  // Adopt the recovered draft as the open (dirty) document. The draft's
  // content is newer than anything on disk, so nothing is read from the file —
  // the user decides whether to save over it.
  const handleRecoverDraft = useCallback(() => {
    const draft = recoveryDraft;
    if (!draft) return;
    setRecoveryDraft(null);
    restoreDraft(draft.filePath);
    setImageBaseDir(draft.filePath ? dirname(draft.filePath) : null);
    editorRef.current?.setContent(draft.content);
    setComments(draft.comments ?? []);
    setSuggestions(draft.suggestions ?? []);
    setAISession(draft.aiSession ?? null);
    setContextFolder(draft.contextFolder ?? null);
  }, [recoveryDraft, restoreDraft, setComments, setSuggestions]);

  const handleDiscardDraft = useCallback(() => {
    setRecoveryDraft(null);
    void deleteDraft();
  }, [deleteDraft]);

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
    // The effect may be torn down before the async registration resolves
    // (StrictMode double-mount). Track that so we don't leak a listener that
    // outlives the effect — a stale second listener would also call
    // preventDefault and leave the window unclosable with no dialog.
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const off = await win.onCloseRequested((event) => {
          if (!isDirtyRef.current) return; // Clean: let the close proceed.
          // Dirty: hold the close and route through the Save dialog. If
          // anything here throws, the catch below destroys the window rather
          // than leaving the X dead (prevented close, no dialog shown).
          try {
            event.preventDefault();
            setDiscardGuard({ run: () => void win.destroy() });
          } catch {
            void win.destroy();
          }
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        // Non-Tauri context.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Help → Copy Diagnostics: gather version/OS/log-path from the backend and
  // put a paste-ready block on the clipboard for bug reports. All local; the
  // log file itself is revealed separately (it may contain document text).
  const handleCopyDiagnostics = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const d = await invoke<{
        version: string;
        os: string;
        arch: string;
        log_dir: string;
      }>('get_diagnostics');
      const text = [`Quill ${d.version}`, `OS: ${d.os} (${d.arch})`, `Logs: ${d.log_dir}`].join(
        '\n',
      );
      await navigator.clipboard.writeText(text);
      setNotice({
        title: 'Diagnostics copied',
        message: `Paste this into your bug report:\n\n${text}\n\nUse Help → Show Logs to attach the log file.`,
      });
    } catch {
      // Non-Tauri context or clipboard denied — nothing actionable to show.
    }
  }, []);

  // Help → Show Logs: reveal the log directory in the OS file manager.
  const handleRevealLogs = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_logs');
    } catch {
      // Non-Tauri context.
    }
  }, []);

  // Native application menu (File → New/Open/Save/Save As). The Rust side owns
  // the accelerators and emits an event per item; we map each to the same
  // handler the in-app shortcuts use. In a non-Tauri context (plain dev server)
  // the listeners simply never fire.
  //
  // The menu handlers re-create on most edits (they close over filePath,
  // comments, etc.), so we hold the current set in a ref — refreshed every
  // render — and register the Tauri listeners exactly once. Otherwise every
  // keystroke would tear down and re-`listen` all of them.
  const menuHandlersRef = useRef({
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleExportPdf,
    handleQuit,
    handleCopyDiagnostics,
    handleRevealLogs,
    guardDirty,
    openFilePath,
    loadFileResult,
  });
  menuHandlersRef.current = {
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleExportPdf,
    handleQuit,
    handleCopyDiagnostics,
    handleRevealLogs,
    guardDirty,
    openFilePath,
    loadFileResult,
  };

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const wire = async (event: string, fn: () => void) => {
          unlisteners.push(await listen(event, () => fn()));
        };
        await wire('menu-new', () => menuHandlersRef.current.handleNew());
        await wire('menu-open', () => menuHandlersRef.current.handleOpen());
        await wire('menu-save', () => void menuHandlersRef.current.handleSave());
        await wire('menu-save-as', () => void menuHandlersRef.current.handleSaveAs());
        await wire('menu-export-pdf', () => menuHandlersRef.current.handleExportPdf());
        await wire('menu-quit', () => menuHandlersRef.current.handleQuit());
        await wire('menu-clear-recent', () => void syncRecentMenu(clearRecentFiles()));
        await wire(
          'menu-copy-diagnostics',
          () => void menuHandlersRef.current.handleCopyDiagnostics(),
        );
        await wire('menu-reveal-logs', () => void menuHandlersRef.current.handleRevealLogs());
        // Open Recent replaces the document, so it runs through the same
        // unsaved-changes guard as File → Open and deep links.
        unlisteners.push(
          await listen<string>('menu-open-recent', (e) => {
            const path = e.payload;
            if (!path) return;
            const cur = menuHandlersRef.current;
            cur.guardDirty(() => {
              void (async () => {
                const result = await cur.openFilePath(path);
                if (result) cur.loadFileResult(result);
              })();
            });
          }),
        );
      } catch {
        // Non-Tauri context — no native menu.
      }
    })();
    return () => unlisteners.forEach((u) => u());
    // Registered once: handlers are read live through menuHandlersRef.
  }, []);

  // Fill File → Open Recent from the persisted list once on launch; after
  // this, every add/clear re-syncs the menu itself.
  useEffect(() => {
    void syncRecentMenu(getRecentFiles());
  }, []);

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
        if (e.key === 'p' && !e.shiftKey && !e.altKey) {
          // Export to PDF (print-to-PDF). In Tauri the native menu owns this
          // accelerator; here we intercept the browser's default print so the
          // doc title is set first, matching the native path.
          e.preventDefault();
          handleExportPdf();
          return;
        }
      }

      // Cmd+F opens find & replace (re-focus when already open is handled by
      // the bar itself, which also owns Esc-to-close and Enter navigation).
      if (e.key === 'f' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setFindOpen(true);
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
  }, [handleSave, handleSaveAs, handleOpen, handleNew, handleExportPdf, hasNativeMenu]);

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

  // Resolving hides the card (unless "Show resolved" is on), so it also drops
  // the focus rather than leaving an outline on a vanished card. The in-text
  // mark is removed entirely so the text goes plain — a resolved comment leaves
  // no highlight behind (the stored from/to lets unresolve put it back).
  const handleResolveComment = useCallback(
    (commentId: string) => {
      resolveComment(commentId);
      editor?.commands.unsetComment(commentId);
      clearActiveIf('comment', commentId);
    },
    [resolveComment, editor, clearActiveIf],
  );

  const handleUnresolveComment = useCallback(
    (commentId: string) => {
      unresolveComment(commentId);
      // Re-stamp the mark from the comment's stored range — resolve removed it,
      // so there's no live mark to read the range from anymore.
      const comment = comments.find((c) => c.id === commentId);
      if (comment) editor?.commands.setCommentRange(commentId, comment.from, comment.to);
    },
    [unresolveComment, editor, comments],
  );

  // Scroll the editor's scroll area so a comment/suggestion card is fully
  // on-screen. The card lives in an overflow-hidden column translated by
  // -scrollTop, so its `offsetTop` there equals its document-space top (same
  // frame as scrollTop). The bottom spacer guarantees enough range exists for a
  // below-fold card. Deferred by one rAF so the spacer effect has committed
  // (it runs after this handler returns; scrolling synchronously would clamp
  // against the pre-spacer range).
  const scrollCardIntoView = useCallback((cardId: string) => {
    requestAnimationFrame(() => {
      const scrollArea = scrollAreaRef.current?.querySelector(
        '.editor-scroll-area',
      ) as HTMLElement | null;
      const card = commentLayerRef.current?.querySelector(
        `[data-card-id="${CSS.escape(cardId)}"]`,
      ) as HTMLElement | null;
      if (!scrollArea || !card) return;
      const cardTop = card.offsetTop;
      const cardBottom = cardTop + card.offsetHeight;
      const viewTop = scrollArea.scrollTop;
      const viewBottom = viewTop + scrollArea.clientHeight;
      let nextTop = viewTop;
      if (cardTop < viewTop + CARD_SCROLL_MARGIN) {
        nextTop = cardTop - CARD_SCROLL_MARGIN;
      } else if (cardBottom > viewBottom - CARD_SCROLL_MARGIN) {
        nextTop = cardBottom + CARD_SCROLL_MARGIN - scrollArea.clientHeight;
      }
      if (nextTop !== viewTop) {
        scrollArea.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
      }
    });
  }, []);

  const handleActivateComment = useCallback(
    (commentId: string) => {
      setActiveAnnotation((prev) =>
        prev?.kind === 'comment' && prev.id === commentId
          ? null
          : { kind: 'comment', id: commentId },
      );
      // Snap the anchor into range instantly (a smooth anchor scroll would
      // fight the card's smooth scroll on the same container), then bring the
      // full card on-screen.
      if (editor) {
        const dom = editor.view.dom.querySelector(`[data-comment-id="${commentId}"]`);
        dom?.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
      scrollCardIntoView(commentId);
    },
    [editor, scrollCardIntoView],
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
          el?.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
      }
      scrollCardIntoView(id);
    },
    [editor, scrollCardIntoView],
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
      // Same for a "Review full document" click with no session: resume by
      // opening the review modal against the freshly-linked session.
      if (pendingReviewRef.current) {
        pendingReviewRef.current = false;
        setReviewOpen(true);
      }
    },
    [markDirty, comments, claudeReply],
  );

  const handleReviewDocument = useCallback(() => {
    if (!aiSession) {
      pendingReviewRef.current = true;
      setPickerOpen(true);
      return;
    }
    setReviewOpen(true);
  }, [aiSession]);

  const handleReviewSubmit = useCallback(
    (options: ReviewOptions) => {
      if (!aiSession) return;
      void docReview.start(options, aiSession);
    },
    [aiSession, docReview],
  );

  const handleReviewClose = useCallback(() => {
    setReviewOpen(false);
    docReview.reset();
  }, [docReview]);

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

      {updateCheck.update && (
        <UpdateBanner
          version={updateCheck.update.version}
          url={updateCheck.update.url}
          onDismiss={updateCheck.dismiss}
        />
      )}

      <div className="workspace" ref={scrollAreaRef}>
        {findOpen && (
          <FindBar
            editor={editor}
            onClose={() => {
              setFindOpen(false);
              editor?.commands.focus();
            }}
          />
        )}
        <div className="editor-scroll-area">
          <div className="editor-page-zoom-wrapper" style={{ zoom }}>
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
          {/* Extends the scroll range only when a low-anchored card would
              otherwise be unreachable (see the spacer effect). Height 0 for
              normal docs; hidden in print so it never affects PDF output. */}
          {bottomSpacer > 0 && (
            <div className="editor-bottom-spacer" style={{ height: bottomSpacer }} aria-hidden />
          )}
        </div>

        {selectionInfo &&
          (() => {
            const commentLayer = commentLayerRef.current;
            const commentLayerRect = commentLayer?.getBoundingClientRect();
            // Fixed positioning: coordsAtPos already returns viewport coordinates
            // scaled by CSS zoom, so they're used as-is — no zoom math.
            const top = editor
              ? editor.view.coordsAtPos(selectionInfo.from).top
              : selectionInfo.top;
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
          zoom={zoom}
          onReply={(id, text) => addReply(id, text, AUTHOR)}
          onAIReplyRequest={handleAIReplyRequest}
          onCancelAIReply={claudeReply.cancel}
          onRetryAIReply={claudeReply.retry}
          onOpenSessionPicker={() => setPickerOpen(true)}
          onResolve={handleResolveComment}
          onUnresolve={handleUnresolveComment}
          onDelete={handleDeleteComment}
          onActivate={handleActivateComment}
          onActivateSuggestion={handleActivateSuggestion}
          onAcceptChange={handleAcceptChange}
          onRejectChange={handleRejectChange}
          onReviewDocument={handleReviewDocument}
          onMaxCardBottomChange={setMaxCardBottom}
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
        onClose={() => {
          setPickerOpen(false);
          // Closing without picking abandons a stashed review request — the
          // user backed out, so a later manual link shouldn't pop the modal.
          pendingReviewRef.current = false;
        }}
        onPick={handlePickSession}
      />

      {reviewOpen && (
        <ReviewModal
          phase={docReview.phase}
          onSubmit={handleReviewSubmit}
          onCancelStream={() => void docReview.cancel()}
          onClose={handleReviewClose}
        />
      )}

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
                  // The guarded action may exit the app before React effects
                  // flush, so don't rely on the autosave hook's dirty→clean
                  // cleanup — remove the draft explicitly first.
                  await deleteDraft();
                  setDiscardGuard(null);
                  discardGuard.run();
                }
              },
            },
            {
              label: "Don't Save",
              kind: 'danger',
              onClick: async () => {
                // Explicitly discarded — the draft must not come back as a
                // recovery offer on next launch (and quit skips effects).
                await deleteDraft();
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

      {recoveryDraft && !discardGuard && !notice && (
        <AppModal
          title="Recover unsaved changes?"
          message={
            `Quill closed before ${
              recoveryDraft.filePath
                ? `"${basename(recoveryDraft.filePath)}"`
                : 'an untitled document'
            } was saved. ` +
            `Restore the unsaved version from ${new Date(recoveryDraft.savedAt).toLocaleString()}?`
          }
          buttons={[
            { label: 'Recover', kind: 'primary', onClick: handleRecoverDraft },
            { label: 'Discard', kind: 'danger', onClick: handleDiscardDraft },
          ]}
        />
      )}
    </div>
  );
}
