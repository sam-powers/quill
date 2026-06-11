/**
 * Final segment of a file path, handling both POSIX (`/`) and Windows (`\`)
 * separators — splitting on `/` alone shows the full path as the filename on
 * Windows.
 */
export function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}

/**
 * Containing directory of a file path, handling both separators. Returns null
 * when the path has no directory component.
 */
export function dirname(path: string): string | null {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i < 0) return null;
  if (i === 0) return path[0];
  return path.slice(0, i);
}
