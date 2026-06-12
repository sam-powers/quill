import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { useDraftAutosave } from '../../hooks/useDraftAutosave';
import type { DraftSnapshot } from '../../hooks/useDraftAutosave';
import type { DraftFile } from '../../types';

const mockInvoke = vi.mocked(invoke);

const SNAPSHOT: DraftSnapshot = {
  filePath: '/docs/test.md',
  content: '# Hello',
  comments: [],
  suggestions: [],
  aiSession: null,
  contextFolder: null,
};

const VALID_DRAFT: DraftFile = {
  version: 1,
  savedAt: '2026-06-11T00:00:00.000Z',
  ...SNAPSHOT,
};

function writeCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'write_draft');
}

function deleteCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_draft');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDraftAutosave', () => {
  it('writes the draft immediately when the document becomes dirty, then on every tick', async () => {
    const { rerender } = renderHook(
      ({ isDirty }) => useDraftAutosave({ isDirty, getSnapshot: () => SNAPSHOT }),
      { initialProps: { isDirty: false } },
    );
    expect(writeCalls()).toHaveLength(0);

    rerender({ isDirty: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(writeCalls()).toHaveLength(2);

    const [, args] = writeCalls()[0] as [string, { content: string }];
    const written = JSON.parse(args.content) as DraftFile;
    expect(written.version).toBe(1);
    expect(written.content).toBe('# Hello');
    expect(written.filePath).toBe('/docs/test.md');
    expect(typeof written.savedAt).toBe('string');
  });

  it('deletes the draft on the dirty→clean transition and stops the timer', async () => {
    const { rerender } = renderHook(
      ({ isDirty }) => useDraftAutosave({ isDirty, getSnapshot: () => SNAPSHOT }),
      { initialProps: { isDirty: true } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(1);

    rerender({ isDirty: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(deleteCalls()).toHaveLength(1);

    // The interval is gone: time passing writes nothing more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(writeCalls()).toHaveLength(1);
  });

  it('does NOT delete the draft on a clean mount (it may be the recovery draft)', async () => {
    renderHook(() => useDraftAutosave({ isDirty: false, getSnapshot: () => SNAPSHOT }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(deleteCalls()).toHaveLength(0);
    expect(writeCalls()).toHaveLength(0);
  });

  it('swallows invoke failures (non-Tauri context is a no-op)', async () => {
    mockInvoke.mockRejectedValue(new Error('not in tauri'));
    const { rerender } = renderHook(
      ({ isDirty }) => useDraftAutosave({ isDirty, getSnapshot: () => SNAPSHOT }),
      { initialProps: { isDirty: true } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    rerender({ isDirty: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // No unhandled rejection — reaching here is the assertion.
    expect(writeCalls().length).toBeGreaterThan(0);
  });

  describe('readDraft', () => {
    it('returns a valid draft', async () => {
      mockInvoke.mockResolvedValue(JSON.stringify(VALID_DRAFT));
      const { result } = renderHook(() =>
        useDraftAutosave({ isDirty: false, getSnapshot: () => SNAPSHOT }),
      );
      const draft = await result.current.readDraft();
      expect(draft).toEqual(VALID_DRAFT);
    });

    it('returns null when no draft exists', async () => {
      mockInvoke.mockResolvedValue(null);
      const { result } = renderHook(() =>
        useDraftAutosave({ isDirty: false, getSnapshot: () => SNAPSHOT }),
      );
      expect(await result.current.readDraft()).toBeNull();
    });

    it('returns null for malformed JSON or an invalid shape', async () => {
      const { result } = renderHook(() =>
        useDraftAutosave({ isDirty: false, getSnapshot: () => SNAPSHOT }),
      );

      mockInvoke.mockResolvedValue('not json {');
      expect(await result.current.readDraft()).toBeNull();

      mockInvoke.mockResolvedValue(JSON.stringify({ version: 99, content: 'x' }));
      expect(await result.current.readDraft()).toBeNull();

      mockInvoke.mockResolvedValue(JSON.stringify({ version: 1, content: 42, filePath: null }));
      expect(await result.current.readDraft()).toBeNull();

      mockInvoke.mockResolvedValue(JSON.stringify({ version: 1, content: 'x', filePath: 7 }));
      expect(await result.current.readDraft()).toBeNull();
    });

    it('returns null when invoke throws (non-Tauri context)', async () => {
      mockInvoke.mockRejectedValue(new Error('not in tauri'));
      const { result } = renderHook(() =>
        useDraftAutosave({ isDirty: false, getSnapshot: () => SNAPSHOT }),
      );
      expect(await result.current.readDraft()).toBeNull();
    });
  });
});
