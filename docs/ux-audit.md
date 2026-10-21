# Drawit UI/UX audit

Audit date: 2026-10-19. Build: `259b664` plus the fixes listed below.

## Scope and method

The audit covers Drawit's own interface around the Excalidraw canvas: the
header, the assistance card, the suggestion review flow, status messages,
exports and dialogs. Excalidraw's built-in tools are in scope only where
Drawit's layout affects them.

- **Heuristics:** Nielsen's ten usability heuristics, Fitts's law, Gestalt
  proximity, and progressive disclosure.
- **Accessibility:** WCAG 2.2 AA, checked with axe-core 4.14 plus manual
  keyboard and focus-order passes.
- **Evidence:** scripted Playwright runs in headless Edge at 1366×768,
  1920×1080, 820×1180 (touch) and 390×844 (touch). Each run drew a stroke,
  previewed and applied a suggestion, previewed a two-box flowchart, rejected
  one item, applied the diagram, and opened the Mermaid export.

### Severity

| Severity | Meaning |
| --- | --- |
| Critical | Breaks or misleads the core loop: draw, suggest, review, apply. |
| High | Slows or confuses the core loop for many people, or fails WCAG 2.2 AA. |
| Medium | Noticeable friction or inconsistency. |
| Low | Polish. |

## Catalog

| ID | Severity | Issue and evidence | Principle | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| UX-01 | Critical | **Apply and Dismiss sit far from the preview and look secondary.** They live in a card above the canvas, about 330 px from a diagram preview at 1366×768. Apply uses the default button style, Dismiss looks like plain text, and five disabled buttons surround them. | Fitts's law; proximity; visual hierarchy | A contextual review bar appears next to the preview. It has a primary **Apply** and a **Dismiss**, says what will change, and follows the preview when you pan or zoom. | Fixed |
| UX-02 | Critical | **You can't see what you're applying.** The suggestion is a 2 px dashed blue line drawn over the full-strength original. On a normal stroke it all but disappears. Rejected items drop to 25% opacity and look like no suggestion at all. | Visibility of system status; WCAG 1.4.11 | While you review, the original strokes under included items fade, so the suggestion stands out. Excluded items show the original at full strength. Your strokes are never changed until you apply. | Fixed |
| UX-03 | High | **Seven equal-weight buttons in one row.** The row mixes creating (Suggest, Diagram, Interpret), reviewing (Apply, Dismiss) and output (two exports). On an empty canvas all seven are disabled, so the bar looks broken. | Aesthetic and minimalist design; progressive disclosure | A slim app bar holds one assist group (**Suggest**, **Diagram**, and **Interpret** in development) plus an **Export** menu. Review actions appear only while you review. Suggest and Diagram stay available and explain what's missing. | Fixed |
| UX-04 | High | **Disabled controls never say why.** Disabled Fluent buttons leave the tab order and ignore hover, so tooltips such as "Apply or dismiss the pending preview before exporting." never show. On load, the first Tab skips to "Third-party notices". | Help users recognise and recover; WCAG 2.1.1 | Unavailable commands stay focusable and explain the reason. Export menu items show the reason inline. | Fixed |
| UX-05 | High | **The canvas is boxed below a marketing hero.** At 1366×768 the canvas starts at y = 335 (44% of the height). The page scrolls 143 px, and Excalidraw's zoom and undo controls fall below the fold. At 390×844 the canvas starts at y = 531 (63%). On touch, dragging on the canvas draws, so the page is hard to scroll. At 1920×1080 the canvas is capped at 1438 px wide and the page still scrolls. | Content first for tools; flexibility and efficiency | A full-viewport app: a 48 px app bar above an edge-to-edge canvas, with no page scrolling. | Fixed |
| UX-06 | High | **The canvas jumps when a suggestion appears.** At 390 px the status line wraps and pushes the canvas down 64 px (y = 531 → 595), just as you need to review it. | Predictability; layout stability | Messages and review controls float over the canvas, so the canvas never moves. | Fixed |
| UX-07 | High | **All feedback is one small line under the buttons.** For example: "Diagram: 2 shapes, 1 arrow. Click an item to reject or restore it. Enter applies 3 of 3. Esc dismisses." It mixes summary, instructions and shortcuts. After applying, the message says "Ctrl+Z to undo" but offers no Undo control, which touch users can't press. While Interpret runs, nothing visible shows progress. | Visibility of system status; user control and freedom | The review bar shows a title, what will change, how many items are included, and a short hint. Results appear as a message near the canvas, with **Undo** after applying and **Cancel** while Interpret runs. Screen readers still hear the full sentence through a polite live region. | Fixed |
| UX-08 | High | **Accessible names don't match the visible labels.** axe flags `label-content-name-mismatch` on four Drawit buttons (Suggest, Diagram, Apply and Dismiss). For example, the visible "Suggest Y" is announced as "Suggest an improvement (Y)". Tooltips also replace the names. | WCAG 2.5.3 Label in Name | Accessible names match the visible labels. Shortcuts move to `aria-keyshortcuts` and tooltip descriptions. | Fixed |
| UX-09 | Medium | **Keyboard chips on touch devices.** "Y", "Shift+Y", "Enter" and "Esc" chips show on phones and tablets with no keyboard. Buttons are 32–34 px tall and the notices link is 20 px, below Microsoft's 40 px minimum for touch targets. | Match between system and the real world; touch target size | Shortcut hints show only on devices with a precise pointer. Touch devices get 40 px controls and "Tap" wording. | Fixed |
| UX-10 | Medium | **Jargon.** Examples: "Drawit assistance", "Select strokes with Excalidraw, or target the last freedraw stroke.", "geometry-only suggestion". | Match between system and the real world | Plain-language labels, tooltips and hints. The tagline moves into the app bar. | Fixed |
| UX-11 | Medium | **Exports are blocked without a clear path.** Export Mermaid and Export SVG are always on screen but disabled during review. The reason appears only in a footnote: "Exports wait until the preview is applied." | Error prevention; recognition rather than recall | One **Export** menu whose items say why they're unavailable. | Fixed |
| UX-12 | Medium | **Esc does nothing when a Drawit control has focus.** Shortcuts work only while the canvas has focus, so Esc on a focused control doesn't dismiss the preview. | User control and freedom; consistency | Esc in the review bar dismisses the preview, and Esc on the message cancels Interpret. After a command, focus returns to the canvas so Enter and Esc keep working. | Fixed |
| UX-13 | Medium | **Mermaid dialog problems.** The code block can't be scrolled with the keyboard, the copy result isn't announced, and "Download .mmd" wraps onto two lines. | WCAG 2.1.1; WCAG 4.1.3 | The code region is focusable and labelled, copy feedback is announced, and labels are shorter. | Fixed |
| UX-14 | Low | **Shortcuts are hard to discover, and a legal link competes with actions.** Shortcuts are listed only in the README and tooltips. "Third-party notices" sits inside the action card. | Help and documentation | A **More** menu with a Shortcuts and tips dialog, Third-party notices and a Source code link. | Fixed |
| UX-15 | Low | **Excalidraw's own accessibility issues.** Its main menu button has no accessible name (axe `button-name`, critical), its two colour-picker dialogs are unnamed, its zoom-reset button shows a percentage but is named "Reset zoom" (`label-content-name-mismatch`), and its footer is a nested `contentinfo` landmark. | WCAG 4.1.2; WCAG 2.5.3 | Upstream issues inside Excalidraw 0.18.1. Drawit does not patch Excalidraw's DOM. | Upstream |

