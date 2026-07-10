import { useCallback, useRef } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { AISessionBinding, Comment, EditScope, QuillEdit, QuillEditsBlock } from '../types';

export type ChunkEvent =
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
  cancelAIReply: (commentId: string, replyId: string) => void;
  retryAIReply: (commentId: string, replyId: string) => void;
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

/** How a failed @claude reply should be recovered from, derived from its message. */
export type ReplyErrorKind = 'transient' | 'session' | 'auth' | 'unknown';

export interface ReplyErrorClass {
  retryable: boolean;
  kind: ReplyErrorKind;
}

// Ordered specific-before-broad: a message like "No conversation found (timeout)"
// must classify as `session` (re-link is the fix), not `transient`. Each rule's
// `test` runs against a lowercased copy of the message, so patterns are lowercase.
const REPLY_ERROR_RULES: {
  kind: ReplyErrorKind;
  retryable: boolean;
  test: (m: string) => boolean;
}[] = [
  {
    kind: 'session',
    retryable: true, // retryable, but the UI leads with Re-link
    test: (m) =>
      m.includes('no conversation found') ||
      m.includes('session id') ||
      m.includes('session not found'),
  },
  {
    // Deliberately match the specific longer tokens, never a bare "auth" —
    // "author"/"authority" and similar appear in unrelated infra messages.
    // `401` and `login` are word-boundary-anchored so a port/line number like
    // "24010" or a hostname like "mylogin.example.com" can't force a
    // non-retryable auth verdict onto an otherwise retryable failure.
    kind: 'auth',
    retryable: false,
    test: (m) =>
      m.includes('authentication') ||
      m.includes('unauthorized') ||
      /\b401\b/.test(m) ||
      /\blogin\b/.test(m) ||
      m.includes('api key') ||
      m.includes('credentials'),
  },
  {
    kind: 'transient',
    retryable: true,
    test: (m) =>
      m.includes('api error') ||
      /\b(429|500|502|503|529)\b/.test(m) ||
      m.includes('overloaded') ||
      m.includes('timeout') ||
      m.includes('network') ||
      m.includes('rate limit') ||
      m.includes('econn') ||
      m.includes('thinking.type'),
  },
];

/**
 * Classify a failed @claude reply's error message to drive recovery UI.
 * Matching is case-insensitive and ordered (specific kinds win over broad ones).
 * Unmatched or empty input is `unknown` — deliberately retryable, since a wrong
 * Retry only costs one re-run while a wrong Re-link misdirects the user.
 */
export function classifyReplyError(message: string): ReplyErrorClass {
  const m = (message ?? '').toLowerCase();
  for (const rule of REPLY_ERROR_RULES) {
    if (rule.test(m)) return { retryable: rule.retryable, kind: rule.kind };
  }
  return { retryable: true, kind: 'unknown' };
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
  /** Re-issue the identical request for a failed reply, reusing its replyId. */
  retry: (replyId: string) => Promise<void>;
}

