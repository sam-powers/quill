---
description: Open a Markdown file in the Quill editor via the quill:// deep link
argument-hint: <path to .md file (relative or absolute)>
allowed-tools: ['Bash']
---

Open the file `$ARGUMENTS` in the Quill desktop editor.

Steps:

1. If `$ARGUMENTS` is empty, ask the user which `.md` file to open and stop.
2. Resolve `$ARGUMENTS` to an **absolute path**. If it is already absolute (starts with `/`), use it as-is; otherwise resolve it against the current working directory. Verify the file exists with `test -f`; if it does not, report the path you tried and stop.
3. URL-encode the absolute path (at minimum encode spaces as `%20`) and open it:

   ```bash
   open "quill://open?file=<absolute-encoded-path>"
   ```

   On macOS this hands the path to Quill, which opens the document and restores its comments, suggestions, and any linked Claude session from the `<name>.comments.json` sidecar.

4. Report the absolute path you opened. If `open` fails (e.g. the `quill://` scheme isn't registered because Quill has never been launched), tell the user to launch Quill once — `open /path/to/quill.app` — so macOS registers the URL scheme, then retry.

Notes:

- This requires the Quill desktop app to be installed and to have registered the `quill://` scheme (it does so on first launch).
- The deep link only works for Markdown files Quill can read; a sidecar is optional.
