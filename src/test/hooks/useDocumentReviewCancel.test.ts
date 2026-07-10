import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// The review path routes spawns/cancels through window.__quillMock; the one
// pre-spawn invoke (list_context_files) only runs when a context folder is set,
// which these tests leave null. Stub the module so the import resolves.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('no tauri in test')),
  Channel: class {
    onmessage: ((e: unknown) => void) | null = null;
  },
}));

import { useDocumentReview } from '../../hooks/useDocumentReview';
import type { ReviewOptions } from '../../hooks/useDocumentReview';
import type { ChunkEvent } from '../../hooks/useClaudeReply';
import type { AISessionBinding } from '../../types';

const BINDING: AISessionBinding = {
  provider: 'claude-code',
  sessionId: 's1',
  cwd: '/tmp',
  linkedAt: new Date().toISOString(),
};

const OPTIONS: ReviewOptions = { guidance: '', makeComments: true, makeSuggestions: true };

/**
 * Controllable mock claude spawn: stashes each spawn's dispatch callback keyed
 * by token so a test can deliver stream events on demand and observe cancels.
 * The mock's `spawn` returns synchronously (matching the real test seam), so
 * the true pre-token await gap isn't reproducible here — the injected-late-event
 * and no-`cancelled`-event cases cover the observable behavior instead.
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
  }

  emit(token: string, event: ChunkEvent) {
    this.dispatchers.get(token)?.(event);
  }

  get lastToken() {
    return `tok-${this.seq}`;
  }
}

function makeOpts() {
  const getDocMarkdown = vi.fn(() => 'doc body');
  const getContextFolder = vi.fn(() => null);
  const applyTrackedEdits = vi.fn(() => ({ applied: 0, skipped: 0 }));
  const addClaudeComment = vi.fn(() => true);
  return { getDocMarkdown, getContextFolder, applyTrackedEdits, addClaudeComment };
}

describe('useDocumentReview cancel (generation guard)', () => {
  let mock: MockClaude;

  beforeEach(() => {
    mock = new MockClaude();
    mock.install();
  });

  afterEach(() => {
    delete window.__quillMock;
    vi.clearAllMocks();
  });

  it('resets the modal to idle synchronously on cancel, without a cancelled event', async () => {
    const opts = makeOpts();
    const { result } = renderHook(() => useDocumentReview(opts));

    await act(async () => {
      await result.current.start(OPTIONS, BINDING);
    });
    expect(result.current.phase.status).toBe('streaming');

    // Cancel — the mock deliberately emits no `cancelled` event back.
    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.phase.status).toBe('idle');
    expect(mock.cancelled).toContain(mock.lastToken);
  });

  it('drops a late delta injected after cancel (does not flip back to streaming)', async () => {
    const opts = makeOpts();
    const { result } = renderHook(() => useDocumentReview(opts));

    let token = '';
    await act(async () => {
      await result.current.start(OPTIONS, BINDING);
    });
    token = mock.lastToken;

    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.phase.status).toBe('idle');

    // A straggler delta from the superseded run arrives — the guard drops it.
    act(() => {
      mock.emit(token, { kind: 'delta', text: 'late output' });
    });
    expect(result.current.phase.status).toBe('idle');
  });

  it('drops a late done after cancel (no comments/suggestions applied)', async () => {
    const opts = makeOpts();
    const { result } = renderHook(() => useDocumentReview(opts));

    let token = '';
    await act(async () => {
      await result.current.start(OPTIONS, BINDING);
    });
    token = mock.lastToken;

    await act(async () => {
      await result.current.cancel();
    });

    act(() => {
      mock.emit(token, {
        kind: 'delta',
        text: '```quill-comments\n{"comments":[{"find":"doc","comment":"x"}]}\n```',
      });
      mock.emit(token, { kind: 'done' });
    });

    expect(result.current.phase.status).toBe('idle');
    expect(opts.addClaudeComment).not.toHaveBeenCalled();
    expect(opts.applyTrackedEdits).not.toHaveBeenCalled();
  });

  it('still applies results for a run that completes normally (no cancel)', async () => {
    const opts = makeOpts();
    const { result } = renderHook(() => useDocumentReview(opts));

    let token = '';
    await act(async () => {
      await result.current.start(OPTIONS, BINDING);
    });
    token = mock.lastToken;

    act(() => {
      mock.emit(token, {
        kind: 'delta',
        text: '```quill-comments\n{"comments":[{"find":"doc","comment":"x"}]}\n```',
      });
      mock.emit(token, { kind: 'done' });
    });

    expect(result.current.phase.status).toBe('done');
    expect(opts.addClaudeComment).toHaveBeenCalledWith('doc', 'x');
  });

  it('supersedes the first run when start is called again (generation bump)', async () => {
    const opts = makeOpts();
    const { result } = renderHook(() => useDocumentReview(opts));

    await act(async () => {
      await result.current.start(OPTIONS, BINDING);
    });
    const first = mock.lastToken;

    await act(async () => {
      await result.current.start(OPTIONS, BINDING);
    });
    const second = mock.lastToken;

    // A late done from the first run is dropped; the second run still finalizes.
    act(() => {
      mock.emit(first, { kind: 'done' });
    });
    expect(opts.addClaudeComment).not.toHaveBeenCalled();

    act(() => {
      mock.emit(second, {
        kind: 'delta',
        text: '```quill-comments\n{"comments":[{"find":"doc","comment":"y"}]}\n```',
      });
      mock.emit(second, { kind: 'done' });
    });
    expect(opts.addClaudeComment).toHaveBeenCalledWith('doc', 'y');
  });
});
