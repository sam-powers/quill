# Concepts

A glossary of project-specific terms. Each entry is a self-contained, one-sentence
definition — enough for a new engineer to ground in the vocabulary without reading
the code. Grows as learnings surface new domain nouns.

## Editor & styling

- **Continuous-scroll editor** — Quill's editor is a single, uninterrupted
  scrolling text surface rather than a paginated one, so text reflows freely and
  there are no fixed page boundaries in the layout.

- **Reflowing text surface** — an editable region whose line breaks and vertical
  positions change whenever font size, zoom, window width, or content changes, so
  nothing positioned by fixed pixel offset can be assumed to stay clear of the text.

- **ProseMirror surface** — the underlying rich-text editing area (`.ProseMirror`)
  that Tiptap renders the document into and that carries the editor's text styling.

- **Suggesting mode** — an editing mode where changes are recorded as tracked
  insertions and deletions (like Google Docs suggesting) instead of being applied
  directly to the document.

- **Sidecar** — the companion file saved alongside a document that holds its
  comments, suggestions, and linked-session metadata, keeping the Markdown file
  itself plain.
