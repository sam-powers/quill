import { useCallback, useRef } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { AISessionBinding, Comment, EditScope, QuillEdit, QuillEditsBlock } from '../types';

type ChunkEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

/** Live text for a comment's anchored range and its enclosing paragraph. */
export interface RangeTexts {
  highlightText: string;
  paragraphText: string;
}

interface UseClaudeReplyOptions {
  startAIReply: (commentId: string) => string;
  appendAIReplyChunk: (commentId: string, replyId: string, chunk: string) => void;
  finishAIReply: (commentId: string, replyId: string) => void;
  failAIReply: (commentId: string, replyId: string, message: string) => void;
  getDocMarkdown: () => string;
  /** Read the current document text for a comment's range + paragraph. */
  getRangeTexts: (comment: Comment) => RangeTexts;
  /** Apply Claude's proposed edits as tracked-change suggestions. */
  applyTrackedEdits: (
    comment: Comment,
    edits: QuillEdit[],
    scope: EditScope,
  ) => { applied: number; skipped: number };
  /** The document's linked context folder, if any (read at ask time). */
  getContextFolder: () => string | null;
}

/** The linked context folder and its file manifest, for the prompt. */
export interface PromptContext {
  folder: string;
  files: string[];
}

const FENCE = '```quill-edits';

/**
 * Decide how far Claude's edits may reach from the user's wording. Defaults to
 * the highlight; only explicit "whole paragraph"/"whole doc" phrasing widens it.
 */
export function detectScope(userText: string): EditScope {
  if (/\bwhole doc\b|\bwhole document\b|\bentire doc(ument)?\b/i.test(userText)) return 'doc';
  if (/\bwhole paragraph\b|\bentire paragraph\b|\bthis paragraph\b/i.test(userText))
    return 'paragraph';
  return 'highlight';
}

/**
 * Split a raw Claude reply into the user-visible prose and the (optional)
 * quill-edits JSON. `visible` is everything before the fence (trimmed of the
 * trailing fence/newlines). `block` is the JSON text between the opening and
 * closing fences, or null if no complete block is present.
 */
