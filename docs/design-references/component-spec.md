# Component Spec

Text editor — MCM / Seattle aesthetic

---

## Philosophy

The aesthetic is mid-century modern filtered through a Pacific Northwest sensibility: muted, gray-green, not precious. The document page should feel like paper on a desk. The chrome around it — toolbar, comment panel, status bar — recedes. Nothing competes with the writing.

Two rules that override everything else:

1. The document page is always the brightest surface in the layout.
2. Sage is the only accent color. Use it only where it earns its place.

---

## Toolbar

**Layout:** Fixed top bar, full width, 42px tall. Items left-aligned. "Editing" badge right-aligned.

**Background:** `--color-chrome`
**Border:** 0.5px bottom, `--color-border`

**Buttons**

- Size: 28px × 28px minimum, 5px border radius
- Default state: transparent background, `--color-ink-mid` text/icon
- Hover state: `--color-sage-light` background, `--color-sage-dark` text
- Active/pressed: slight scale down (0.97)
- No selected/toggled state styling needed in v1

**Dividers:** 0.5px vertical lines at `--color-border`, 16px tall, `--space-xs` margin each side

**Editing badge**

- Right side of toolbar
- 6px circle dot in `--color-sage` + "Editing" label in `--color-ink-mid`, weight 300, 12px
- This is the only persistent sage element in the chrome

**Button set (in order):**
I, B, U, S | H1, H2, H3 | Bullet list, Ordered list | Quote, Code block

---

## Document Canvas

**Background:** `--color-bg` — the muted slate-green that surrounds the page

**Page surface**

- Background: `--color-page` (near-white, slightly cool)
- Border: 0.5px, `--color-border-light`
- Border radius: `--radius-sm` (3px — just enough to lift it, not enough to look like a card)
- Max width: `--page-max-width` (600px), centered
- Padding: `--page-padding-y` top/bottom, `--page-padding-x` left/right
- No shadow — contrast with background is sufficient

**Document title**

- Font: `--font-serif`, `--text-doc-title` (26px), weight 500
- Color: `--color-ink`
- Line height: `--leading-tight`
- Margin bottom: 4px

**Document metadata line**

- Font: `--font-sans`, `--text-meta` (11px), weight 300
- Color: `--color-ink-light`
- Letter spacing: 0.02em
- Margin bottom: 32px
- Format: "Last edited by [Name] · [time] ago"

**Section headings (H2)**

- Font: `--font-serif`, `--text-doc-h2` (16px), weight 500
- Color: `--color-ink`
- Margin top: 28px, margin bottom: 10px

**Body copy**

- Font: `--font-sans`, `--text-body` (13.5px), weight 300
- Color: `--color-ink-mid`
- Line height: `--leading-body` (1.85)
- Margin bottom: 14px

---

## Track Changes

Inline within body copy. Two states only: addition and deletion.

**Addition**

- Background: `--color-track-add-bg`
- Text color: `--color-track-add-text`
- Underline: 1px, `--color-track-add-line`, offset 2px

**Deletion**

- Background: `--color-track-del-bg`
- Text color: `--color-track-del-text`
- Strikethrough: `--color-track-del-line`

Accept/dismiss actions live in the comment thread that generated the change, not inline in the document.

---

## Text Highlight

Used to anchor a comment to a specific passage.

- Background: `--color-highlight-bg`
- Bottom border: 1.5px solid `--color-highlight-border`
- No border radius

---

## Comment Panel

**Layout:** Fixed right panel, `--comment-panel-width` (260px), full height below toolbar

**Background:** `--color-chrome`
**Border:** 0.5px left, `--color-border`

Cards stack top to bottom, newest at top. 10px horizontal margin, 12px top margin between cards.

---

## Comment Card

Two variants: default and active (focused/selected).

**Container**

- Background: `--color-page`
- Border: 0.5px, `--color-border` (default) or `--color-sage-mid` (active)
- Border radius: `--radius-lg` (8px)
- Overflow hidden

**Header**

- Padding: 10px 12px 8px
- Bottom border: 0.5px, `--color-border-light`
- Contains: avatar + commenter name + timestamp

**Avatar**

- Size: 20px × 20px, fully round
- Human: background `--color-human-avatar-bg`, text `--color-human-avatar-text`, initials 2 chars, 9px, weight 700
- AI: background `--color-ai-bg`, text `--color-ai-text` — same size and shape as human avatar (AI is a peer in the thread, not visually elevated)

**Commenter name**

- 11px, weight 700, `--color-ink`

**Timestamp**

- 10px, weight 300, `--color-ink-light`, right-aligned

**Comment body**

- Padding: 8px 12px
- Font: `--font-sans`, `--text-ui` (12px), weight 300
- Color: `--color-ink-mid`
- Line height: `--leading-ui`

---

## AI Reply Block

Appears below the human comment that triggered it, within the same card.

**Container**

- Background: `--color-ai-bg`
- Top border: 0.5px, `--color-border-light`
- Padding: 8px 12px 10px

**AI label**

- Text: "claude" (lowercase always)
- 10px, weight 700, `--color-ai-text`
- Letter spacing: 0.04em
- Margin bottom: 4px

**Response text**

- Same type treatment as comment body

**Action buttons** (when AI has made a track change suggestion)

- Accept: filled, `--color-sage` background, white text, 11px weight 700, 4px radius
- Dismiss: outlined, `--color-border` border, transparent bg, `--color-ink-mid` text, 11px weight 400
- Gap between buttons: 6px

---

## Comment Input Card

Always visible at bottom of comment panel for the active thread.

**Container**

- Background: `--color-page`
- Border: 0.5px, `--color-sage-mid` (always shown with sage border to indicate it's active)
- Border radius: `--radius-lg`

**Header row**

- Padding: 8px 12px
- Bottom border: 0.5px, `--color-border-light`
- Contains avatar + placeholder text ("Add a comment… (Cmd+Enter to post)")
- Placeholder: 11px, weight 300, `--color-ink-light`

**Textarea**

- No border, transparent background
- Font: `--font-sans`, 12px, weight 300, `--color-ink-mid`
- Padding: 10px 12px
- No resize handle
- Placeholder: "Type @ to tag claude..."

**Footer**

- Padding: 8px 12px
- Top border: 0.5px, `--color-border-light`
- Right-aligned button row: Cancel + Comment
- Same button styles as AI reply block actions

---

## Status Bar

**Layout:** Fixed bottom bar, full width, `--statusbar-height` (28px)

**Background:** `--color-chrome-dark`
**Border:** 0.5px top, `--color-border`

**Items:** left-aligned, 16px gap

- Doc name (weight 400, `--color-ink`)
- Word count, char count, cursor position (weight 300, `--color-ink-mid`)
- Font: `--font-sans`, `--text-meta` (11px)

---

## What Not To Do

- Do not use font-weight above 400 in body copy or UI text. 700 is reserved for avatar initials, commenter names, button labels, and the AI label only.
- Do not add border-radius values other than 3px, 5px, or 8px.
- Do not introduce a second accent color. If something needs emphasis, use weight or color lightness — not a new hue.
- Do not add shadows. Depth comes from color contrast between surfaces only.
- Do not uppercase labels. Sentence case everywhere, including the AI label ("claude" not "CLAUDE").
- Do not give AI a special icon, badge, or elevated visual treatment. It is a peer commenter.
