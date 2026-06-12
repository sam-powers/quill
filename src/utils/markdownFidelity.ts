/**
 * Detect Markdown constructs the editor cannot represent and would therefore
 * mangle on save (footnotes get bracket-escaped, raw HTML gets entity-escaped).
 * Used to warn the user once when such a file is opened, before they edit it.
 */

/** Replace fenced code blocks and inline code spans with blanks so their
 * contents can't trigger false positives. */
function stripCode(md: string): string {
  return (
    md
      // Fenced blocks: ``` or ~~~ through the matching closer (or EOF).
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, '')
      // Inline code: backtick runs of any length with matching closer.
      .replace(/(`+)[^`]*?\1/g, '')
  );
}

export function detectLossyConstructs(md: string): string[] {
  const text = stripCode(md);
  const found: string[] = [];

  // Footnote definitions ("[^1]: …") or references ("…[^1]").
  if (/\[\^[^\]\s]+\]/.test(text)) {
    found.push('footnotes');
  }

  // Raw HTML: an opening/closing tag or an HTML comment. The tag-name
  // requirement keeps autolinks (<https://…>) and emails (<a@b.com>) from
  // matching: those continue with ":" or "@", never whitespace, "/", or ">".
  if (/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/.test(text) || text.includes('<!--')) {
    found.push('HTML tags');
  }

  return found;
}
