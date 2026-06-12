import { useCallback, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { AISessionBinding, QuillCommentsBlock, QuillEdit, QuillEditsBlock } from '../types';
import type { ChunkEvent, PromptContext } from './useClaudeReply';

export const EDITS_FENCE = '```quill-edits';
export const COMMENTS_FENCE = '```quill-comments';

/** What the user asked for in the review modal. */
export interface ReviewOptions {
  guidance: string;
  makeComments: boolean;
  makeSuggestions: boolean;
}

export type ReviewPhase =
  | { status: 'idle' }
  | { status: 'streaming'; text: string }
  | {
      status: 'done';
      text: string;
      commentsAdded: number;
      suggestionsApplied: number;
      /** Items whose `find` couldn't be located in the document. */
      skipped: number;
    }
  | { status: 'error'; message: string };

interface UseDocumentReviewOptions {
  getDocMarkdown: () => string;
  /** The document's linked context folder, if any (read at review time). */
  getContextFolder: () => string | null;
  /** Apply Claude's proposed edits as doc-scoped tracked suggestions. */
  applyTrackedEdits: (edits: QuillEdit[]) => { applied: number; skipped: number };
  /** Anchor one Claude margin comment; false when `find` can't be located. */
  addClaudeComment: (find: string, body: string) => boolean;
}

interface UseDocumentReviewReturn {
  phase: ReviewPhase;
  start: (options: ReviewOptions, binding: AISessionBinding) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

/**
 * Extract the text between a named opening fence and its closing ``` —
 * null until the block is complete. Exported for tests.
 */
export function extractFencedBlock(raw: string, fence: string): string | null {
  const start = raw.indexOf(fence);
  if (start === -1) return null;
  const afterFence = raw.slice(start + fence.length);
  const close = afterFence.indexOf('```');
  if (close === -1) return null;
  return afterFence.slice(0, close).trim();
}

/** The prose before the first review fence — the user-visible part. */
export function reviewVisible(raw: string): string {
  const starts = [raw.indexOf(COMMENTS_FENCE), raw.indexOf(EDITS_FENCE)].filter((i) => i !== -1);
  if (starts.length === 0) return raw;
  return raw.slice(0, Math.min(...starts)).replace(/\n+$/, '');
}

/**
 * How many trailing characters of the accumulated stream could still grow
 * into a review fence: the longest suffix that is a prefix of either fence
 * string. Ordinary prose streams through with zero holdback. Exported for
 * tests.
 */
export function fenceHoldback(accum: string): number {
  let hold = 0;
  for (const fence of [COMMENTS_FENCE, EDITS_FENCE]) {
    const cap = Math.min(fence.length - 1, accum.length);
    for (let n = cap; n > hold; n--) {
      if (fence.startsWith(accum.slice(accum.length - n))) {
        hold = n;
        break;
      }
    }
  }
  return hold;
}

/** Exported for tests. */
export function buildReviewPrompt(
  options: ReviewOptions,
  docMarkdown: string,
  context: PromptContext | null,
  freshSession = false,
): string {
  const guidance = options.guidance.trim();
  const head = [
    // A session Quill minted for this doc never wrote it — don't claim it did.
    freshSession
      ? 'You are reviewing a markdown document the user is editing in Quill.'
      : 'You are reviewing a markdown document you previously authored, now edited by the user in Quill.',
    '',
    'The user asked for a review of the FULL document.',
    guidance
      ? `User guidance for this review: ${guidance}`
      : 'No specific guidance was given — review for clarity, correctness, and flow.',
    '',
  ];

  const respond: string[] = [
    'HOW TO RESPOND:',
    'Start with a one-or-two sentence overall assessment in prose.',
  ];

  if (options.makeComments) {
    respond.push(
      '',
      'To leave margin comments (observations, questions, judgment calls the user should weigh), append a fenced block:',
      '',
      '```quill-comments',
      '{"comments":[{"find":"<exact substring of the document text>","comment":"<concise, actionable remark>"}]}',
      '```',
      '',
      'Each comment is anchored to the text matched by its "find". Prefer a handful of high-value comments over many trivial ones.',
    );
  }
  if (options.makeSuggestions) {
    respond.push(
      '',
      'To propose concrete text changes (applied as tracked suggestions the user accepts or rejects one by one), append a fenced block:',
      '',
      '```quill-edits',
      '{"summary":"<one short sentence describing what you changed>","edits":[{"find":"<exact original substring>","replace":"<new text>"}]}',
      '```',
    );
  }

  respond.push(
    '',
    'Rules for "find" strings:',
    '- Each "find" must be an EXACT substring of the document text below, copied verbatim as PLAIN TEXT. Do NOT include markdown syntax such as leading "- ", "* ", or "#"; match only the visible characters.',
    '- Make "find" strings long/unique enough to be unambiguous.',
  );
  if (options.makeSuggestions) {
    respond.push(
      '- To delete text, use an empty "replace". To insert, set "find" to a short unique substring and include it at the start of "replace".',
    );
  }
  if (options.makeComments && options.makeSuggestions) {
    respond.push(
      '- Use comments for judgment calls the user should decide; use edits for changes you are confident in. Do not make the same point in both.',
    );
  } else if (options.makeComments) {
    respond.push(
      '- Do NOT propose text changes or output a quill-edits block — the user asked for comments only.',
    );
  } else {
    respond.push(
      '- Do NOT output a quill-comments block — the user asked for tracked-change suggestions only.',
    );
  }
  respond.push('- If the document needs no changes, say so in the prose and omit the blocks.', '');

  const contextSection = context
    ? [
        '=== REFERENCE FOLDER ===',
        `The user attached a folder of reference documents at: ${context.folder}`,
        'You have read access to it. When a file below is relevant to the review, read it before answering.',
        ...(context.files.length > 0
          ? context.files.map((f) => `- ${f}`)
          : ['(no readable documents found in the folder)']),
        '',
      ]
    : [];

  return [
    ...head,
    ...respond,
    ...contextSection,
    '=== DOCUMENT ===',
    '---',
    docMarkdown,
    '---',
  ].join('\n');
}

/**
 * Full-document review: sends the whole document (plus the user's guidance)
 * to the linked Claude session and turns the reply's quill-comments block
 * into anchored margin comments and its quill-edits block into doc-scoped
 * tracked-change suggestions. Reuses the same spawn/stream machinery (and
 * `window.__quillMock` test seam) as useClaudeReply, but streams into the
 * review modal instead of a comment thread.
 */
export function useDocumentReview(opts: UseDocumentReviewOptions): UseDocumentReviewReturn {
  const [phase, setPhase] = useState<ReviewPhase>({ status: 'idle' });
  const tokenRef = useRef<string | null>(null);

  const start = useCallback(
    async (options: ReviewOptions, binding: AISessionBinding) => {
      setPhase({ status: 'streaming', text: '' });
      const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;

      // Manifest for the linked context folder. A scan failure (folder moved,
      // permissions) must not block the review — degrade to no context section.
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

      // A review always sends the full document, so the compaction check that
      // gates the comment-reply diff is irrelevant here.
      const prompt = buildReviewPrompt(
        options,
        opts.getDocMarkdown(),
        context,
        binding.createdByQuill === true,
      );

      let rawAccum = '';

      // The streamed text shown in the modal: everything before the first
      // fence, holding back any trailing run that could still grow into one.
      const visibleNow = (flush: boolean): string => {
        const hasFence = rawAccum.includes(COMMENTS_FENCE) || rawAccum.includes(EDITS_FENCE);
        if (hasFence || flush) return reviewVisible(rawAccum);
        return rawAccum.slice(0, rawAccum.length - fenceHoldback(rawAccum));
      };

      const finalize = () => {
        tokenRef.current = null;
        let commentsAdded = 0;
        let suggestionsApplied = 0;
        let skipped = 0;

        // Comments anchor first: marks don't move text, so the edits applied
        // below can't invalidate positions the comment `find`s located.
        // A block the user's checkboxes didn't ask for is ignored.
        if (options.makeComments) {
          const block = extractFencedBlock(rawAccum, COMMENTS_FENCE);
          if (block) {
            try {
              const parsed = JSON.parse(block) as QuillCommentsBlock;
              if (Array.isArray(parsed.comments)) {
                for (const c of parsed.comments) {
                  if (
                    typeof c?.find === 'string' &&
                    typeof c?.comment === 'string' &&
                    opts.addClaudeComment(c.find, c.comment)
                  ) {
                    commentsAdded++;
                  } else {
                    skipped++;
                  }
                }
              }
            } catch (e) {
              console.warn('Failed to parse quill-comments block:', e);
            }
          }
        }

        if (options.makeSuggestions) {
          const block = extractFencedBlock(rawAccum, EDITS_FENCE);
          if (block) {
            try {
              const parsed = JSON.parse(block) as QuillEditsBlock;
              if (Array.isArray(parsed.edits) && parsed.edits.length > 0) {
                const res = opts.applyTrackedEdits(parsed.edits);
                suggestionsApplied = res.applied;
                skipped += res.skipped;
              }
            } catch (e) {
              console.warn('Failed to parse quill-edits block:', e);
            }
          }
        }

        setPhase({
          status: 'done',
          text: visibleNow(true),
          commentsAdded,
          suggestionsApplied,
          skipped,
        });
      };

      const dispatch = (msg: ChunkEvent) => {
        if (msg.kind === 'delta') {
          rawAccum += msg.text;
          setPhase({ status: 'streaming', text: visibleNow(false) });
        } else if (msg.kind === 'done') {
          finalize();
        } else if (msg.kind === 'cancelled') {
          // The user pulled the plug — discard partial output, back to compose.
          tokenRef.current = null;
          setPhase({ status: 'idle' });
        } else {
          tokenRef.current = null;
          setPhase({ status: 'error', message: msg.message });
        }
      };

      if (mock) {
        tokenRef.current = mock.spawn(
          {
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            prompt,
            addDir: contextFolder,
            allowCreate: binding.createdByQuill === true,
          },
          dispatch,
        );
        return;
      }

      const channel = new Channel<ChunkEvent>();
      channel.onmessage = dispatch;

      try {
        tokenRef.current = await invoke<string>('spawn_claude_resume', {
          sessionId: binding.sessionId,
          cwd: binding.cwd,
          prompt,
          addDir: contextFolder,
          allowCreate: binding.createdByQuill === true,
          onEvent: channel,
        });
      } catch (e) {
        setPhase({ status: 'error', message: String(e) });
      }
    },
    [opts],
  );

  const cancel = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;
    if (mock) {
      mock.cancel?.(token);
      return;
    }
    try {
      await invoke('cancel_claude_resume', { cancelToken: token });
    } catch (e) {
      console.error('Failed to cancel document review:', e);
    }
  }, []);

  const reset = useCallback(() => setPhase({ status: 'idle' }), []);

  return { phase, start, cancel, reset };
}
