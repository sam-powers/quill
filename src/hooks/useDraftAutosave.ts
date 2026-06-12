import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DraftFile } from '../types';

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

function isValidDraft(raw: unknown): raw is DraftFile {
  if (typeof raw !== 'object' || raw === null) return false;
  const d = raw as Partial<DraftFile>;
  return (
    d.version === 1 &&
    typeof d.content === 'string' &&
    (d.filePath === null || typeof d.filePath === 'string')
  );
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
      return isValidDraft(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, []);

  return { readDraft, deleteDraft };
}
