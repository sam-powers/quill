import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SidecarFile, Comment, Suggestion, AISessionBinding } from '../types';
import { sidecarPath } from '../utils/sidecarPath';

function emptySidecar(): SidecarFile {
  return { version: 2, comments: [], suggestions: [] };
}

function normalizeSidecar(raw: unknown): SidecarFile {
  const parsed = raw as Partial<SidecarFile> & { version?: number };
  return {
    version: 2,
    comments: parsed.comments ?? [],
    suggestions: parsed.suggestions ?? [],
    aiSession: parsed.aiSession,
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
    forcePath?: string,
  ) => Promise<string | null>;
  saveFileAs: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
    aiSession: AISessionBinding | null,
  ) => Promise<string | null>;
  newFile: () => void;
}

export function useFileManager(): UseFileManagerReturn {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  // True when the currently open file's sidecar exists on disk but couldn't be
  // parsed. We refuse to overwrite/delete it so the user can recover it; only
  // an explicit Save As (new path) escapes the guard.
  const [sidecarProtected, setSidecarProtected] = useState(false);

  const markDirty = useCallback(() => setIsDirty(true), []);

  const openFilePath = useCallback(async (path: string) => {
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
      return null;
    }
  }, []);

  const openFile = useCallback(async () => {
    try {
      const path = await invoke<string | null>('show_open_dialog');
      if (!path) return null;
      return openFilePath(path);
    } catch (e) {
      console.error('Failed to open file dialog:', e);
      return null;
    }
  }, [openFilePath]);

  const saveSidecar = useCallback(
    async (
      path: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
    ) => {
      const scPath = sidecarPath(path);
      if (comments.length === 0 && suggestions.length === 0 && !aiSession) {
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
        comments,
        suggestions,
        ...(aiSession ? { aiSession } : {}),
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
          await saveSidecar(targetPath, comments, suggestions, aiSession);
        }
        setFilePath(targetPath);
        setIsDirty(false);
        return targetPath;
      } catch (e) {
        console.error('Failed to save file:', e);
        return null;
      }
    },
    [filePath, saveSidecar, sidecarProtected],
  );

  const saveFileAs = useCallback(
    async (
      content: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
    ): Promise<string | null> => {
      try {
        const defaultName = filePath ? filePath.split('/').pop() : 'untitled.md';
        const path = await invoke<string | null>('show_save_dialog', {
          defaultName: defaultName ?? 'untitled.md',
        });
        if (!path) return null;
        const resolvedPath = path.endsWith('.md') ? path : `${path}.md`;
        return saveFile(content, comments, suggestions, aiSession, resolvedPath);
      } catch (e) {
        console.error('Failed to save as:', e);
        return null;
      }
    },
    [filePath, saveFile],
  );

  const newFile = useCallback(() => {
    setFilePath(null);
    setIsDirty(false);
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
  };
}
