/**
 * Coarse relative timestamp for card headers ("just now", "5min ago", …).
 * Accepts an epoch-ms number (tracked changes) or an ISO string (comments).
 */
export function timeAgo(when: number | string): string {
  const ts = typeof when === 'number' ? when : new Date(when).getTime();
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Truncates card preview text with an ellipsis. */
export function clip(text: string, max = 60): string {
  return text.slice(0, max) + (text.length > max ? '…' : '');
}
