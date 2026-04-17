import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SidecarFile, Comment, Suggestion } from '../types';

function sidecarPath(filePath: string): string {
  // Strip .md extension if present, append .comments.json
  const base = filePath.replace(/\.md$/i, '');
  return `${base}.comments.json`;
}

function emptySidecar(): SidecarFile {
  return { version: 1, comments: [], suggestions: [] };
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
    forcePath?: string,
  ) => Promise<string | null>;
  saveFileAs: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
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
        sidecar = JSON.parse(raw) as SidecarFile;
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
    async (path: string, comments: Comment[], suggestions: Suggestion[]) => {
      const sidecar: SidecarFile = { version: 1, comments, suggestions };
      const scPath = sidecarPath(path);
      if (comments.length === 0 && suggestions.length === 0) {
        // Clean up empty sidecar
        try {
          await invoke('delete_file', { path: scPath });
        } catch {
          // Ignore
        }
        return;
      }
      await invoke('write_file', { path: scPath, content: JSON.stringify(sidecar, null, 2) });
    },
    [],
  );

  const saveFile = useCallback(
    async (
      content: string,
      comments: Comment[],
      suggestions: Suggestion[],
      forcePath?: string,
    ): Promise<string | null> => {
      const targetPath = forcePath ?? filePath;
      if (!targetPath) {
        return null;
      }
      try {
        await invoke('write_file', { path: targetPath, content });
        await saveSidecar(targetPath, comments, suggestions);
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
    ): Promise<string | null> => {
      try {
        const defaultName = filePath ? filePath.split('/').pop() : 'untitled.md';
        const path = await invoke<string | null>('show_save_dialog', {
          defaultName: defaultName ?? 'untitled.md',
        });
        if (!path) return null;
        const resolvedPath = path.endsWith('.md') ? path : `${path}.md`;
        return saveFile(content, comments, suggestions, resolvedPath);
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