/** The inputs a reply was asked with, stashed so a retry can re-issue them. */
interface ReplyInputs {
  comment: Comment;
  userText: string;
  binding: AISessionBinding;
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
    args: {
      sessionId: string;
      cwd: string;
      prompt: string;
      addDir: string | null;
    },
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

// Low-level dispatch to cancel a spawned reply by its token: routes to the e2e
// mock when present, otherwise the Tauri command. Rejects (rather than throwing
// synchronously) so every caller can settle it with its own error posture —
// swallow for orphan cleanup, log for a user-initiated cancel.
async function sendCancel(token: string): Promise<void> {
  const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;
  if (mock) {
    mock.cancel?.(token);
    return;
  }
  await invoke('cancel_claude_resume', { cancelToken: token });
}

export function useClaudeReply(opts: UseClaudeReplyOptions): UseClaudeReplyReturn {
  const tokensRef = useRef<Map<string, string>>(new Map());
  // Transient, in-memory only — NEVER persisted to the sidecar. Keyed by
  // replyId so a retry can re-issue the exact same request.
  const inputsRef = useRef<Map<string, ReplyInputs>>(new Map());
  // Per-replyId generation counter. A retry reuses the same replyId, so a late
  // event from the superseded original must not clobber the retried reply; each
  // spawn captures its generation and drops events once it's no longer current.
  const genRef = useRef<Map<string, number>>(new Map());
  // Guards against a double-fire retry (e.g. an impatient double-click) while a
  // retry for the same replyId is already being launched.
  const retryingRef = useRef<Set<string>>(new Set());

  // Best-effort cancel of a still-tracked spawn, e.g. when a stale generation
  // terminates or a retry supersedes a slow original. Never throws into a
  // stream handler.
  const orphanCancel = useCallback((replyId: string) => {
    const token = tokensRef.current.get(replyId);
    if (!token) return;
    tokensRef.current.delete(replyId);
    void sendCancel(token).catch(() => {
      // ignore — the child may already be gone
    });
  }, []);

  // Shared spawn/stream core for both the first ask and a retry. `replyId` is
  // already reset to a pending state by the caller (startAIReply / retryAIReply).
  const runSpawn = useCallback(
    async (replyId: string, comment: Comment, userText: string, binding: AISessionBinding) => {
      // Claim the next generation for this replyId. Any spawn still streaming
      // under an earlier generation is now stale and its events are dropped.
      const generation = (genRef.current.get(replyId) ?? 0) + 1;
      genRef.current.set(replyId, generation);
      const isCurrent = () => genRef.current.get(replyId) === generation;

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

      // This spawn's own cancel token, captured as soon as the spawn returns it.
      // The dispatch closure cancels/untracks by THIS token, never by replyId —
      // after a retry the replyId points at the newer spawn, so a stale event
      // resolving orphanCancel(replyId) would tear down the live retry instead.
      let spawnToken: string | undefined;

      const dispatch = (msg: ChunkEvent) => {
        // A superseded spawn (a slower original that a retry replaced) must not
        // mutate the reply the newer generation now owns. Drop its events; on a
        // terminal event, tear down THIS orphaned child by its own token.
        if (!isCurrent()) {
          if (msg.kind === 'done' || msg.kind === 'cancelled' || msg.kind === 'error') {
            if (spawnToken !== undefined) void sendCancel(spawnToken).catch(() => {});
          }
          return;
        }
        if (msg.kind === 'delta') {
          rawAccum += msg.text;
          emitVisible(false);
        } else if (msg.kind === 'done') {
          emitVisible(true);
          finalize();
          opts.finishAIReply(comment.id, replyId);
          if (tokensRef.current.get(replyId) === spawnToken) tokensRef.current.delete(replyId);
          inputsRef.current.delete(replyId);
        } else if (msg.kind === 'cancelled') {
          // User stopped this reply. Do NOT finalize — a half-streamed reply
          // must not apply partial tracked edits or masquerade as a finished
          // answer. Mark it cancelled (a neutral, retryable state) and keep the
          // stashed inputs so the Re-run button can re-issue the request.
          opts.cancelAIReply(comment.id, replyId);
          if (tokensRef.current.get(replyId) === spawnToken) tokensRef.current.delete(replyId);
        } else if (msg.kind === 'error') {
          opts.failAIReply(comment.id, replyId, msg.message);
          if (tokensRef.current.get(replyId) === spawnToken) tokensRef.current.delete(replyId);
          // Keep the stashed inputs — a retry needs them.
        }
      };

      if (mock) {
        spawnToken = mock.spawn(
          {
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            prompt,
            addDir: contextFolder,
          },
          dispatch,
        );
        tokensRef.current.set(replyId, spawnToken);
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
        spawnToken = cancelToken;
        if (!isCurrent()) {
          // A retry superseded this spawn while we awaited — cancel the orphan
          // rather than tracking it against a replyId the newer generation owns.
          // Route through sendCancel so the e2e mock's cancel fires too (a raw
          // invoke would skip it and leak the orphan in mock-driven tests).
          void sendCancel(cancelToken).catch(() => {});
          return;
        }
        tokensRef.current.set(replyId, cancelToken);
      } catch (e) {
        if (isCurrent()) opts.failAIReply(comment.id, replyId, String(e));
      }
    },
    [opts],
  );

  const ask = useCallback(
    async (comment: Comment, userText: string, binding: AISessionBinding) => {
      const replyId = opts.startAIReply(comment.id);
      inputsRef.current.set(replyId, { comment, userText, binding });
      await runSpawn(replyId, comment, userText, binding);
    },
    [opts, runSpawn],
  );

  const retry = useCallback(
    async (replyId: string) => {
      if (retryingRef.current.has(replyId)) return; // double-fire guard
      const inputs = inputsRef.current.get(replyId);
      if (!inputs) return; // nothing to re-issue (no-op, no throw)
      retryingRef.current.add(replyId);
      try {
        // Tear down any orphan the failed original may have left tracked, then
        // reset the reply in place (reuses the same entry, clears the error).
        orphanCancel(replyId);
        opts.retryAIReply(inputs.comment.id, replyId);
        // Re-issue the identical request against the same comment. Ranges are
        // re-read live inside runSpawn via opts.getRangeTexts.
        await runSpawn(replyId, inputs.comment, inputs.userText, inputs.binding);
      } finally {
        retryingRef.current.delete(replyId);
      }
    },
    [opts, runSpawn, orphanCancel],
  );

  const cancel = useCallback(
    async (replyId: string) => {
      // Supersede this reply synchronously — don't gate on a token that may not
      // exist yet. A Cancel click can land while runSpawn is still awaiting
      // spawn_claude_resume (no token tracked), or before the backend emits a
      // `cancelled` event it may never send. Bumping the generation makes the
      // pending runSpawn's post-await isCurrent() false, so it orphan-cancels
      // its own child instead of streaming to completion.
      genRef.current.set(replyId, (genRef.current.get(replyId) ?? 0) + 1);
      const commentId = inputsRef.current.get(replyId)?.comment.id;
      if (commentId) opts.cancelAIReply(commentId, replyId);

      // If a token is already tracked, tear its child down now; the generation
      // bump alone won't reach an in-flight child that has stopped checking.
      const token = tokensRef.current.get(replyId);
      if (!token) return;
      tokensRef.current.delete(replyId);
      try {
        await sendCancel(token);
      } catch (e) {
        console.error('Failed to cancel claude reply:', e);
      }
    },
    [opts],
  );

  return { ask, cancel, retry };
}
