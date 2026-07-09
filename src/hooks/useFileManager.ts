import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SidecarFile, Comment, Suggestion, AISessionBinding } from '../types';
import { sidecarPath } from '../utils/sidecarPath';
import { basename } from '../utils/path';
import {
  sanitizeComments,
  sanitizeSuggestions,
  sanitizeAISession,
  sanitizeContextFolder,
} from '../utils/annotationValidation';

function emptySidecar(): SidecarFile {
  return { version: 2, comments: [], suggestions: [] };
}

/**
 * Drop transient AI-reply state before serialization. A pending or errored AI
 * reply is in-flight UI state — the request either never completed or failed —
 * so it must never reach the on-disk sidecar, where it would resurrect a stuck
 * spinner or a stale error on the next open. User replies and finished AI
 * replies are kept untouched. Returns a new array; inputs are not mutated.
 */
export function stripTransientReplyState(comments: Comment[]): Comment[] {
  return comments.map((c) => {
    const kept = c.replies.filter(
      (r) => !(r.authorKind === 'ai' && (r.pending || r.error !== undefined)),
    );
    return kept.length === c.replies.length ? c : { ...c, replies: kept };
  });
}

/**
 * Build a trusted SidecarFile from the raw parsed JSON. The sidecar sits on disk
 * next to the document and may be hand-edited, corrupted, or supplied by another
 * party, so every field is validated rather than trusted: malformed comments /
 * suggestions are dropped (not fatal) and annotation positions are coerced to
 * sane integers so they can't throw inside the editor. See annotationValidation.
 */
function normalizeSidecar(raw: unknown): SidecarFile {
  const parsed = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    version: 2,
    comments: sanitizeComments(parsed.comments),
    suggestions: sanitizeSuggestions(parsed.suggestions),
    aiSession: sanitizeAISession(parsed.aiSession),
    contextFolder: sanitizeContextFolder(parsed.contextFolder),
  };
}

interface UseFileManagerReturn {
  filePath: string | null;
  isDirty: boolean;
  markDirty: () => void;
  openFile: () => Promise<{
    content: string;
    sidecar: SidecarFile;
    filePath: string;
    autoBound?: boolean;
    sidecarError?: string | null;
  } | null>;
  openFilePath: (path: string) => Promise<{
    content: string;
    sidecar: SidecarFile;
    filePath: string;
    autoBound?: boolean;
    sidecarError?: string | null;
  } | null>;
  saveFile: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
    aiSession: AISessionBinding | null,
    contextFolder: string | null,
    forcePath?: string,
  ) => Promise<string | null>;
  saveFileAs: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
    aiSession: AISessionBinding | null,
    contextFolder: string | null,
  ) => Promise<string | null>;
  newFile: () => void;
  restoreDraft: (path: string | null) => void;
}

/**
 * @param onError Called when a file operation fails so the UI can tell the
 *   user (open/save errors must not be swallowed — a failed save that looks
 *   like a successful one loses work). Errors are still logged to the console.
 */
