import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SidecarFile, Comment, Suggestion, AISessionBinding } from '../types';

function sidecarPath(filePath: string): string {
  // Strip .md extension if present, append .comments.json
  const base = filePath.replace(/\.md$/i, '');
  return `${base}.comments.json`;
}

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
  } | null>;
  openFilePath: (path: string) => Promise<{
    content: string;
    sidecar: SidecarFile;
    filePath: string;
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

  const markDirty = useCallback(() => setIsDirty(true), []);

  const openFilePath = useCallback(async (path: string) => {
    try {
      const content = await invoke<string>('read_file', { path });
      let sidecar = emptySidecar();
      try {
        const raw = await invoke<string>('read_file', { path: sidecarPath(path) });
        sidecar = normalizeSidecar(JSON.parse(raw));
      } catch {
        // No sidecar — that's fine
      }
      setFilePath(path);
      setIsDirty(false);
      return { content, sidecar, filePath: path };
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
      try {
        await invoke('write_file', { path: targetPath, content });
        await saveSidecar(targetPath, comments, suggestions, aiSession);
        setFilePath(targetPath);
        setIsDirty(false);
        return targetPath;
      } catch (e) {
        console.error('Failed to save file:', e);
        return null;
      }
    },
    [filePath, saveSidecar],
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
