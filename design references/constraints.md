# Design Constraints

Text editor — for Claude Code implementation

These are the rules most likely to be violated without explicit instruction. Treat them as hard constraints, not suggestions.

---

## Typography

- Body copy and UI text: `font-weight: 300` only. Never 400, 500, or 600 in running text.
- Weight 700 is allowed only in: avatar initials, commenter names, AI label ("claude"), button labels.
- Headings use Playfair Display (serif). Everything else uses Lato (sans-serif). No exceptions.
- Font sizes: use only values defined in tokens. Do not introduce intermediate sizes.
- "claude" (the AI label in comment threads) is always lowercase.

## Color

- Sage (`#5C7A62`) is the only accent color in the entire app. It appears on: the editing dot, the Accept button, active comment card borders, the comment input card border.
- Do not introduce blue, orange, purple, or any other hue — not even for links or focus rings. Focus rings use sage.
- The document page (`--color-page`) must always be the lightest surface. Chrome (`--color-chrome`) sits below it. Background (`--color-bg`) is darkest.
- AI reply background (`--color-ai-bg`) is a cool blue-gray, intentionally slightly different in temperature from the page white. Do not "fix" this to match.

## Border Radius

Three values only: 3px (page surface), 5px (toolbar buttons), 8px (cards). Avatars are fully round (50%). Nothing else.

## Shadows

None. Zero. Do not add box-shadow for elevation. Depth is communicated through surface color contrast only.

## Borders

Always 0.5px. Never 1px except for the track change highlight bottom border (1.5px) and the active comment card indicator (0.5px sage-mid). No other exceptions.

## AI treatment

The AI is a peer commenter. It gets the same avatar size and shape as a human commenter. It does not get a special icon, sparkle, robot emoji, gradient, or any visual elevation. The only distinguishing marks are: the cooler avatar background color, the "claude" label in `--color-ai-text`, and the `--color-ai-bg` reply block background.

## Track changes

Two states only: addition (green underline) and deletion (red strikethrough). Do not add a third state (e.g. "moved" or "reformatted"). Accept/dismiss controls live in the comment thread, never floating inline in the document.

## Spacing

Use token values. Do not introduce custom spacing values. If a component needs breathing room, use the nearest token step up.

## Fonts loading

Playfair Display and Lato are loaded from Google Fonts. Always include both weights for Lato (300, 700) and both styles for Playfair Display (regular, italic). If Google Fonts is unavailable, fallback stack is: Playfair Display → Georgia → serif; Lato → system-ui → sans-serif.
