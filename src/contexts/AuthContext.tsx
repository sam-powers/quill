import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabase';
import type { AuthUser } from '../types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: false,
  signInWithGoogle: async () => {},
  signOut: async () => {},
});

function sessionToUser(session: Session): AuthUser | null {
  const u = session.user;
  if (!u) return null;
  return {
    id: u.id,
    email: u.email ?? '',
    displayName: (u.user_metadata?.full_name as string | undefined) ?? u.email ?? 'User',
    avatarUrl: (u.user_metadata?.avatar_url as string | undefined) ?? '',
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(supabaseConfigured);

  useEffect(() => {
    if (!supabaseConfigured) return;

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session ? sessionToUser(session) : null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session ? sessionToUser(session) : null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Listen for deep link callbacks in Tauri desktop context
  useEffect(() => {
    if (!supabaseConfigured) return;
    let unlisten: (() => void) | undefined;

    async function setupDeepLink() {
      try {
        const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
        unlisten = await onOpenUrl(async (urls) => {
          const url = urls[0];
          if (!url) return;
          const parsed = new URL(url);
          const code = parsed.searchParams.get('code');
          if (code) {
            await supabase.auth.exchangeCodeForSession(code);
          }
        });
      } catch {
        // Not in Tauri context or plugin unavailable
      }
    }

    setupDeepLink();
    return () => unlisten?.();
  }, []);

  async function signInWithGoogle() {
    if (!supabaseConfigured) {
      alert('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env.local file.');
      return;
    }

    let isTauriApp = false;
    try {
      const { isTauri } = await import('@tauri-apps/api/core');
      isTauriApp = isTauri();
    } catch {
      // Running in browser
    }

    if (isTauriApp) {
      // Desktop: get OAuth URL, open in system browser, catch callback via deep link
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          skipBrowserRedirect: true,
          redirectTo: 'quill://auth/callback',
        },
      });
      if (error) throw error;
      if (data.url) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(data.url);
      }
    } else {
      // Web: standard redirect flow
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}` },
      });
    }
  }

  async function signOut() {
    if (!supabaseConfigured) return;
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
