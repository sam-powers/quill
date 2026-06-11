export interface Reply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  authorKind?: 'user' | 'ai';
  pending?: boolean;
  error?: string;
}

export interface AISessionBinding {
  provider: 'claude-code';
  sessionId: string;
  cwd: string;
  linkedAt: string;
  /**
   * True when Quill minted this binding itself ("Start new session" in the
   * picker) instead of linking an existing authoring session. The session is
   * created on first @claude contact, and prompts never claim Claude authored
   * the document.
   */
  createdByQuill?: boolean;
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

export type SuggestionType = 'insertion' | 'deletion' | 'replacement';
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
