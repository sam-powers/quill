import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

interface ShareDialogProps {
  cloudId: string;
  onClose: () => void;
}

interface Share {
  id: string;
  shared_with_email: string;
  role: 'viewer' | 'editor';
}

export default function ShareDialog({ cloudId, onClose }: ShareDialogProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('editor');
  const [shares, setShares] = useState<Share[]>([]);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadShares();
  }, [cloudId]);

  async function loadShares() {
    const { data } = await supabase
      .from('document_shares')
      .select('id, shared_with_email, role')
      .eq('document_id', cloudId);
    setShares((data as Share[]) ?? []);
  }

  async function handleAdd() {
    const trimmed = email.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await supabase.from('document_shares').insert({
        document_id: cloudId,
        shared_with_email: trimmed,
        role,
      });
      setEmail('');
      await loadShares();
    } finally {
      setAdding(false);
    }
  }

  async function handleRevoke(shareId: string) {
    await supabase.from('document_shares').delete().eq('id', shareId);
    await loadShares();
  }

  function handleCopyLink() {
    const shareLink = `${window.location.origin}/doc/${cloudId}`;
    navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="share-header">
          <span className="share-title">Share document</span>
          <button className="share-close-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="share-link-row">
          <span className="share-link-label">Document link</span>
          <button className="btn-primary share-copy-btn" onClick={handleCopyLink}>
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>

        <div className="share-add-row">
          <input
            className="share-email-input"
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            autoFocus
          />
          <select
            className="share-role-select"
            value={role}
            onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            className="btn-primary"
            onClick={handleAdd}
            disabled={adding || !email.trim()}
          >
            Invite
          </button>
        </div>

        {shares.length > 0 && (
          <ul className="share-list">
            {shares.map((s) => (
              <li key={s.id} className="share-list-item">
                <span className="share-email">{s.shared_with_email}</span>
                <span className={`share-role-badge share-role-${s.role}`}>{s.role}</span>
                <button className="share-revoke-btn" onClick={() => handleRevoke(s.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
