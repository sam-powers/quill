export interface Reply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
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
  version: 1;
  comments: Comment[];
  suggestions: Suggestion[];
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
  authorID: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}
