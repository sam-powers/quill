/**
 * Final segment of a file path, handling both POSIX (`/`) and Windows (`\`)
 * separators — splitting on `/` alone shows the full path as the filename on
 * Windows.
 */
export function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}
