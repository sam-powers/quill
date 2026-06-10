# Quill User Guide

Quill is a desktop editor for **reviewing and revising documents**, the way Google Docs' suggesting mode works — but for plain Markdown files on your own computer, with an AI reviewer built in. This guide assumes no programming knowledge.

## Installing Quill

Quill is currently available for the Mac. Download the installer from the [latest release](https://github.com/sam-powers/quill/releases/latest):

- **Mac with Apple Silicon** (M1 or newer, 2020+): the `.dmg` ending in `aarch64.dmg`
- **Mac with an Intel chip**: the `.dmg` ending in `x64.dmg` (not sure which Mac you have? → Apple menu → About This Mac)

### First launch on a Mac

Quill isn't yet registered with Apple, so the very first time you open it macOS will say it "cannot be opened because the developer cannot be verified."

1. Find **Quill** in your **Applications** folder.
2. **Right-click** (or hold Control and click) the app and choose **Open**.
3. In the warning dialog, click **Open** again.

You only have to do this once — afterwards Quill opens normally.

## The basics

- **Open** a Markdown (`.md`) file with **File → Open…** (or Cmd/Ctrl+O), **save** with Cmd/Ctrl+S.
- The toolbar has the usual formatting: bold, italic, headings, lists, quotes.
- The bar at the bottom shows the file name, word count, and a dot (`•`) when you have unsaved changes. Quill always asks before letting unsaved work be lost.
- Your document stays a normal Markdown file that any other app can read. Quill keeps its review data (comments and suggestions) in a small companion file next to it, named `<your file>.comments.json` — keep the two together if you move or share the document.

## Suggesting mode (tracked changes)

Click **Suggesting** in the toolbar to switch modes. Now your edits don't change the text directly — insertions and deletions appear marked up in the text, each with a card in the right margin where you (or a co-reviewer) can **Accept** or **Reject** it. **Accept All** / **Reject All** clear the whole batch. Switch back to **Editing** mode to edit normally.

## Comments

1. Select some text — a **+** button appears in the margin.
2. Click it and type your comment. It anchors to that text and shows as a card in the right margin.
3. Click a card to jump to its place in the document; reply to it, **resolve** it, or delete it.

## Asking Claude (`@claude`)

This is Quill's signature feature, and the one piece that needs a companion tool: the [Claude Code](https://claude.com/claude-code) command-line app must be installed and signed in on the same computer.

If a document was written with Claude Code's help, you can put that same AI session to work reviewing it:

1. In the bottom bar, click **🔗 Link to Claude session…** and pick the session that the document came from (Quill usually suggests the right one automatically).
2. Add a comment anywhere and mention **@claude** in it — for example, _"@claude is this paragraph accurate?"_.
3. Claude's answer streams into the comment thread, with the full memory of having written the document.

You can also ask Claude to **make edits**: _"@claude tighten this section."_ Its revisions appear as ordinary tracked changes attributed to Claude — you review them with the same Accept / Reject cards as anyone else's suggestions. Nothing changes in your document without your approval.

Phrasing controls how much Claude may touch: by default it edits only the highlighted text; say "this paragraph" or "the whole document" to widen the scope.

## Reference folders

If your document draws on source material — interview notes, research PDFs, data files — put them in a folder and click **📁 Link reference folder…** in the bottom bar. From then on, every `@claude` request lets Claude read that folder, and it's told which files are in it, so you can ask things like _"@claude check this summary against the interview notes."_

The link is remembered with the document; click the folder name to change it or **×** to unlink.

## Tips

- **Zoom** the document with the slider in the bottom bar (double-click the percentage to reset).
- **Themes:** the color-swatch dropdown at the right end of the toolbar offers four color themes; your choice is remembered.
- A failed save or open is always reported in a dialog — if you see the unsaved dot (`•`), your latest changes are not on disk yet.

## Something not working?

- **"@claude" replies fail immediately** — make sure the Claude Code CLI is installed (`claude` in a terminal) and you're signed in. Quill searches the usual install locations even when launched from the Dock.
- **A document opens with a warning about its comments file** — the companion `.comments.json` couldn't be read. Quill opens the text safely and refuses to overwrite the damaged file, so the comments may be recoverable from a backup.
- For anything else, [open an issue](https://github.com/sam-powers/quill/issues) describing what happened.