## Results

The fixes were checked with the same scripted runs plus a 320×640 touch phone,
on a development build (with Interpret) and on a production build served from
`/drawit/`, as on GitHub Pages.

### Before and after

| Measure | Before | After |
| --- | --- | --- |
| Canvas top edge | 335 px at 1366×768 and 1920×1080; 375 px at 820×1180; 531 px at 390×844 | 48 px at every size, including 320×640 |
| Share of the screen given to the canvas | 55% at 1366×768; 52% at 1920×1080; 62% at 820×1180; 34% at 390×844 | 93–96% |
| Page scrolling | 143 px at 1366×768; 38 px at 1920×1080; 318 px at 390×844 | None |
| Canvas movement when a suggestion appears (390×844) | 64 px down | None |
| Apply, relative to the preview (1366×768) | About 330 px above it, in a card outside the canvas | About 12 px below it, and it stays there as you pan or zoom |
| Commands on screen while you draw | Seven buttons, all disabled on an empty canvas, and a link | Suggest, Diagram, Export and More (plus Interpret in development) |
| Touch targets | 32–34 px buttons and a 20 px link | 40 px |
| axe issues in Drawit's own interface | `label-content-name-mismatch` on four buttons | None in 16 states, including the review bar, the Export menu and both dialogs |

### Tests

- **UX checks:** 138 of 138 pass on the development build at 1366×768,
  1920×1080, 820×1180 (touch), 390×844 (touch) and 320×640 (touch). They cover
  layout, focus order, touch targets, review bar placement while panning,
  keyboard shortcuts, Apply and the Undo message on every layout, the Export
  menu, both dialogs, and axe.
- **Zoom:** the review bar stays centred about 12 px below the preview at 80%,
  100% and 120% zoom.
- **Regression runs on the production build:** 39 of 39 core scenarios and 72
  of 72 Diagram lens checks pass. New checks confirm that original strokes fade
  during review and return to full strength when their item is excluded.
- **Unit tests:** 7,651 pass in 18 files, including the new review bar placement
  tests. Type checking and the production build pass, and the production bundle
  contains no Interpret code.

### Found and fixed during verification

- Fluent UI copies the `FluentProvider` class onto every portal's mount node,
  so the full-height layout class turned each tooltip and menu portal into an
  invisible full-page layer that blocked clicks. The provider now uses an
  inline style.
- Closing a dialog opened from a menu left focus on the page body. Focus now
  returns to the menu button.
- Menus rendered outside every landmark (axe `region`). They now render inside
  the app bar.
- Fluent toolbar buttons are fixed at 32 px, so touch screens get a 40 px
  minimum.
- At 320 px the development-only Interpret button crowded the logo, so the logo
  hides there in development builds.
- On a narrow review bar, the hint wrapped mid-sentence and stranded
  "· Esc dismisses". The click hint and the keyboard hint now sit on separate
  lines.

### Known limitations

- Excalidraw's own issues (UX-15) remain upstream: four rules on desktop and
  tablet, and one on phones.
- Touch targets meet Microsoft's 40 px minimum but not Apple's 44 pt. Larger
  targets would need a tighter app bar at 320 px.
- Opening Excalidraw's main menu, a dialog or the context menu still dismisses a
  pending preview, so previews never reach saved or exported files. The message
  says so.