export function splitVisible(raw: string): { visible: string; block: string | null } {
  const start = raw.indexOf(FENCE);
  if (start === -1) return { visible: raw, block: null };
  const visible = raw.slice(0, start).replace(/\n+$/, '');
  const afterFence = raw.slice(start + FENCE.length);
  const close = afterFence.indexOf('```');
  if (close === -1) return { visible, block: null };
  return { visible, block: afterFence.slice(0, close).trim() };
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

const SCOPE_INSTRUCTION: Record<EditScope, string> = {
  highlight: 'Edit ONLY the highlighted text. Do not change the rest of the paragraph or document.',
  paragraph:
    'The user asked to edit the whole paragraph — you may edit anywhere in the PARAGRAPH section, but not beyond it.',
  doc: 'The user asked to edit the whole document — you may edit anywhere in the document.',
};

/** Exported for tests. */
export function buildPrompt(
  comment: Comment,
  userText: string,
  docMarkdown: string,
  ranges: RangeTexts,
  scope: EditScope,
  compaction: CompactionInfo | null,
  context: PromptContext | null,
): string {
  // `userText` is appended explicitly as the final line below. Depending on
  // when React flushed state, the same message may or may not already be the
  // thread's last reply — drop that copy so Claude doesn't see it twice.
  const replies = comment.replies.filter((r) => !r.pending);
  const last = replies[replies.length - 1];
  if (last && last.authorKind !== 'ai' && last.text === userText) replies.pop();

  const threadLines: string[] = [];
  for (const reply of replies) {
    const who = reply.authorKind === 'ai' ? 'Claude' : reply.author;
    threadLines.push(`- ${who}: ${reply.text}`);
  }
  threadLines.push(`- User just said: ${userText}`);

  const head = [
    'You are responding inline on a markdown document you previously authored.',
    '',
    'Comment thread so far:',
    threadLines.join('\n'),
    '',
  ];

  const editProtocol = [
    'HOW TO RESPOND:',
    'If the user is asking a question or for an opinion, reply concisely in prose and do NOT propose edits.',
    'If the user is asking you to rewrite, fix, revise, restructure, shorten, expand, or otherwise change the text (e.g. "fix the grammar", "make this a list", "turn this into prose"), make the changes as tracked suggestions by appending EXACTLY ONE fenced block at the very end of your reply:',
    '',
    '```quill-edits',
    '{"summary":"<one short sentence describing what you changed>","edits":[{"find":"<exact original substring>","replace":"<new text>"}]}',
    '```',
    '',
    'Rules for the edits block:',
    `- ${SCOPE_INSTRUCTION[scope]}`,
    '- Each "find" must be an EXACT substring of the EDIT-ONLY-THIS text below, copied verbatim as PLAIN TEXT. Do NOT include markdown syntax such as leading "- ", "* ", or "#"; match only the visible characters.',
    '- Make "find" strings long/unique enough to be unambiguous. To turn a bullet list into prose, set "find" to the run of list-item text and "replace" to the prose.',
    '- To delete text, use an empty "replace". To insert, you may set "find" to a short unique substring and include it at the start of "replace".',
    '- Keep any prose before the block to one or two sentences; the "summary" is what the user sees, so write it as a human editor would ("Fixed subject-verb agreement and tightened the opening.").',
    '- Output the block only when you actually changed something. If nothing needs changing, omit it.',
    '',
    `=== EDIT ONLY THIS (highlighted) ===`,
    ranges.highlightText,
    `=== PARAGRAPH (context) ===`,
    ranges.paragraphText,
    '',
  ];

  const contextSection = context
    ? [
        '=== REFERENCE FOLDER ===',
        `The user attached a folder of reference documents at: ${context.folder}`,
        'You have read access to it. When a file below is relevant to the request, read it before answering.',
        ...(context.files.length > 0
          ? context.files.map((f) => `- ${f}`)
          : ['(no readable documents found in the folder)']),
        '',
      ]
    : [];

  if (compaction && !compaction.compacted && compaction.originalMarkdown) {
    return [
      ...head,
      ...editProtocol,
      ...contextSection,
      '=== FULL DOCUMENT (context) ===',
      'Your context is intact; here is the diff between what you originally wrote and what the doc looks like now:',
      '---',
      lineDiff(compaction.originalMarkdown, docMarkdown),
      '---',
    ].join('\n');
  }

  return [
    ...head,
    ...editProtocol,
    ...contextSection,
    '=== FULL DOCUMENT (context) ===',
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
    args: { sessionId: string; cwd: string; prompt: string; addDir: string | null },
    onEvent: (event: ChunkEvent) => void,
  ) => string; // returns cancel token
  cancel?: (token: string) => void;
  compaction?: CompactionInfo;
  /** Manifest returned in place of the list_context_files invoke. */
  contextFiles?: string[];
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
      // Manifest for the linked context folder. A scan failure (folder moved,
      // permissions) must not block the reply — degrade to no context section.
      const contextFolder = opts.getContextFolder();
      let context: PromptContext | null = null;
      if (contextFolder) {
        let files: string[] = [];
        if (mock) {
          files = mock.contextFiles ?? [];
        } else {
          try {
            files = await invoke<string[]>('list_context_files', { folder: contextFolder });
          } catch (e) {
            console.warn('list_context_files failed:', e);
          }
        }
        context = { folder: contextFolder, files };
      }

      const scope = detectScope(userText);
      const ranges = opts.getRangeTexts(comment);
      const prompt = buildPrompt(
        comment,
        userText,
        opts.getDocMarkdown(),
        ranges,
        scope,
        compaction,
        context,
      );

      // Per-ask streaming state. We accumulate the raw text and only surface the
      // prose before the ```quill-edits fence to the thread. To avoid leaking a
      // partial fence when it straddles deltas, we hold back the last
      // (FENCE.length - 1) chars until we know they can't begin a fence.
      let rawAccum = '';
      let visibleEmitted = 0;

      const emitVisible = (flush: boolean) => {
        const fenceStart = rawAccum.indexOf(FENCE);
        // Once the fence is found, everything visible lives before it and is
        // final — nothing after it should ever reach the thread.
        const visibleCap = fenceStart === -1 ? rawAccum.length : fenceStart;
        // While no fence is seen yet, hold back only the trailing run that could
        // still grow into one — i.e. the longest suffix of what we've received
        // that is a prefix of FENCE. Ordinary prose (which can't begin a fence)
        // streams through immediately. At end-of-stream we flush everything.
        let holdback = 0;
        if (fenceStart === -1 && !flush) {
          for (let n = Math.min(FENCE.length - 1, rawAccum.length); n > 0; n--) {
            if (FENCE.startsWith(rawAccum.slice(rawAccum.length - n))) {
              holdback = n;
              break;
            }
          }
        }
        const safeEnd = Math.max(visibleEmitted, visibleCap - holdback);
        if (safeEnd > visibleEmitted) {
          opts.appendAIReplyChunk(comment.id, replyId, rawAccum.slice(visibleEmitted, safeEnd));
          visibleEmitted = safeEnd;
        }
      };

      const finalize = () => {
        const { visible, block } = splitVisible(rawAccum);
        let parsed: QuillEditsBlock | null = null;
        if (block) {
          try {
            parsed = JSON.parse(block) as QuillEditsBlock;
          } catch (e) {
            console.warn('Failed to parse quill-edits block:', e);
          }
        }

        if (parsed && Array.isArray(parsed.edits) && parsed.edits.length > 0) {
          // The prose we already streamed; if it was empty, surface the summary.
          if (rawAccum.slice(0, visibleEmitted).trim() === '' && parsed.summary) {
            opts.appendAIReplyChunk(comment.id, replyId, parsed.summary);
            visibleEmitted = rawAccum.indexOf(FENCE);
          }
          const { skipped } = opts.applyTrackedEdits(comment, parsed.edits, scope);
          if (skipped > 0) {
            const noun = skipped === 1 ? 'change' : 'changes';
            opts.appendAIReplyChunk(
              comment.id,
              replyId,
              `\n\n(${skipped} ${noun} could not be located in the text and ${skipped === 1 ? 'was' : 'were'} skipped.)`,
            );
          }
        } else {
          // No edits — make sure whatever prose we held back gets flushed. If a
          // fence was present but unparseable, `visible` excludes the bad block.
          if (visibleEmitted < visible.length) {
            opts.appendAIReplyChunk(comment.id, replyId, visible.slice(visibleEmitted));
            visibleEmitted = visible.length;
          }
        }
      };

      const dispatch = (msg: ChunkEvent) => {
        if (msg.kind === 'delta') {
          rawAccum += msg.text;
          emitVisible(false);
        } else if (msg.kind === 'done' || msg.kind === 'cancelled') {
          emitVisible(true);
          finalize();
          opts.finishAIReply(comment.id, replyId);
          tokensRef.current.delete(replyId);
        } else if (msg.kind === 'error') {
          opts.failAIReply(comment.id, replyId, msg.message);
          tokensRef.current.delete(replyId);
        }
      };

      if (mock) {
        const token = mock.spawn(
          { sessionId: binding.sessionId, cwd: binding.cwd, prompt, addDir: contextFolder },
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
          addDir: contextFolder,
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
