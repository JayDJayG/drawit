# Drawit

**Extend what your hands can draw.**

Drawit is an experimental, human-first drawing studio that uses responsive assistance to help people turn ideas into marks. It is designed to make drawing more expressive, precise, and exploratory without taking authorship away from the person holding the pen.

## Vision

Drawing assistance should amplify human intent, not replace it. Drawit explores tools that can notice the shape, rhythm, and direction of a sketch, then offer useful possibilities while leaving every creative decision with the artist.

The goal is not to produce a finished image from a prompt. The goal is to help a person:

- express an idea before technique gets in the way;
- develop confidence through responsive, optional guidance;
- move between loose exploration and deliberate precision; and
- discover new forms by collaborating with a responsive tool.

## Principles

- **Human-directed:** the artist initiates, edits, accepts, rejects, and owns the result.
- **Suggestive, not automatic:** assistance should remain visible, reversible, and optional.
- **Low-friction:** the tool should support the natural flow of drawing rather than interrupt it.
- **Skill-building:** guidance should help people understand and extend their own capabilities.
- **Artist-controlled:** the artist decides what assistance to use and what work to keep.

## Current prototype

The current browser prototype is an Excalidraw-based drawing studio. It focuses on
improving freehand sketches while preserving the original mark. It includes:

- a full-window canvas under a slim app bar, with touch-sized controls on phones
  and tablets;
- Excalidraw's mouse, pen, and touch drawing tools, with freedraw active by default;
- native Excalidraw selection for choosing several strokes;
- non-destructive, dashed suggestions, reviewed in a bar beside the preview and
  explicitly applied or dismissed;
- a geometry-only Diagram lens for turning sketched flowcharts into native shapes,
  bound arrows, and typed labels;
- one-step undo and redo for an applied improvement, with an **Undo** button in
  the confirmation message;
- Mermaid and SVG export from the live native diagram; and
- self-hosted Excalidraw fonts and a production CSP with no third-party requests.

This is an early-stage experiment. The current improvement engine and Diagram lens are deterministic rather than trained recognition models, and the engine reports when a stroke is already clean. Model-based suggestions are planned for later iterations.

## How it works

1. The artist draws a stroke on the Excalidraw canvas.
2. The artist selects one or more freedraw elements, or leaves everything unselected to target the last freedraw stroke.
3. The artist chooses **Suggest** or presses `Y`. A selected group is checked as a possible four-stroke box.
4. The deterministic geometry engine simplifies noisy points, preserves meaningful corners, straightens near-linear strokes, and fits rough circles.
5. The suggestion appears as a locked, dashed overlay, and the original strokes under it fade so the change stands out. A review bar beside the preview says what will change. The preview is not part of undo history or saved/exported output, and the original strokes stay untouched until the artist applies it.
6. The artist chooses **Apply** or **Dismiss** in the review bar, or presses `Enter` or `Esc`. Applying replaces the sources in one undoable change. The confirmation message offers **Undo**; `Ctrl+Z` also restores the original strokes, and redo reapplies the change.

### Diagram lens

Draw a rough flowchart with freehand strokes, then add labels with Excalidraw's
text tool. Choose **Diagram** or press `Shift+Y`. Drawit
recognizes rectangles, rounded rectangles, diamonds, ellipses, connectors, and
typed labels. Connector endpoints are bound to recognized or existing native
shapes.

The diagram is shown as a single dashed preview before it changes the scene,
and the review bar counts how many items are included. Click or tap any preview
shape, arrow, or bound label to exclude it; click it again to include it.
Excluded items stay visible at low opacity, and strokes used only by excluded
items return to full strength. Choose **Apply** (`Enter`) to apply the included
items in one undoable step, or **Dismiss** (`Esc`) to discard the preview.
While a preview is pending, exports wait until it is applied or dismissed, and
the **Export** menu says so.

The deterministic Diagram lens uses **typed text only**. In local development,
the optional Interpret spike may propose vector labels from handwriting, and
those proposals still use the same dashed preview, per-item review, apply, and
undo path.

After applying a diagram, **Export › Mermaid code…** opens a reviewable Mermaid
definition with Copy and Download actions. **Export › SVG image** downloads the
live native Excalidraw output. Unbound arrows are omitted from Mermaid because
their endpoints cannot be represented as diagram edges.

Production builds keep Excalidraw's font-subsetting worker in its own
same-origin chunks (the build fails if that isolation breaks), so SVG export
works under a CSP without `'unsafe-eval'`. In development, Excalidraw may fall
back to main-thread subsetting if its optimized worker cannot load.

### Shortcuts

| Action | Shortcut |
| --- | --- |
| Suggest the selection or last freedraw stroke | `Y` |
| Suggest a diagram from strokes and typed labels | `Shift+Y` |
| Apply a pending suggestion | `Enter` |
| Dismiss a pending suggestion | `Esc` |

