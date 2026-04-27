import type { Editor } from '@tiptap/react';
import type { AuthUser } from '../types';

interface ToolbarProps {
  editor: Editor | null;
  isSuggesting: boolean;
  onToggleSuggesting: () => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  user: AuthUser | null;
  cloudId: string | null;
  syncing: boolean;
  onShare: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
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

function UserAvatar({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const initials = user.displayName
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="user-avatar-wrapper" title={`Signed in as ${user.email}\nClick to sign out`} onClick={onSignOut}>
      {user.avatarUrl ? (
        <img className="user-avatar-img" src={user.avatarUrl} alt={user.displayName} referrerPolicy="no-referrer" />
      ) : (
        <div className="user-avatar-initials">{initials}</div>
      )}
    </div>
  );
}

export default function Toolbar({
  editor,
  isSuggesting,
  onToggleSuggesting,
  onAcceptAll,
  onRejectAll,
  user,
  cloudId,
  syncing,
  onShare,
  onSignIn,
  onSignOut,
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

      <Divider />

      <ToolbarButton
        onClick={onShare}
        disabled={syncing}
        title={
          !user
            ? 'Sign in to share'
            : !cloudId
            ? 'Upload to cloud and share'
            : 'Share document'
        }
      >
        {syncing ? '↑ Syncing…' : cloudId ? '↑ Share' : '↑ Share'}
      </ToolbarButton>

      {user ? (
        <UserAvatar user={user} onSignOut={onSignOut} />
      ) : (
        <ToolbarButton onClick={onSignIn} title="Sign in with Google">
          Sign in
        </ToolbarButton>
      )}
    </div>
  );
}
