import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// The retry path never reaches the real Tauri IPC: spawns/cancels route through
// window.__quillMock, and the two pre-spawn invokes (check_session_compacted,
// list_context_files) are best-effort and swallowed. Stub the module so the
// import resolves and those probes reject harmlessly.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('no tauri in test')),
  Channel: class {
    onmessage: ((e: unknown) => void) | null = null;
  },
}));

import { useClaudeReply } from '../../hooks/useClaudeReply';
import type { ChunkEvent, RangeTexts } from '../../hooks/useClaudeReply';
import type { AISessionBinding, Comment, EditScope, QuillEdit } from '../../types';

const BINDING: AISessionBinding = {
  provider: 'claude-code',
  sessionId: 's1',
  cwd: '/tmp',
  linkedAt: new Date().toISOString(),
};

function makeComment(): Comment {
  return {
    id: 'c1',
    anchorText: 'anchor',
    from: 1,
    to: 7,
    author: 'Sam',
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: [],
  };
}

/**
 * A controllable mock claude spawn. Each spawn stashes its dispatch callback
 * keyed by token so the test can deliver stream events on demand, letting a
 * "slow original" finish *after* a retry has superseded it.
 */
class MockClaude {
  private seq = 0;
  readonly dispatchers = new Map<string, (e: ChunkEvent) => void>();
  readonly cancelled: string[] = [];

  install() {
    window.__quillMock = {
      spawn: (_args, onEvent) => {
        const token = `tok-${++this.seq}`;
        this.dispatchers.set(token, onEvent);
        return token;
      },
      cancel: (token: string) => {
        this.cancelled.push(token);
      },
    };
    window.__quillTestSession = BINDING;
  }

  emit(token: string, event: ChunkEvent) {
    this.dispatchers.get(token)?.(event);
  }
}

function makeOpts(mock: MockClaude) {
  const startAIReply = vi.fn((_commentId: string) => 'r0');
  const appendAIReplyChunk = vi.fn();
  const finishAIReply = vi.fn();
  const failAIReply = vi.fn();
  const retryAIReply = vi.fn();
  const getDocMarkdown = vi.fn(() => 'doc body');
  const getRangeTexts = vi.fn(
    (_c: Comment): RangeTexts => ({ highlightText: 'anchor', paragraphText: 'anchor para' }),
  );
  const applyTrackedEdits = vi.fn((_c: Comment, _e: QuillEdit[], _s: EditScope) => ({
    applied: 0,
    skipped: 0,
  }));
  const getContextFolder = vi.fn(() => null);
  return {
    opts: {
      startAIReply,
      appendAIReplyChunk,
      finishAIReply,
      failAIReply,
      retryAIReply,
      getDocMarkdown,
      getRangeTexts,
      applyTrackedEdits,
      getContextFolder,
    },
    spies: { startAIReply, appendAIReplyChunk, finishAIReply, failAIReply, retryAIReply },
    mock,
  };
}

describe('useClaudeReply generation guard (retry vs. slow original)', () => {
  let mock: MockClaude;

  beforeEach(() => {
    mock = new MockClaude();
    mock.install();
  });

  afterEach(() => {
    delete window.__quillMock;
    delete window.__quillTestSession;
    vi.clearAllMocks();
  });

  it("drops a superseded original's late terminal event and cancels the orphan", async () => {
    const { opts, spies } = makeOpts(mock);
    const { result } = renderHook(() => useClaudeReply(opts));
    const comment = makeComment();

    // First ask spawns the original (tok-1) — startAIReply mints replyId 'r0'.
    await act(async () => {
      await result.current.ask(comment, 'fix this', BINDING);
    });
    expect(mock.dispatchers.has('tok-1')).toBe(true);

    // The original errors, marking the reply failed (its inputs stay stashed).
    act(() => {
      mock.emit('tok-1', { kind: 'error', message: 'API Error: overloaded' });
    });
    expect(spies.failAIReply).toHaveBeenCalledWith('c1', 'r0', 'API Error: overloaded');

    // The user hits Retry: same replyId, new generation, new spawn (tok-2).
    await act(async () => {
      await result.current.retry('r0');
    });
    expect(spies.retryAIReply).toHaveBeenCalledWith('c1', 'r0');
    expect(mock.dispatchers.has('tok-2')).toBe(true);

    // Now the *original's* late 'done' arrives on tok-1 — after it was superseded.
    // It must NOT finish the reply the retry now owns; instead it orphan-cancels.
    spies.finishAIReply.mockClear();
    act(() => {
      mock.emit('tok-1', { kind: 'done' });
    });
    expect(spies.finishAIReply).not.toHaveBeenCalled();
    expect(mock.cancelled).toContain('tok-1');

    // The retried spawn (tok-2) is current: its 'done' finishes the reply.
    act(() => {
      mock.emit('tok-2', { kind: 'done' });
    });
    expect(spies.finishAIReply).toHaveBeenCalledWith('c1', 'r0');
  });

  it('ignores a double-fire retry while one is already launching', async () => {
    const { opts, spies } = makeOpts(mock);
    const { result } = renderHook(() => useClaudeReply(opts));
    const comment = makeComment();

    await act(async () => {
      await result.current.ask(comment, 'fix this', BINDING);
    });
    act(() => {
      mock.emit('tok-1', { kind: 'error', message: 'timeout' });
    });

    // Two retries fired back-to-back within the same tick — the guard must let
    // only one through (one retryAIReply reset, one fresh spawn).
    await act(async () => {
      await Promise.all([result.current.retry('r0'), result.current.retry('r0')]);
    });
    expect(spies.retryAIReply).toHaveBeenCalledTimes(1);
    expect(mock.dispatchers.has('tok-2')).toBe(true);
    expect(mock.dispatchers.has('tok-3')).toBe(false);
  });

  it('is a no-op retry for a replyId with no stashed inputs', async () => {
    const { opts, spies } = makeOpts(mock);
    const { result } = renderHook(() => useClaudeReply(opts));

    await act(async () => {
      await result.current.retry('never-asked');
    });
    expect(spies.retryAIReply).not.toHaveBeenCalled();
    expect(mock.dispatchers.size).toBe(0);
  });
});
