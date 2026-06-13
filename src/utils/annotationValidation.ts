import type {
  Comment,
  Reply,
  Suggestion,
  SuggestionType,
  SuggestionStatus,
  AISessionBinding,
} from '../types';

/**
 * Validation for deserialized annotation data (sidecar + recovery draft).
 *
 * The sidecar and draft are JSON files Quill reads back from disk. They are not
 * always Quill's own well-formed output: a file can be hand-edited, truncated by
 * a crash, corrupted, or — since `.comments.json` sits next to a shared `.md` —
 * supplied by someone else. The editor trusts annotation positions structurally:
 * a comment's `from`/`to` flow into `doc.resolve`, which **throws** on a negative,
 * fractional, `NaN`, or otherwise nonsensical position, white-screening the app
 * on open.
 *
 * So we validate at the deserialization boundary, before any record reaches React
 * state or the editor. The contract is deliberately lenient about *missing* data
 * (a malformed record is dropped, not fatal) and strict about *shape* (every
 * record that survives is structurally sound). Positions are coerced to
 * finite, non-negative integers; out-of-document positions are still clamped at
 * render time, so the only job here is to guarantee `doc.resolve` can't throw.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A finite, non-negative, integer position — or null if the input can't be one. */
function toPosition(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function sanitizeReply(raw: unknown): Reply | null {
  if (!isObject(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  return {
    id: raw.id,
    author: typeof raw.author === 'string' ? raw.author : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    ...(raw.authorKind === 'user' || raw.authorKind === 'ai' ? { authorKind: raw.authorKind } : {}),
    ...(typeof raw.pending === 'boolean' ? { pending: raw.pending } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  };
}

function sanitizeComment(raw: unknown): Comment | null {
  if (!isObject(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  const from = toPosition(raw.from);
  const to = toPosition(raw.to);
  if (from === null || to === null) return null;
  const replies = Array.isArray(raw.replies)
    ? raw.replies.map(sanitizeReply).filter((r): r is Reply => r !== null)
    : [];
  return {
    id: raw.id,
    anchorText: typeof raw.anchorText === 'string' ? raw.anchorText : '',
    from: Math.min(from, to),
    to: Math.max(from, to),
    author: typeof raw.author === 'string' ? raw.author : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    resolved: raw.resolved === true,
    replies,
  };
}

const SUGGESTION_TYPES: SuggestionType[] = ['insertion', 'deletion'];
const SUGGESTION_STATUSES: SuggestionStatus[] = ['pending', 'accepted', 'rejected'];

function sanitizeSuggestion(raw: unknown): Suggestion | null {
  if (!isObject(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (!SUGGESTION_TYPES.includes(raw.type as SuggestionType)) return null;
  const from = toPosition(raw.from);
  const to = toPosition(raw.to);
  if (from === null || to === null) return null;
  const status = SUGGESTION_STATUSES.includes(raw.status as SuggestionStatus)
    ? (raw.status as SuggestionStatus)
    : 'pending';
  return {
    id: raw.id,
    type: raw.type as SuggestionType,
    from: Math.min(from, to),
    to: Math.max(from, to),
    originalText: typeof raw.originalText === 'string' ? raw.originalText : '',
    suggestedText: typeof raw.suggestedText === 'string' ? raw.suggestedText : '',
    author: typeof raw.author === 'string' ? raw.author : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    status,
  };
}

/** Drop any non-array input and any record that fails the shape check. */
export function sanitizeComments(raw: unknown): Comment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeComment).filter((c): c is Comment => c !== null);
}

export function sanitizeSuggestions(raw: unknown): Suggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeSuggestion).filter((s): s is Suggestion => s !== null);
}

/**
 * An AI session binding is all-or-nothing: a partial binding can't resume a
 * conversation and would only mislead the UI, so anything missing a required
 * field becomes `undefined` (unbound).
 */
export function sanitizeAISession(raw: unknown): AISessionBinding | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.provider !== 'claude-code') return undefined;
  if (
    !isNonEmptyString(raw.sessionId) ||
    typeof raw.cwd !== 'string' ||
    typeof raw.linkedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    provider: 'claude-code',
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    linkedAt: raw.linkedAt,
    ...(raw.createdByQuill === true ? { createdByQuill: true } : {}),
  };
}

/** A context folder is a non-empty string path or nothing. */
export function sanitizeContextFolder(raw: unknown): string | undefined {
  return isNonEmptyString(raw) ? raw : undefined;
}
