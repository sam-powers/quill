/**
 * True when `candidate` is a strictly newer dotted version than `current`.
 * Accepts an optional leading "v" (GitHub tags are "v0.3.0"); missing
 * segments count as 0, so "1.2" === "1.2.0". Returns false for anything
 * unparseable — an update check should never fire on garbage input.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function parseVersion(v: string): number[] | null {
  const parts = v.trim().replace(/^v/, '').split('.');
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums;
}
