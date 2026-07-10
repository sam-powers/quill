export interface Reply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  authorKind?: 'user' | 'ai';
  pending?: boolean;
  error?: string;
  /** User stopped this @claude reply before it finished — a neutral, retryable
   * terminal state (distinct from `error`), offering a Re-run rather than an
   * error recovery. Transient/UI-only; never persisted to the sidecar. */
  cancelled?: boolean;
}

export interface AISessionBinding {
  provider: 'claude-code';
  sessionId: string;
  cwd: string;
  linkedAt: string;
}

export interface Comment {
  id: string;
  anchorText: string;
  from: number;
  to: number;
  author: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export type SuggestionType = 'insertion' | 'deletion';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface Suggestion {
  id: string;
  type: SuggestionType;
  from: number;
  to: number;
  originalText: string;
  suggestedText: string;
  author: string;
  createdAt: string;
  status: SuggestionStatus;
}

export interface SidecarFile {
  version: 2;
  comments: Comment[];
  suggestions: Suggestion[];
  aiSession?: AISessionBinding;
  /**
   * Absolute path to a folder of reference documents for this file. Claude
   * gets read access to it (`--add-dir`) plus a file manifest in the prompt.
   */
  contextFolder?: string;
}

export interface FileState {
  filePath: string | null;
  isDirty: boolean;
}

export interface TrackedChangeInfo {
  id: string;
  operation: 'insert' | 'delete';
  from: number;
  to: number;
  text: string;
  authorID: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  /**
   * Set on both halves of a replacement (a delete and an insert made by the
   * same step). Halves sharing a pairId render as one card and are accepted
   * or rejected together — pass the pairId to acceptChange / rejectChange.
   */
  pairId?: string;
}

/**
 * One quote-based edit Claude proposes inside a comment: replace the first
 * occurrence of the plaintext `find` (within the scoped range) with `replace`.
 * An empty `find` is a pure insertion; an empty `replace` is a pure deletion.
 */
export interface QuillEdit {
  find: string;
  replace: string;
}

/** The parsed contents of a ```quill-edits fenced block in Claude's reply. */
export interface QuillEditsBlock {
  summary: string;
  edits: QuillEdit[];
}

/** How far Claude's edits may reach, derived from the user's wording. */
export type EditScope = 'highlight' | 'paragraph' | 'doc';

/**
 * One margin comment Claude proposes during a full-document review: anchor a
 * comment to the first occurrence of the plaintext `find` in the document.
 */
export interface QuillComment {
  find: string;
  comment: string;
}

/** The parsed contents of a ```quill-comments fenced block in a review reply. */
export interface QuillCommentsBlock {
  comments: QuillComment[];
}

/**
 * Snapshot of unsaved work, written to `draft.json` in the app data dir while
 * the document is dirty and offered for recovery on the next launch. Deleted
 * when the document becomes clean (save / discard / new).
 */
export interface DraftFile {
  version: 1;
  savedAt: string;
  /** The file the draft belongs to, or null for an untitled document. */
  filePath: string | null;
  content: string;
  comments: Comment[];
  suggestions: Suggestion[];
  aiSession: AISessionBinding | null;
  contextFolder: string | null;
}
