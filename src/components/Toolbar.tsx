import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';

interface ToolbarProps {
  editor: Editor | null;
  isSuggesting: boolean;
  onToggleSuggesting: () => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

interface ButtonProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  className?: string;
}

function ToolbarButton({ onClick, active, disabled, title, children, className }: ButtonProps) {
  return (
    <button
      data-toolbar-button
      className={`toolbar-btn${active ? ' active' : ''}${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}
      onMouseDown={(e) => {
        e.preventDefault(); // keep editor focus so selection is never lost
        if (!disabled) onClick();
      }}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="toolbar-divider" />;
}

// SVG Icons
const BoldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M6 4h8a4 4 0 0 1 0 8H6z"/>
    <path d="M6 12h9a4 4 0 0 1 0 8H6z"/>
  </svg>
);

const ItalicIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="19" y1="4" x2="10" y2="4"/>
    <line x1="14" y1="20" x2="5" y2="20"/>
    <line x1="15" y1="4" x2="9" y2="20"/>
  </svg>
);

const UnderlineIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 3v7a6 6 0 0 0 12 0V3"/>
    <line x1="4" y1="21" x2="20" y2="21"/>
  </svg>
);

const StrikeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="4" y1="12" x2="20" y2="12"/>
    <path d="M17.5 7C17.5 5.5 16.5 4 14 4H10C7.5 4 6 5.5 6 7.5C6 9 7 10 9 11"/>
    <path d="M6.5 17C6.5 18.5 7.5 20 11 20H13C15.5 20 18 18.5 18 16.5C18 15 17 14 15 13"/>
  </svg>
);

const BulletIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="9" y1="6" x2="20" y2="6"/>
    <line x1="9" y1="12" x2="20" y2="12"/>
    <line x1="9" y1="18" x2="20" y2="18"/>
    <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/>
    <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/>
    <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/>
  </svg>
);

const NumberedIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="10" y1="6" x2="21" y2="6"/>
    <line x1="10" y1="12" x2="21" y2="12"/>
    <line x1="10" y1="18" x2="21" y2="18"/>
    <path d="M4 6h1v4" strokeLinecap="round"/>
    <path d="M4 10h2" strokeLinecap="round"/>
    <path d="M4 14h2a1 1 0 0 1 0 2H4a1 1 0 0 1 0 2h2" strokeLinecap="round"/>
  </svg>
);

const BlockquoteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>
    <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>
  </svg>
);

const CodeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="16 18 22 12 16 6"/>
    <polyline points="8 6 2 12 8 18"/>
  </svg>
);

const UndoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 7v6h6"/>
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
  </svg>
);

const RedoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 7v6h-6"/>
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
  </svg>
);

export default function Toolbar({
  editor,
  isSuggesting,
  onToggleSuggesting,
  onAcceptAll,
  onRejectAll,
}: ToolbarProps) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const update = () => forceUpdate((n) => n + 1);
    editor.on('transaction', update);
    editor.on('selectionUpdate', update);
    return () => {
      editor.off('transaction', update);
      editor.off('selectionUpdate', update);
    };
  }, [editor]);

  const e = editor;

  if (!editor) return <div className="toolbar" />;

  return (
    <div className="toolbar">
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleItalic().run()}
        active={e?.isActive('italic') ?? false}
        title="Italic (Cmd+I)"
      >
        <ItalicIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleBold().run()}
        active={e?.isActive('bold') ?? false}
        title="Bold (Cmd+B)"
      >
        <BoldIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleUnderline().run()}
        active={e?.isActive('underline') ?? false}
        title="Underline (Cmd+U)"
      >
        <UnderlineIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleStrike().run()}
        active={e?.isActive('strike') ?? false}
        title="Strikethrough"
      >
        <StrikeIcon />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => e!.chain().focus().undo().run()}
        disabled={!e?.can().undo()}
        title="Undo (Cmd+Z)"
      >
        <UndoIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().redo().run()}
        disabled={!e?.can().redo()}
        title="Redo (Cmd+Shift+Z)"
      >
        <RedoIcon />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => e!.chain().focus().toggleHeading({ level: 1 }).run()}
        active={e?.isActive('heading', { level: 1 }) ?? false}
        title="Heading 1"
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleHeading({ level: 2 }).run()}
        active={e?.isActive('heading', { level: 2 }) ?? false}
        title="Heading 2"
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleHeading({ level: 3 }).run()}
        active={e?.isActive('heading', { level: 3 }) ?? false}
        title="Heading 3"
      >
        H3
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => e!.chain().focus().toggleBulletList().run()}
        active={e?.isActive('bulletList') ?? false}
        title="Bullet list"
      >
        <BulletIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleOrderedList().run()}
        active={e?.isActive('orderedList') ?? false}
        title="Numbered list"
      >
        <NumberedIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleBlockquote().run()}
        active={e?.isActive('blockquote') ?? false}
        title="Blockquote"
      >
        <BlockquoteIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => e!.chain().focus().toggleCode().run()}
        active={e?.isActive('code') ?? false}
        title="Inline code"
      >
        <CodeIcon />
      </ToolbarButton>

      <Divider />

      <div className="toolbar-spacer" />

      {isSuggesting && (
        <>
          <ToolbarButton onClick={onAcceptAll} title="Accept all suggestions" className="toolbar-btn-accept">
            ✓ Accept All
          </ToolbarButton>
          <ToolbarButton onClick={onRejectAll} title="Reject all suggestions" className="toolbar-btn-reject">
            ✗ Reject All
          </ToolbarButton>
          <Divider />
        </>
      )}

      <div
        className="editing-badge"
        onClick={onToggleSuggesting}
        title={isSuggesting ? 'Exit suggesting mode' : 'Enable suggesting mode'}
        style={{ cursor: 'pointer' }}
      >
        <div className="editing-dot" />
        {isSuggesting ? 'Suggesting' : 'Editing'}
      </div>
    </div>
  );
}
