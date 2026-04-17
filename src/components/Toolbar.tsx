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
}

function ToolbarButton({ onClick, active, disabled, title, children }: ButtonProps) {
  return (
    <button
      className={`toolbar-btn${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
      onClick={onClick}
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

export default function Toolbar({
  editor,
  isSuggesting,
  onToggleSuggesting,
  onAcceptAll,
  onRejectAll,
}: ToolbarProps) {
  if (!editor) return <div className="toolbar" />;

  return (
    <div className="toolbar">
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title="Bold (Cmd+B)"
      >
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title="Italic (Cmd+I)"
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive('underline')}
        title="Underline (Cmd+U)"
      >
        <span style={{ textDecoration: 'underline' }}>U</span>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title="Strikethrough"
      >
        <span style={{ textDecoration: 'line-through' }}>S</span>
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive('heading', { level: 1 })}
        title="Heading 1"
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive('heading', { level: 2 })}
        title="Heading 2"
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive('heading', { level: 3 })}
        title="Heading 3"
      >
        H3
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
        title="Bullet list"
      >
        •—
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
        title="Numbered list"
      >
        1.
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive('blockquote')}
        title="Blockquote"
      >
        ❝
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive('code')}
        title="Inline code"
      >
        {'</>'}
      </ToolbarButton>

      <Divider />

      <div className="toolbar-spacer" />

      {isSuggesting && (
        <>
          <ToolbarButton onClick={onAcceptAll} title="Accept all suggestions">
            ✓ Accept All
          </ToolbarButton>
          <ToolbarButton onClick={onRejectAll} title="Reject all suggestions">
            ✗ Reject All
          </ToolbarButton>
          <Divider />
        </>
      )}

      <ToolbarButton
        onClick={onToggleSuggesting}
        active={isSuggesting}
        title={isSuggesting ? 'Exit suggesting mode' : 'Enable suggesting mode'}
      >
        ✏ {isSuggesting ? 'Suggesting' : 'Editing'}
      </ToolbarButton>
    </div>
  );
}
