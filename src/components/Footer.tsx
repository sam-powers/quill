import type { Editor } from '@tiptap/react';

interface FooterProps {
  editor: Editor | null;
  filePath: string | null;
  isSuggesting: boolean;
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

export default function Footer({ editor, filePath, isSuggesting }: FooterProps) {
  if (!editor) return <div className="footer" />;

  const text = editor.state.doc.textContent;
  const words = countWords(text);
  const chars = text.length;

  const { from } = editor.state.selection;
  const resolved = editor.state.doc.resolve(from);
  const line = Math.max(1, resolved.depth);
  const col = resolved.parentOffset + 1;

  const fileName = filePath ? filePath.split('/').pop() : 'Untitled';

  return (
    <div className="footer">
      <span className="footer-filename">{fileName}</span>
      <span className="footer-sep">·</span>
      <span>{words.toLocaleString()} words</span>
      <span className="footer-sep">·</span>
      <span>{chars.toLocaleString()} chars</span>
      <span className="footer-sep">·</span>
      <span>
        Line {line}, Col {col}
      </span>
      {isSuggesting && (
        <>
          <span className="footer-sep">·</span>
          <span className="footer-suggesting-badge">Suggesting</span>
        </>
      )}
    </div>
  );
}
