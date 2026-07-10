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

import { invoke } from '@tauri-apps/api/core';
import { useClaudeReply } from '../../hooks/useClaudeReply';
import type { ChunkEvent, RangeTexts } from '../../hooks/useClaudeReply';
import type { AISessionBinding, Comment, EditScope, QuillEdit } from '../../types';

const invokeMock = vi.mocked(invoke);

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
  const cancelAIReply = vi.fn();
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
      cancelAIReply,
      retryAIReply,
      getDocMarkdown,
      getRangeTexts,
      applyTrackedEdits,
      getContextFolder,
    },
    spies: {
      startAIReply,
      appendAIReplyChunk,
      finishAIReply,
      failAIReply,
      cancelAIReply,
      retryAIReply,
    },
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

describe('useClaudeReply cancel → re-run', () => {
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

  it('marks a cancelled reply neutral (not finished/errored) and keeps its inputs', async () => {
    const { opts, spies } = makeOpts(mock);
    const { result } = renderHook(() => useClaudeReply(opts));
    const comment = makeComment();

    await act(async () => {
      await result.current.ask(comment, 'fix this', BINDING);
    });
    // A little prose streams in before the user stops it.
    act(() => {
      mock.emit('tok-1', { kind: 'delta', text: 'half a rewri' });
    });

    // Backend confirms the stop by emitting `cancelled`.
    act(() => {
      mock.emit('tok-1', { kind: 'cancelled' });
    });

    // Cancelled is its own neutral terminal state: NOT a completion and NOT an
    // error. A half-streamed reply must not finalize (which would apply partial
    // edits) or masquerade as a finished answer.
    expect(spies.cancelAIReply).toHaveBeenCalledWith('c1', 'r0');
    expect(spies.finishAIReply).not.toHaveBeenCalled();
    expect(spies.failAIReply).not.toHaveBeenCalled();
    expect(opts.applyTrackedEdits).not.toHaveBeenCalled();
  });

  it('re-runs a cancelled reply in place against the same replyId', async () => {
    const { opts, spies } = makeOpts(mock);
    const { result } = renderHook(() => useClaudeReply(opts));
    const comment = makeComment();

    await act(async () => {
      await result.current.ask(comment, 'fix this', BINDING);
    });
    act(() => {
      mock.emit('tok-1', { kind: 'cancelled' });
    });
    expect(spies.cancelAIReply).toHaveBeenCalledWith('c1', 'r0');

    // The user hits Re-run: the stashed inputs survived the cancel, so a fresh
    // spawn re-issues the identical request against the same reply entry.
    await act(async () => {
      await result.current.retry('r0');
    });
    expect(spies.retryAIReply).toHaveBeenCalledWith('c1', 'r0');
    expect(mock.dispatchers.has('tok-2')).toBe(true);

    // The re-run completes and finishes the reply normally.
    act(() => {
      mock.emit('tok-2', { kind: 'delta', text: 'a clean rewrite' });
      mock.emit('tok-2', { kind: 'done' });
    });
    expect(spies.finishAIReply).toHaveBeenCalledWith('c1', 'r0');
  });

  it("drops a superseded cancel event from a re-run's slow original", async () => {
    const { opts, spies } = makeOpts(mock);
    const { result } = renderHook(() => useClaudeReply(opts));
    const comment = makeComment();

    // Ask, then re-run *before* the first spawn ever reports cancelled — the
    // original (tok-1) is now stale, superseded by tok-2.
    await act(async () => {
      await result.current.ask(comment, 'fix this', BINDING);
    });
    act(() => {
      mock.emit('tok-1', { kind: 'cancelled' });
    });
    await act(async () => {
      await result.current.retry('r0');
    });
    spies.cancelAIReply.mockClear();

    // A late `cancelled` from the superseded original must NOT re-cancel the
    // reply the re-run now owns; it orphan-cancels tok-1 instead.
    act(() => {
      mock.emit('tok-1', { kind: 'cancelled' });
    });
    expect(spies.cancelAIReply).not.toHaveBeenCalled();
    expect(mock.cancelled).toContain('tok-1');
  });
});

// The single-reply cancel path has one window the __quillMock can't model: the
// mock's spawn returns synchronously, but the real code awaits
// spawn_claude_resume. A Cancel click can land in that gap, before any token is
// tracked. Drive the real invoke path (no __quillMock) with a deferred spawn to
// exercise it.
describe('useClaudeReply cancel during the spawn-await window', () => {
  afterEach(() => {
    delete window.__quillTestSession;
    vi.clearAllMocks();
  });

  it('cancels synchronously and orphan-cancels the child once the slow spawn resolves', async () => {
    // Hold spawn_claude_resume open so a Cancel can land before it returns a
    // token. Route the other IPC calls to harmless resolutions.
    let resolveSpawn: (token: string) => void = () => {};
    const spawnPending = new Promise<string>((res) => {
      resolveSpawn = res;
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'check_session_compacted') return Promise.resolve({ compacted: false });
      if (cmd === 'spawn_claude_resume') return spawnPending;
      if (cmd === 'cancel_claude_resume') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    const { opts, spies } = makeOpts(new MockClaude());
    const { result } = renderHook(() => useClaudeReply(opts));
    const comment = makeComment();

    // Fire the ask but DON'T await it — runSpawn is now parked awaiting the
    // deferred spawn, before any token is tracked.
    let askDone!: Promise<void>;
    act(() => {
      askDone = result.current.ask(comment, 'fix this', BINDING);
    });
    expect(spies.startAIReply).toHaveBeenCalled();

    // The user hits Cancel mid-spawn — somewhere in the async prelude
    // (compaction check → spawn await), before any token is tracked. The reply
    // must still be marked cancelled: it can't just early-return and stream on.
    await act(async () => {
      await result.current.cancel('r0');
    });
    expect(spies.cancelAIReply).toHaveBeenCalledWith('c1', 'r0');

    // The spawn finally resolves. runSpawn's post-await isCurrent() is now false
    // (cancel bumped the generation), so it tears down its own orphaned child
    // via cancel_claude_resume rather than tracking it — and never finishes.
    await act(async () => {
      resolveSpawn('late-token');
      await askDone;
    });
    expect(invokeMock).toHaveBeenCalledWith('cancel_claude_resume', { cancelToken: 'late-token' });
    expect(spies.finishAIReply).not.toHaveBeenCalled();
  });
});