`Enter` and `Esc` are only handled by Drawit while a suggestion is pending and the
artist is not editing text or typing in an input. `Esc` also dismisses the
suggestion while the review bar has focus. **More › Shortcuts and tips** lists
these shortcuts in the app, and on touch screens the review bar's buttons do
the same job. Excalidraw's native shortcuts remain available.

Future versions will add flowchart-aware connector and layout suggestions, shape completion, proportion guides, perspective support, and optional model-based assistance.

## Getting started

### Requirements

- Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0`
- npm

### Development

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`. The Vite development server transpiles the TypeScript entrypoint and serves the browser module correctly. Do not open `index.html` directly with `file://`.

### Interpret (local development only)

Interpret is available only from a Vite development server. Copy `.env.example` to
`.env.local`, set `DEEPSEEK_API_KEY`, and run `npm run dev`. The browser sends
your simplified strokes, typed text, the deterministic T0 Diagram plan, and,
when supported, a marked PNG to the local dev-server route; the route sends
that data to DeepSeek while keeping the key on the server. DeepSeek bills each
request by input and output tokens; see its
[pricing page](https://api-docs.deepseek.com/quick_start/pricing).
Partial answers keep valid suggestions and report how many suggestions were skipped.
Interpret arrows also attach to shapes that are already on the canvas.
Changes to the key or other `.env.local` settings take effect on the next
Interpret press; they do not restart Vite or reload the drawing.
Set `DRAWIT_INTERPRET_CAPTURE=1` (also `true`, `yes`, or `on`) to save successful
and invalid-answer exchanges under `.drawit/interpret-captures/`; captures
contain the drawing and stay on your machine. Invalid-answer terminal logs
include the validator error count and a short JSON-escaped detail.

Hosted builds do not include the Interpret route, client, or button. The
messages have these meanings: `not-configured` asks you to add the key;
`auth` means DeepSeek rejected it; `balance` means the account has no
balance; `rate-limited` means to try again later; `upstream-rejected` means
the request parameters were rejected; `unavailable` means DeepSeek is
temporarily unavailable; `timeout` means the request exceeded its limit;
`cancelled` means you stopped it or changed the drawing; `invalid-answer`,
`empty-answer`, and `truncated` mean the model did not return a usable plan;
and `network` means the local server could not reach the configured upstream.

### Checks and production preview

```bash
npm run typecheck
npm test
npm run build
npm run preview
```

`npm run build` creates the deployable site in `dist/`. `npm run preview` serves that production build locally.

Regenerate the deterministic Phase 1 fixtures with:

```bash
npm run fixtures
```

The diagram accuracy harness runs as part of the test suite. To run it alone:

```bash
npx vitest run tests/diagram-accuracy.test.ts
```

Regenerate the package and font notices with:

```bash
npm run notices
```

The development server serves Excalidraw's installed production fonts directly.
Production builds copy the non-Liberation fonts from `node_modules` into
`dist/fonts/`, and the committed `THIRD_PARTY_NOTICES.md` is regenerated with
`npm run notices` and published at `dist/THIRD_PARTY_NOTICES.md`.

The test suite uses Vitest and includes real version-2 `.excalidraw` fixtures,
including seeded Diagram dev and holdout fixtures. The `src/perception/interpret/`
directory holds pure helpers (request builder, prompt, validators, Set-of-Mark
layout, and mock provider) and makes no network requests. The tests make no real
network requests either: they use fake keys and a mocked upstream. The
local-development-only Interpret section above adds the dev-only button and
route, and hosted builds exclude them.

## Roadmap

The full plan is in [docs/mvp-plan.md](docs/mvp-plan.md). The two-week MVP puts a Diagram lens in front of real users to validate demand. Every change is still a preview that a person accepts or rejects.

Two-week MVP:

- **Phase 0: Move onto Excalidraw.** Rebuild today's suggestions on an Excalidraw canvas (MIT), with Fluent UI panels, tests, and self-hosted assets.
- **Phase 1: Diagram lens.** Turn a sketched flowchart into clean shapes and bound arrows using geometry only, export Mermaid and SVG, and host the app online for testers.

After the MVP:

- **Phase 2: User testing,** starting with engineers, plus a pricing page or waitlist.
- **Phase 3: Recognition bake-off and Interpret.** Small in-browser models and an on-demand vision LLM, offered as paid AI features.
- **Phase 4: Interface lens.** Turn a wireframe sketch into an editable Fluent UI preview, with HTML and SVG export for Figma and Penpot.
- **Phase 5: Art lens experiment.** Drawing guides, doodle hints, and an opt-in vector "ghost" guide, built from the artist's own strokes, that never replaces them.
- **Phase 6: Learner and motor-assistance features.** A short explanation with each suggestion, stronger smoothing, and easier shape snapping.
- **Phase 7: Lettering lens.** Guides, neater letters, and smoother strokes for hand lettering and handwriting practice, always in the writer's own hand.

Recognition escalates from free geometry, to small in-browser models, to a vision LLM that runs only when the artist asks.

## License

Drawit's license hasn't been chosen yet; see decision 9 in the [MVP plan](docs/mvp-plan.md).