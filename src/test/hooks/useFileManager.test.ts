import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { useFileManager } from '../../hooks/useFileManager';
import type { Comment } from '../../types';

const mockInvoke = vi.mocked(invoke);

const SAMPLE_COMMENT: Comment = {
  id: 'c1',
  anchorText: 'hi',
  from: 0,
  to: 2,
  author: 'Alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  resolved: false,
  replies: [],
};

const SAMPLE_SIDECAR = JSON.stringify({
  version: 1,
  comments: [SAMPLE_COMMENT],
  suggestions: [],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useFileManager', () => {
  describe('openFilePath', () => {
    it('reads the file and sidecar, returns content and parsed sidecar', async () => {
      mockInvoke.mockResolvedValueOnce('# Hello').mockResolvedValueOnce(SAMPLE_SIDECAR);

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;

      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.content).toBe('# Hello');
      expect(res!.filePath).toBe('/docs/test.md');
      expect(res!.sidecar.comments).toHaveLength(1);
      expect(result.current.filePath).toBe('/docs/test.md');
      expect(result.current.isDirty).toBe(false);
    });

    it('calls sidecarPath correctly — sidecar invoke uses .comments.json path', async () => {
      mockInvoke.mockResolvedValueOnce('content').mockResolvedValueOnce('{}');

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/file.md');
      });

      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'read_file', {
        path: '/docs/file.comments.json',
      });
    });

    it('falls back to empty sidecar when sidecar read fails', async () => {
      mockInvoke
        .mockResolvedValueOnce('# Hello')
        .mockRejectedValueOnce(new Error('File not found'));

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.sidecar.comments).toEqual([]);
      expect(res!.sidecar.suggestions).toEqual([]);
    });

    it('returns null and does not update state when main file read fails', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Permission denied'));

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!).toBeNull();
      expect(result.current.filePath).toBeNull();
    });

    it('flags sidecarError when the sidecar exists but is invalid JSON', async () => {
      mockInvoke
        .mockResolvedValueOnce('# Hello') // read_file (md)
        .mockResolvedValueOnce('{ not valid json') // read_file (sidecar) — corrupt
        .mockResolvedValueOnce(null); // find_session_for_markdown

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.sidecarError).toBeTruthy();
      // We keep an empty in-memory model rather than dropping the user's data.
      expect(res!.sidecar.comments).toEqual([]);
      expect(res!.sidecar.suggestions).toEqual([]);
    });
  });

  describe('saveFile', () => {
    it('returns null and does not invoke when no filePath is set', async () => {
      const { result } = renderHook(() => useFileManager());
      let res: string | null;
      await act(async () => {
        res = await result.current.saveFile('content', [], [], null);
      });
      expect(res!).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('writes file and sidecar, returns the path', async () => {
      mockInvoke
        .mockResolvedValueOnce('content')
        .mockResolvedValueOnce('{}')
        .mockResolvedValue(undefined);

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFile('updated content', [], [], null);
      });

      expect(savedPath!).toBe('/docs/test.md');
      expect(mockInvoke).toHaveBeenCalledWith('write_file', {
        path: '/docs/test.md',
        content: 'updated content',
      });
      expect(result.current.isDirty).toBe(false);
    });

    it('uses forcePath when provided, overriding stored filePath', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFile('content', [], [], null, '/override/path.md');
      });
      expect(savedPath!).toBe('/override/path.md');
      expect(mockInvoke).toHaveBeenCalledWith('write_file', {
        path: '/override/path.md',
        content: 'content',
      });
    });

    it('deletes sidecar when comments and suggestions are both empty', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [], [], null, '/docs/test.md');
      });
      expect(mockInvoke).toHaveBeenCalledWith('delete_file', {
        path: '/docs/test.comments.json',
      });
    });

    it('writes sidecar JSON when there are comments', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [SAMPLE_COMMENT], [], null, '/docs/test.md');
      });
      const sidecarCall = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file' &&
          typeof call[1] === 'object' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      expect(sidecarCall).toBeDefined();
      const written = JSON.parse((sidecarCall![1] as { content: string }).content);
      expect(written.version).toBe(2);
      expect(written.comments).toHaveLength(1);
    });

    it('does not clobber the sidecar on same-path save when it was corrupt on open', async () => {
      // Open a file whose sidecar is present but unreadable, then save back to
      // the same path. The corrupt sidecar must be left untouched (no write, no
      // delete) so the user can recover it.
      mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'read_file') {
          const path = (args as { path: string }).path;
          if (path.endsWith('.comments.json')) return Promise.resolve('{ corrupt');
          return Promise.resolve('# Hello');
        }
        if (cmd === 'find_session_for_markdown') return Promise.resolve(null);
        return Promise.resolve(undefined);
      });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      mockInvoke.mockClear();
      await act(async () => {
        await result.current.saveFile('updated', [], [], null);
      });

      // The markdown is saved...
      expect(mockInvoke).toHaveBeenCalledWith('write_file', {
        path: '/docs/test.md',
        content: 'updated',
      });
      // ...but nothing touches the sidecar path.
      const touchedSidecar = mockInvoke.mock.calls.some(
        (call) =>
          (call[0] === 'write_file' || call[0] === 'delete_file') &&
          typeof call[1] === 'object' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      expect(touchedSidecar).toBe(false);
    });

    it('still writes the sidecar on Save As (new path) after a corrupt open', async () => {
      // A Save As to a different path is a fresh file; the corruption guard only
      // protects the original path, so the new sidecar writes normally.
      mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'read_file') {
          const path = (args as { path: string }).path;
          if (path.endsWith('.comments.json')) return Promise.resolve('{ corrupt');
          return Promise.resolve('# Hello');
        }
        if (cmd === 'find_session_for_markdown') return Promise.resolve(null);
        return Promise.resolve(undefined);
      });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      mockInvoke.mockClear();
      await act(async () => {
        await result.current.saveFile('updated', [SAMPLE_COMMENT], [], null, '/docs/other.md');
      });

      const wroteNewSidecar = mockInvoke.mock.calls.some(
        (call) =>
          call[0] === 'write_file' &&
          typeof call[1] === 'object' &&
          (call[1] as { path: string }).path === '/docs/other.comments.json',
      );
      expect(wroteNewSidecar).toBe(true);
    });
  });

  describe('saveFileAs', () => {
    it('appends .md when the dialog returns a path without it', async () => {
      mockInvoke.mockResolvedValueOnce('/docs/newfile').mockResolvedValue(undefined);

      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFileAs('content', [], [], null);
      });
      expect(savedPath!).toBe('/docs/newfile.md');
    });

    it('does not double-append .md when dialog already returns it', async () => {
      mockInvoke.mockResolvedValueOnce('/docs/newfile.md').mockResolvedValue(undefined);

      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFileAs('content', [], [], null);
      });
      expect(savedPath!).toBe('/docs/newfile.md');
    });

    it('returns null when the save dialog is cancelled', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFileAs('content', [], [], null);
      });
      expect(savedPath!).toBeNull();
    });
  });

  describe('onError reporting', () => {
    it('reports an open failure with the path and underlying error', async () => {
      mockInvoke.mockRejectedValueOnce('Permission denied (os error 13)');
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      await act(async () => {
        await result.current.openFilePath('/docs/locked.md');
      });

      expect(onError).toHaveBeenCalledTimes(1);
      const [title, message] = onError.mock.calls[0];
      expect(title).toBe('Could not open file');
      expect(message).toContain('/docs/locked.md');
      expect(message).toContain('Permission denied');
    });

    it('reports a save failure with the path and underlying error', async () => {
      mockInvoke.mockRejectedValueOnce('Disk full (os error 28)');
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      let saved: string | null = null;
      await act(async () => {
        saved = await result.current.saveFile('content', [], [], null, '/docs/out.md');
      });

      expect(saved).toBeNull();
      expect(onError).toHaveBeenCalledTimes(1);
      const [title, message] = onError.mock.calls[0];
      expect(title).toBe('Could not save file');
      expect(message).toContain('/docs/out.md');
      expect(message).toContain('Disk full');
    });

    it('does not report when the open dialog is simply cancelled', async () => {
      mockInvoke.mockResolvedValueOnce(null); // show_open_dialog → cancelled
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      await act(async () => {
        await result.current.openFile();
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not report when the sidecar is merely missing', async () => {
      mockInvoke
        .mockResolvedValueOnce('# Hello')
        .mockRejectedValueOnce(new Error('File not found'))
        .mockResolvedValueOnce(null); // find_session_for_markdown
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('newFile', () => {
    it('clears filePath and resets isDirty', async () => {
      mockInvoke.mockResolvedValueOnce('content').mockResolvedValueOnce('{}');

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });
      act(() => {
        result.current.markDirty();
      });
      expect(result.current.isDirty).toBe(true);

      act(() => {
        result.current.newFile();
      });
      expect(result.current.filePath).toBeNull();
      expect(result.current.isDirty).toBe(false);
    });
  });

  describe('markDirty', () => {
    it('sets isDirty to true', () => {
      const { result } = renderHook(() => useFileManager());
      act(() => {
        result.current.markDirty();
      });
      expect(result.current.isDirty).toBe(true);
    });
  });
});
