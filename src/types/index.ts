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
}
