import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DraftFile } from '../types';
import {
  sanitizeComments,
  sanitizeSuggestions,
  sanitizeAISession,
  sanitizeContextFolder,
} from '../utils/annotationValidation';

const AUTOSAVE_INTERVAL_MS = 5000;

export type DraftSnapshot = Omit<DraftFile, 'version' | 'savedAt'>;

interface UseDraftAutosaveOptions {
  isDirty: boolean;
  /** Captures the current document + annotations. Called on every tick. */
  getSnapshot: () => DraftSnapshot;
}

interface UseDraftAutosaveReturn {
  /** Read the recovery draft left by a previous run, if any and valid. */
  readDraft: () => Promise<DraftFile | null>;
  /**
   * Delete the draft now. The hook deletes automatically when the document
   * transitions dirty → clean, but paths that exit the app before React
   * effects flush (the unsaved-changes guard's Save / Don't Save) must await
   * this explicitly.
   */
  deleteDraft: () => Promise<void>;
}

/**
 * Validate and sanitize a parsed draft. The draft is JSON from disk that may
 * have been truncated by the very crash it exists to recover from, so we check
 * the envelope (version + content + filePath) and then sanitize the annotation
 * payload through the same rules the sidecar uses — a recovered draft must not
 * carry positions that throw inside the editor any more than a sidecar can.
 * Returns a clean DraftFile, or null if the envelope is unusable.
 */
function sanitizeDraft(raw: unknown): DraftFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.version !== 1) return null;
  if (typeof d.content !== 'string') return null;
  if (d.filePath !== null && typeof d.filePath !== 'string') return null;
  return {
    version: 1,
    savedAt: typeof d.savedAt === 'string' ? d.savedAt : new Date().toISOString(),
    filePath: d.filePath,
    content: d.content,
    comments: sanitizeComments(d.comments),
    suggestions: sanitizeSuggestions(d.suggestions),
    aiSession: sanitizeAISession(d.aiSession) ?? null,
    contextFolder: sanitizeContextFolder(d.contextFolder) ?? null,
  };
}

/**
 * Crash-recovery autosave. While the document is dirty, snapshots it to
 * `draft.json` in the app data dir (immediately, then every few seconds);
 * deletes the draft when the document becomes clean. Outside Tauri (plain
 * vitest/browser) every operation is a silent no-op.
 *
 * The draft is deleted only on a true→false dirty *transition* — never on a
 * clean mount — so the launch-time recovery check can read a draft left by a
 * crashed run before anything destroys it.
 */
export function useDraftAutosave({
  isDirty,
  getSnapshot,
}: UseDraftAutosaveOptions): UseDraftAutosaveReturn {
  const getSnapshotRef = useRef(getSnapshot);
  getSnapshotRef.current = getSnapshot;
  const wasDirtyRef = useRef(false);

  const writeDraft = useCallback(async () => {
    const draft: DraftFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      ...getSnapshotRef.current(),
    };
    try {
      await invoke('write_draft', { content: JSON.stringify(draft) });
    } catch {
      // Best-effort: outside Tauri (or on IO failure) autosave is a no-op.
    }
  }, []);

  const deleteDraft = useCallback(async () => {
    try {
      await invoke('delete_draft');
    } catch {
      // Best-effort, same as writes.
    }
  }, []);

  useEffect(() => {
    if (isDirty) {
      wasDirtyRef.current = true;
      void writeDraft();
      const timer = setInterval(() => void writeDraft(), AUTOSAVE_INTERVAL_MS);
      return () => clearInterval(timer);
    }
    if (wasDirtyRef.current) {
      wasDirtyRef.current = false;
      void deleteDraft();
    }
  }, [isDirty, writeDraft, deleteDraft]);

  const readDraft = useCallback(async (): Promise<DraftFile | null> => {
    try {
      const raw = await invoke<string | null>('read_draft');
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return sanitizeDraft(parsed);
    } catch {
      return null;
    }
  }, []);

  return { readDraft, deleteDraft };
}
