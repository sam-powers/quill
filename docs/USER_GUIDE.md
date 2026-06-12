# Quill User Guide

Quill is **the document editor that can hold a conversation**. It reviews and revises documents the way Google Docs' suggesting mode does — but for plain Markdown files on your own computer, with Claude answering your comments and proposing tracked changes right in the margin. This guide assumes no programming knowledge.

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

### Staying up to date

Each time Quill starts it checks whether a newer version has been released. If there is one, a slim banner appears at the top of the window: **View release** opens the download page in your browser, and **×** dismisses the notice for that version. Quill never updates itself or downloads anything in the background — installing a new version is always your choice. To update, download the new `.dmg` and replace the app in Applications; your documents are untouched.

## The basics

- **Open** a Markdown (`.md`) file with **File → Open…** (or Cmd/Ctrl+O), **save** with Cmd/Ctrl+S. **File → Open Recent** lists your last ten documents.
- Quill remembers your window size and position between launches, and misspellings get the usual red squiggle from your system spellchecker.
- The toolbar has the usual formatting: bold, italic, headings, lists, quotes.
- **Find & replace** with Cmd/Ctrl+F: type to highlight matches, Enter / Shift+Enter to step through them, **Replace** / **All** to swap them out, Esc to close. In Suggesting mode a replacement shows up as a tracked change like any other edit.
- **Links** with Cmd/Ctrl+K (or the chain-link toolbar button): select text and enter a URL — bare domains like `example.com` get `https://` added for you. Click inside an existing link and press Cmd/Ctrl+K again to change or remove it.
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

**One-time setup.** If you don't have Claude Code yet, open the **Terminal** app (find it with Spotlight: press Cmd+Space and type "Terminal") and paste:

```
curl -fsSL https://claude.ai/install.sh | bash
```

Then type `claude` and press Return — the first run walks you through signing in with your Claude account in the browser. That's it; Quill finds it automatically from then on.

If a document was written with Claude Code's help, you can put that same AI session to work reviewing it:

1. In the bottom bar, click **🔗 Link to Claude session…** and pick the session that the document came from (Quill usually suggests the right one automatically).
2. Add a comment anywhere and mention **@claude** in it — for example, _"@claude is this paragraph accurate?"_.
3. Claude's answer streams into the comment thread, with the full memory of having written the document.

**The document doesn't have to come from Claude.** If someone sends you a Markdown file — or you wrote one yourself — you can still have a conversation in it: save the document, click **🔗 Link to Claude session…**, and choose **Start new session**. Quill starts a fresh Claude session just for that document the first time you mention **@claude**, and every comment after that continues the same conversation. (The button is grayed out until the document is saved — the session lives in the document's folder.)

You can also ask Claude to **make edits**: _"@claude tighten this section."_ Its revisions appear as ordinary tracked changes attributed to Claude — you review them with the same Accept / Reject cards as anyone else's suggestions. Nothing changes in your document without your approval.

Phrasing controls how much Claude may touch: by default it edits only the highlighted text; say "this paragraph" or "the whole document" to widen the scope.

### Review the whole document

When a draft is nearly done, click **✨ Review full document** at the top of the comment column for a single polishing pass instead of commenting section by section. A dialog opens with a ready-made review prompt — edit it for a focused pass (_"make it 20% shorter"_, _"check the tone for a customer audience"_) or just hit **Submit**. Two checkboxes control what comes back: **Make comments** (margin notes from Claude on specific passages) and **Make suggestions** (tracked changes you Accept or Reject, like any other edit).

Claude reads the whole document, streams its assessment into the dialog, and when it finishes you'll see a summary like _"2 comments added · 3 suggestions proposed"_ — the comments and suggestions are waiting in the margin behind the dialog. Nothing is applied without your review, and you can cancel mid-stream at any time.

## Reference folders

If your document draws on source material — interview notes, research PDFs, data files — put them in a folder and click **📁 Link reference folder…** in the bottom bar. From then on, every `@claude` request lets Claude read that folder, and it's told which files are in it, so you can ask things like _"@claude check this summary against the interview notes."_

The link is remembered with the document; click the folder name to change it or **×** to unlink.

## Starting from Claude Code

If you write documents _with_ Claude Code, there's a plugin that closes the loop: it adds a command that sends the document you're working on straight into Quill, already linked to the session that wrote it. Install it once (in a terminal, or the same two commands with `/plugin …` inside Claude Code):

```
claude plugin marketplace add sam-powers/quill
claude plugin install quill-integration@quill-official
```

Then, in any Claude Code session:

```
/quill-integration:open-in-quill draft.md
```

Quill opens the file with comments, suggestions, and the session link restored — ready for `@claude` questions and revisions. (Launch Quill at least once before the first use, so macOS learns the `quill://` link type.)

## Tips

- **Zoom** the document with the slider in the bottom bar (double-click the percentage to reset).
- **Themes:** the color-swatch dropdown at the right end of the toolbar offers four color themes; your choice is remembered.
- A failed save or open is always reported in a dialog — if you see the unsaved dot (`•`), your latest changes are not on disk yet.

## Something not working?

- **"@claude" replies fail immediately** — make sure the Claude Code CLI is installed (`claude` in a terminal) and you're signed in. Quill searches the usual install locations even when launched from the Dock.
- **A document opens with a warning about its comments file** — the companion `.comments.json` couldn't be read. Quill opens the text safely and refuses to overwrite the damaged file, so the comments may be recoverable from a backup.
- For anything else, [open an issue](https://github.com/sam-powers/quill/issues) describing what happened.
