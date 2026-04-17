import { useState, useCallback } from 'react';
import type { Suggestion } from '../types';

interface UseSuggestionsReturn {
  suggestions: Suggestion[];
  setSuggestions: React.Dispatch<React.SetStateAction<Suggestion[]>>;
  acceptSuggestion: (id: string) => void;
  rejectSuggestion: (id: string) => void;
  acceptAllSuggestions: () => void;
  rejectAllSuggestions: () => void;
}

export function useSuggestions(): UseSuggestionsReturn {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const acceptSuggestion = useCallback((id: string) => {
    setSuggestions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: 'accepted' as const } : s)),
    );
  }, []);

  const rejectSuggestion = useCallback((id: string) => {
    setSuggestions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: 'rejected' as const } : s)),
    );
  }, []);

  const acceptAllSuggestions = useCallback(() => {
    setSuggestions((prev) =>
      prev.map((s) => (s.status === 'pending' ? { ...s, status: 'accepted' as const } : s)),
    );
  }, []);

  const rejectAllSuggestions = useCallback(() => {
    setSuggestions((prev) =>
      prev.map((s) => (s.status === 'pending' ? { ...s, status: 'rejected' as const } : s)),
    );
  }, []);

  return {
    suggestions,
    setSuggestions,
    acceptSuggestion,
    rejectSuggestion,
    acceptAllSuggestions,
    rejectAllSuggestions,
  };
}
