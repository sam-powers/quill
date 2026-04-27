import { useState, useCallback } from 'react';
import { supabase, supabaseConfigured } from '../lib/supabase';
import type { AuthUser, Comment, Suggestion } from '../types';

function cloudIdKey(localPath: string) {
  return `quill:cloudId:${localPath}`;
}

export function useCloudDocument(user: AuthUser | null) {
  const [cloudId, setCloudId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  function loadCloudId(localPath: string | null) {
    if (!localPath) { setCloudId(null); return; }
    const stored = localStorage.getItem(cloudIdKey(localPath));
    setCloudId(stored);
  }

  const uploadDocument = useCallback(async (
    localPath: string | null,
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
  ): Promise<string | null> => {
    if (!user || !supabaseConfigured) return null;
    setSyncing(true);
    try {
      const existing = localPath ? localStorage.getItem(cloudIdKey(localPath)) : null;
      const title = localPath
        ? (localPath.split('/').pop()?.replace(/\.md$/, '') ?? 'Untitled')
        : 'Untitled';

      if (existing) {
        const { error } = await supabase.from('documents').update({
          content,
          comments,
          suggestions,
          updated_at: new Date().toISOString(),
        }).eq('id', existing);
        if (error) throw error;
        return existing;
      } else {
        const { data, error } = await supabase.from('documents').insert({
          owner_id: user.id,
          title,
          content,
          comments,
          suggestions,
        }).select('id').single();
        if (error) throw error;
        const newId = data.id as string;
        if (localPath) localStorage.setItem(cloudIdKey(localPath), newId);
        setCloudId(newId);
        return newId;
      }
    } finally {
      setSyncing(false);
    }
  }, [user]);

  const downloadDocument = useCallback(async (id: string) => {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data as {
      id: string;
      title: string;
      content: string;
      comments: Comment[];
      suggestions: Suggestion[];
    };
  }, []);

  return { cloudId, syncing, loadCloudId, uploadDocument, downloadDocument };
}
