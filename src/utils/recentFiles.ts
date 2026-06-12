/**
 * The File → Open Recent list. The frontend owns it (persisted in
 * localStorage); the native menu only mirrors it — `syncRecentMenu` pushes the
 * current list to the backend, which rebuilds the menu. Outside Tauri the sync
 * is a silent no-op and the list still tracks normally.
 */

const STORAGE_KEY = 'quill-recent-files';
export const MAX_RECENT_FILES = 10;

export function getRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_FILES);
  } catch {
    return [];
  }
}

/** Record `path` as most recent (deduplicated, capped) and return the new list. */
export function addRecentFile(path: string): string[] {
  const list = [path, ...getRecentFiles().filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable — the menu still updates for this session.
  }
  return list;
}

export function clearRecentFiles(): string[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
  return [];
}

/** Push the list to the native menu. No-op outside Tauri. */
export async function syncRecentMenu(paths: string[]): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('update_recent_menu', { paths });
  } catch {
    // Non-Tauri context (dev server / e2e), or no native menu.
  }
}
