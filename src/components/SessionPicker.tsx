import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AISessionBinding } from '../types';

interface SessionSummary {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  title: string | null;
  lastUsed: number; // unix seconds
}

interface SessionPreview {
  sessionId: string;
  cwd: string;
  recentAssistantMessages: string[];
}

interface SessionPickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (binding: AISessionBinding) => void;
}

function formatRelativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function SessionPicker({ open, onClose, onPick }: SessionPickerProps) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSessions(null);
    setLoadError(null);
    setSelectedPath(null);
    setPreview(null);
    invoke<SessionSummary[]>('list_claude_sessions')
      .then((rows) => setSessions(rows))
      .catch((e) => setLoadError(String(e)));
  }, [open]);

  useEffect(() => {
    if (!selectedPath) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setPreview(null);
    invoke<SessionPreview>('read_claude_session_preview', { jsonlPath: selectedPath })
      .then((p) => setPreview(p))
      .catch((e) => setPreview({ sessionId: '', cwd: '', recentAssistantMessages: [String(e)] }))
      .finally(() => setPreviewLoading(false));
  }, [selectedPath]);

  if (!open) return null;

  const selectedSummary = sessions?.find((s) => s.jsonlPath === selectedPath) ?? null;

  function handleLink() {
    if (!preview || !selectedSummary) return;
    onPick({
      provider: 'claude-code',
      sessionId: preview.sessionId || selectedSummary.sessionId,
      cwd: preview.cwd || selectedSummary.cwd,
      linkedAt: new Date().toISOString(),
    });
  }

  return (
    <div className="session-picker-overlay" onClick={onClose}>
      <div className="session-picker" onClick={(e) => e.stopPropagation()}>
        <div className="session-picker-header">
          <span>Link Claude Code session</span>
          <button className="session-picker-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="session-picker-body">
          <div className="session-picker-list">
            {loadError && <div className="session-picker-error">{loadError}</div>}
            {!sessions && !loadError && <div className="session-picker-loading">Loading…</div>}
            {sessions?.length === 0 && (
              <div className="session-picker-empty">
                No Claude Code sessions found under <code>~/.claude/projects/</code>.
              </div>
            )}
            {sessions?.map((s) => (
              <button
                key={s.jsonlPath}
                className={`session-row${s.jsonlPath === selectedPath ? ' selected' : ''}`}
                onClick={() => setSelectedPath(s.jsonlPath)}
              >
                <div className="session-row-title">
                  {s.title ?? s.sessionId.slice(0, 8)}
                </div>
                <div className="session-row-meta">
                  <span className="session-row-cwd">{s.cwd}</span>
                  <span className="session-row-time">{formatRelativeTime(s.lastUsed)}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="session-picker-preview">
            {!selectedPath && <div className="session-picker-hint">Pick a session to preview.</div>}
            {previewLoading && <div className="session-picker-loading">Loading preview…</div>}
            {preview && !previewLoading && (
              <>
                <div className="session-picker-preview-meta">
                  <div><strong>Session:</strong> <code>{preview.sessionId}</code></div>
                  <div><strong>cwd:</strong> <code>{preview.cwd}</code></div>
                </div>
                <div className="session-picker-preview-messages">
                  {preview.recentAssistantMessages.length === 0 && (
                    <div className="session-picker-hint">No assistant messages in this session.</div>
                  )}
                  {preview.recentAssistantMessages.map((m, i) => (
                    <div key={i} className="session-preview-msg">{m}</div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="session-picker-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleLink}
            disabled={!preview || previewLoading}
          >
            Link this session
          </button>
        </div>
      </div>
    </div>
  );
}
