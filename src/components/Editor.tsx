import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { TextSelection } from '@tiptap/pm/state';
import { Markdown } from 'tiptap-markdown';
import { CommentMark } from '../extensions/Comment';
import { TrackedInsert, TrackedDelete, TrackChanges } from '../extensions/TrackChanges';
import type { Editor as TiptapEditor } from '@tiptap/react';

export const toolbarSelectionStore = {
  value: null as { from: number; to: number; editor: TiptapEditor } | null,
  liveEditor: null as TiptapEditor | null,
};

export interface EditorRef {
  getMarkdown: () => string;
  setContent: (md: string) => void;
  getEditor: () => TiptapEditor | null;
}

interface EditorProps {
  initialContent?: string;
  isSuggesting: boolean;
  authorID: string;
  onUpdate: () => void;
  onSelectionChange: (info: SelectionInfo | null) => void;
  onEditorReady: (editor: TiptapEditor) => void;
}

export interface SelectionInfo {
  from: number;
  to: number;
  text: string;
  top: number;
  bottom: number;
}

const QuillEditor = forwardRef<EditorRef, EditorProps>(
  ({ initialContent = '', isSuggesting, authorID, onUpdate, onSelectionChange, onEditorReady }, ref) => {
    const onUpdateRef = useRef(onUpdate);
    const onSelectionRef = useRef(onSelectionChange);
    const onReadyRef = useRef(onEditorReady);
    onUpdateRef.current = onUpdate;
    onSelectionRef.current = onSelectionChange;
    onReadyRef.current = onEditorReady;

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // Don't auto-insert an empty paragraph after non-paragraph blocks
          // (e.g. headings). It interferes with toggling H1 back to paragraph.
          trailingNode: false,
        }),
        Underline,
        Link.configure({ openOnClick: false }),
        Markdown.configure({ html: false, tightLists: true }),
        CommentMark,
        TrackedInsert,
        TrackedDelete,
        TrackChanges,
      ],
      content: initialContent,
      editorProps: {
        // Chromium in headless mode (and some platforms) doesn't reliably map
        // Home/End to ProseMirror line navigation. Handle them explicitly so
        // pressing End collapses a selection to the line end.
        handleKeyDown(view, event) {
          if (event.key !== 'Home' && event.key !== 'End') return false;
          const { state } = view;
          const $head = state.selection.$head;
          const blockStart = $head.start($head.depth);
          const blockEnd = $head.end($head.depth);
          const target = event.key === 'Home' ? blockStart : blockEnd;
          // If shift held, extend selection — otherwise collapse to target.
          const anchor = event.shiftKey ? state.selection.anchor : target;
          const tr = state.tr.setSelection(TextSelection.create(state.doc, anchor, target));
          view.dispatch(tr.scrollIntoView());
          return true;
        },
      },
      onUpdate() {
        onUpdateRef.current();
      },
      onSelectionUpdate({ editor }) {
        const { from, to } = editor.state.selection;
        if (from === to) {
          onSelectionRef.current(null);
          return;
        }
        const text = editor.state.doc.textBetween(from, to);
        if (!text.trim()) {
          onSelectionRef.current(null);
          return;
        }
        try {
          const view = editor.view;
          const start = view.coordsAtPos(from);
          const end = view.coordsAtPos(to);
          onSelectionRef.current({ from, to, text, top: start.top, bottom: end.bottom });
        } catch {
          onSelectionRef.current(null);
        }
      },
      onCreate({ editor }) {
        toolbarSelectionStore.liveEditor = editor;
        document.addEventListener('mousedown', (e) => {
          const target = e.target as HTMLElement;
          if (target?.closest('[data-toolbar-button]')) {
            const { from, to } = editor.state.selection;
            if (from !== to && !toolbarSelectionStore.value) {
              toolbarSelectionStore.value = { from, to, editor };
            }
          }
        }, true);
        onReadyRef.current(editor);
      },
    });

    // Sync suggesting mode / author with extension storage
    useEffect(() => {
      if (!editor) return;
      editor.commands.setTrackChangesEnabled(isSuggesting);
      editor.commands.setTrackChangesAuthor(authorID);
    }, [editor, isSuggesting, authorID]);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown() {
          if (!editor) return '';
          return ((editor.storage as unknown as Record<string, { getMarkdown: () => string }>)['markdown']).getMarkdown();
        },
        setContent(md: string) {
          if (!editor) return;
          editor.commands.setContent(md);
        },
        getEditor() {
          return editor;
        },
      }),
      [editor],
    );

    return (
      <div className="editor-page">
        <EditorContent editor={editor} className="editor-content" />
      </div>
    );
  },
);

QuillEditor.displayName = 'QuillEditor';

export default QuillEditor;
