import { useCallback, useEffect, useState } from 'react';
import { isNewerVersion } from '../utils/version';

const LATEST_RELEASE_API = 'https://api.github.com/repos/sam-powers/quill/releases/latest';
const RELEASES_PAGE = 'https://github.com/sam-powers/quill/releases/latest';
const DISMISSED_KEY = 'quill.dismissed-update';

/**
 * The "View release" button opens this URL in the user's browser, so it must
 * not be trusted just because it came back in the API response. Accept it only
 * if it's an `https://github.com/` URL; otherwise fall back to the hardcoded
 * releases page. (A compromised or spoofed response can't redirect the user to
 * an arbitrary scheme or host.)
 */
function safeReleaseUrl(htmlUrl: string | undefined): string {
  if (!htmlUrl) return RELEASES_PAGE;
  try {
    const parsed = new URL(htmlUrl);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      return htmlUrl;
    }
  } catch {
    // Not a parseable URL.
  }
  return RELEASES_PAGE;
}

export interface UpdateInfo {
  /** Version of the newer release, without the leading "v" (e.g. "0.4.0"). */
  version: string;
  /** Release page to open in the user's browser. */
  url: string;
}

interface UpdateCheckOptions {
  currentVersion: string;
  /**
   * Defaults to production builds only: the dev server and the e2e suite
   * shouldn't hit the GitHub API or pop a banner mid-test.
   */
  enabled?: boolean;
}

/**
 * Checks GitHub once on launch for a release newer than the running app and
 * exposes it for the UpdateBanner. Deliberately quiet: any network or parse
 * failure means "no update" (we'll try again next launch), and a dismissed
 * version stays dismissed across launches via localStorage. Draft releases
 * never appear at /releases/latest, so publishing remains the moment users
 * start seeing a new version.
 */
export function useUpdateCheck({
  currentVersion,
  enabled = import.meta.env.PROD,
}: UpdateCheckOptions) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    (async () => {
      try {
        const res = await fetch(LATEST_RELEASE_API, {
          signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) return;
        const release: { tag_name?: string; html_url?: string } = await res.json();
        if (!release.tag_name || !isNewerVersion(release.tag_name, currentVersion)) return;
        const version = release.tag_name.replace(/^v/, '');
        if (localStorage.getItem(DISMISSED_KEY) === version) return;
        setUpdate({ version, url: safeReleaseUrl(release.html_url) });
      } catch {
        // Offline, rate-limited, or unmounted mid-flight — stay quiet.
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [currentVersion, enabled]);

  const dismiss = useCallback(() => {
    if (update) localStorage.setItem(DISMISSED_KEY, update.version);
    setUpdate(null);
  }, [update]);

  return { update, dismiss };
}