export function useFileManager(
  onError?: (title: string, message: string) => void,
): UseFileManagerReturn {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  // True when the currently open file's sidecar exists on disk but couldn't be
  // parsed. We refuse to overwrite/delete it so the user can recover it; only
  // an explicit Save As (new path) escapes the guard.
  const [sidecarProtected, setSidecarProtected] = useState(false);

  const markDirty = useCallback(() => setIsDirty(true), []);

  const openFilePath = useCallback(
    async (path: string) => {
      try {
        const content = await invoke<string>('read_file', { path });
        let sidecar = emptySidecar();
        // Distinguish "no sidecar" (fine) from "sidecar exists but is unreadable
        // / invalid JSON" (dangerous — it holds real comments we must not drop or
        // silently overwrite). On a load error we block the next save from
        // clobbering the file so the user can recover it.
        let sidecarError: string | null = null;
        let raw: string | undefined;
        try {
          raw = await invoke<string>('read_file', { path: sidecarPath(path) });
        } catch {
          // read_file threw → sidecar simply doesn't exist. That's fine.
        }
        if (raw !== undefined) {
          try {
            sidecar = normalizeSidecar(JSON.parse(raw));
          } catch (e) {
            // The sidecar is present but corrupt. Keep an empty in-memory model
            // but flag the error and protect the on-disk file.
            sidecarError = e instanceof Error ? e.message : String(e);
            console.error(`Sidecar at ${sidecarPath(path)} is unreadable:`, e);
          }
        }
        setSidecarProtected(sidecarError !== null);

        let autoBound = false;
        if (!sidecar.aiSession) {
          try {
            const match = await invoke<AISessionBinding | null>('find_session_for_markdown', {
              content,
            });
            if (match) {
              sidecar = { ...sidecar, aiSession: match };
              autoBound = true;
            }
          } catch (e) {
            console.warn('Auto-bind scan failed:', e);
          }
        }

        setFilePath(path);
        setIsDirty(autoBound);
        return { content, sidecar, filePath: path, autoBound, sidecarError };
      } catch (e) {
        console.error('Failed to open file:', e);
        onError?.('Could not open file', `${path}\n\n${String(e)}`);
        return null;
      }
    },
    [onError],
  );

  const openFile = useCallback(async () => {
    try {
      const path = await invoke<string | null>('show_open_dialog');
      if (!path) return null;
      return openFilePath(path);
    } catch (e) {
      console.error('Failed to open file dialog:', e);
      onError?.('Could not open file', String(e));
      return null;
    }
  }, [openFilePath, onError]);

  const saveSidecar = useCallback(
    async (
      path: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
      contextFolder: string | null,
    ) => {
      const scPath = sidecarPath(path);
      // Never persist in-flight AI replies (pending/errored) — strip them first
      // so an empty doc with only a failed reply still collapses to no sidecar.
      const cleanComments = stripTransientReplyState(comments);
      if (cleanComments.length === 0 && suggestions.length === 0 && !aiSession && !contextFolder) {
        // Clean up empty sidecar
        try {
          await invoke('delete_file', { path: scPath });
        } catch {
          // Ignore
        }
        return;
      }
      const sidecar: SidecarFile = {
        version: 2,
        comments: cleanComments,
        suggestions,
        ...(aiSession ? { aiSession } : {}),
        ...(contextFolder ? { contextFolder } : {}),
      };
      await invoke('write_file', { path: scPath, content: JSON.stringify(sidecar, null, 2) });
    },
    [],
  );

  const saveFile = useCallback(
    async (
      content: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
      contextFolder: string | null,
      forcePath?: string,
    ): Promise<string | null> => {
      const targetPath = forcePath ?? filePath;
      if (!targetPath) {
        return null;
      }
      // Protect a corrupt sidecar from being clobbered. Saving the markdown to
      // the same path is fine, but skip touching the sidecar so we don't destroy
      // recoverable comment data. A Save As to a different path (forcePath) is
      // a fresh file and may write its own sidecar normally.
      const skipSidecar = sidecarProtected && targetPath === filePath;
      try {
        await invoke('write_file', { path: targetPath, content });
        if (!skipSidecar) {
          await saveSidecar(targetPath, comments, suggestions, aiSession, contextFolder);
        }
        setFilePath(targetPath);
        setIsDirty(false);
        return targetPath;
      } catch (e) {
        console.error('Failed to save file:', e);
        onError?.('Could not save file', `${targetPath}\n\n${String(e)}`);
        return null;
      }
    },
    [filePath, saveSidecar, sidecarProtected, onError],
  );

  const saveFileAs = useCallback(
    async (
      content: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
      contextFolder: string | null,
    ): Promise<string | null> => {
      try {
        const defaultName = filePath ? basename(filePath) : 'untitled.md';
        const path = await invoke<string | null>('show_save_dialog', { defaultName });
        if (!path) return null;
        const resolvedPath = path.endsWith('.md') ? path : `${path}.md`;
        return saveFile(content, comments, suggestions, aiSession, contextFolder, resolvedPath);
      } catch (e) {
        console.error('Failed to save as:', e);
        onError?.('Could not save file', String(e));
        return null;
      }
    },
    [filePath, saveFile, onError],
  );

  const newFile = useCallback(() => {
    setFilePath(null);
    setIsDirty(false);
    setSidecarProtected(false);
  }, []);

  // Adopt a recovered draft: point at its file (if any) without reading disk —
  // the draft's content is newer than the file — and mark dirty so the user is
  // prompted to save the recovered work.
  const restoreDraft = useCallback((path: string | null) => {
    setFilePath(path);
    setIsDirty(true);
    setSidecarProtected(false);
  }, []);

  return {
    filePath,
    isDirty,
    markDirty,
    openFile,
    openFilePath,
    saveFile,
    saveFileAs,
    newFile,
    restoreDraft,
  };
}
