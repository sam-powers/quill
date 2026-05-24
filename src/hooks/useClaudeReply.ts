import { useCallback, useRef } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { AISessionBinding, Comment } from '../types';

type ChunkEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

interface UseClaudeReplyOptions {
  startAIReply: (commentId: string) => string;
  appendAIReplyChunk: (commentId: string, replyId: string, chunk: string) => void;
  finishAIReply: (commentId: string, replyId: string) => void;
  failAIReply: (commentId: string, replyId: string, message: string) => void;
  getDocMarkdown: () => string;
}

interface UseClaudeReplyReturn {
  ask: (comment: Comment, userText: string, binding: AISessionBinding) => Promise<void>;
  cancel: (replyId: string) => Promise<void>;
}

interface CompactionInfo {
  compacted: boolean;
  originalMarkdown: string | null;
}

function lineDiff(original: string, current: string): string {
  const o = original.split('\n');
  const c = current.split('\n');
  const out: string[] = [];
  const max = Math.max(o.length, c.length);
  for (let i = 0; i < max; i++) {
    const a = o[i];
    const b = c[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }
  return out.length === 0 ? '(no textual diff)' : out.join('\n');
}

function buildPrompt(
  comment: Comment,
  userText: string,
  docMarkdown: string,
  compaction: CompactionInfo | null,
): string {
  const threadLines: string[] = [];
  for (const reply of comment.replies) {
    if (reply.id === userText) continue;
    if (reply.pending) continue;
    const who = reply.authorKind === 'ai' ? 'Claude' : reply.author;
    threadLines.push(`- ${who}: ${reply.text}`);
  }
  threadLines.push(`- User just said: ${userText}`);

  const head = [
    'You are responding inline on a markdown document you previously authored.',
    'Reply concisely; do not rewrite the document.',
    '',
    `Anchor (the text the user highlighted): "${comment.anchorText}"`,
    '',
    'Comment thread so far:',
    threadLines.join('\n'),
    '',
  ];

  if (compaction && !compaction.compacted && compaction.originalMarkdown) {
    return [
      ...head,
      'Your context is intact; here is the diff between what you originally wrote and what the doc looks like now:',
      '---',
      lineDiff(compaction.originalMarkdown, docMarkdown),
      '---',
    ].join('\n');
  }

  return [
    ...head,
    compaction?.compacted
      ? 'Your context was compacted since you wrote this; full current document follows:'
      : 'Current document (may have been edited since you wrote it):',
    '---',
    docMarkdown,
    '---',
  ].join('\n');
}

interface QuillMock {
  spawn: (
    args: { sessionId: string; cwd: string; prompt: string },
    onEvent: (event: ChunkEvent) => void,
  ) => string; // returns cancel token
  cancel?: (token: string) => void;
  compaction?: CompactionInfo;
}

declare global {
  interface Window {
    __quillMock?: QuillMock;
    __quillTestSession?: AISessionBinding;
  }
}

export function useClaudeReply(opts: UseClaudeReplyOptions): UseClaudeReplyReturn {
  const tokensRef = useRef<Map<string, string>>(new Map());

  const ask = useCallback(
    async (comment: Comment, userText: string, binding: AISessionBinding) => {
      const replyId = opts.startAIReply(comment.id);
      const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;

      let compaction: CompactionInfo | null = mock?.compaction ?? null;
      if (!mock) {
        try {
          compaction = await invoke<CompactionInfo>('check_session_compacted', {
            sessionId: binding.sessionId,
          });
        } catch (e) {
          console.warn('check_session_compacted failed:', e);
        }
      }
      const prompt = buildPrompt(comment, userText, opts.getDocMarkdown(), compaction);

      const dispatch = (msg: ChunkEvent) => {
        if (msg.kind === 'delta') {
          opts.appendAIReplyChunk(comment.id, replyId, msg.text);
        } else if (msg.kind === 'done' || msg.kind === 'cancelled') {
          opts.finishAIReply(comment.id, replyId);
          tokensRef.current.delete(replyId);
        } else if (msg.kind === 'error') {
          opts.failAIReply(comment.id, replyId, msg.message);
          tokensRef.current.delete(replyId);
        }
      };

      if (mock) {
        const token = mock.spawn(
          { sessionId: binding.sessionId, cwd: binding.cwd, prompt },
          dispatch,
        );
        tokensRef.current.set(replyId, token);
        return;
      }

      const channel = new Channel<ChunkEvent>();
      channel.onmessage = dispatch;

      try {
        const cancelToken = await invoke<string>('spawn_claude_resume', {
          sessionId: binding.sessionId,
          cwd: binding.cwd,
          prompt,
          onEvent: channel,
        });
        tokensRef.current.set(replyId, cancelToken);
      } catch (e) {
        opts.failAIReply(comment.id, replyId, String(e));
      }
    },
    [opts],
  );

  const cancel = useCallback(async (replyId: string) => {
    const token = tokensRef.current.get(replyId);
    if (!token) return;
    const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;
    if (mock) {
      mock.cancel?.(token);
      return;
    }
    try {
      await invoke('cancel_claude_resume', { cancelToken: token });
    } catch (e) {
      console.error('Failed to cancel claude reply:', e);
    }
  }, []);

  return { ask, cancel };
}
