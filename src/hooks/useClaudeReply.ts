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

function buildPrompt(comment: Comment, userText: string, docMarkdown: string): string {
  const threadLines: string[] = [];
  for (const reply of comment.replies) {
    if (reply.id === userText) continue;
    if (reply.pending) continue;
    const who = reply.authorKind === 'ai' ? 'Claude' : reply.author;
    threadLines.push(`- ${who}: ${reply.text}`);
  }
  threadLines.push(`- User just said: ${userText}`);

  return [
    'You are responding inline on a markdown document you previously authored.',
    'Reply concisely; do not rewrite the document.',
    '',
    `Anchor (the text the user highlighted): "${comment.anchorText}"`,
    '',
    'Comment thread so far:',
    threadLines.join('\n'),
    '',
    'Current document (may have been edited since you wrote it):',
    '---',
    docMarkdown,
    '---',
  ].join('\n');
}

export function useClaudeReply(opts: UseClaudeReplyOptions): UseClaudeReplyReturn {
  const tokensRef = useRef<Map<string, string>>(new Map());

  const ask = useCallback(
    async (comment: Comment, userText: string, binding: AISessionBinding) => {
      const replyId = opts.startAIReply(comment.id);
      const prompt = buildPrompt(comment, userText, opts.getDocMarkdown());

      const channel = new Channel<ChunkEvent>();
      channel.onmessage = (msg) => {
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
    try {
      await invoke('cancel_claude_resume', { cancelToken: token });
    } catch (e) {
      console.error('Failed to cancel claude reply:', e);
    }
  }, []);

  return { ask, cancel };
}
