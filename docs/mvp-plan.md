# Drawit MVP plan

_Status: agreed on 2026-10-17, then re-scoped the same day after an assumption check. Updated that evening to design the Interpret (vision-LLM) seam into Phase 1. §3 records the decisions and §9 defines the two-week MVP._

## 1. Goal

Drawit extends what people can draw without taking authorship away from them. The product has to show that a single sketch can become a higher-fidelity result for each of these personas, with a person reviewing every change:

| Persona | From | To |
| --- | --- | --- |
| Artist | rough sketch | better art from their own strokes: guides, refinement, an optional generative "ghost" reference |
| Engineer | whiteboard-style sketch | a technical diagram: flowchart or architecture diagram, exported as Mermaid, SVG or draw.io; CAD-style constraints later |
| UI/UX designer | wireframe sketch | an editable UI: Fluent UI web-components HTML, plus SVG to import into Figma or Penpot |
| Learner | unsure, wobbly strokes | cleaner strokes, each with a short explanation of what changed |
| Person who needs motor assistance | shaky or imprecise strokes | stronger smoothing, and shapes that snap into place with fewer precise movements |

The two-week MVP serves engineers only. Its job is to validate demand with real users (decision 6). The other personas follow after user testing.

## 2. Guardrails

- **Human-first.** Every change is shown as a preview first. The user can accept or reject each element, and undo is always available.
- **Traceable.** Every recognized element points back to the IDs of the strokes it came from.
- **Cheap by default.** Use the cheapest tier that can answer, and escalate only when the user asks.
- **Provider-agnostic.** Models sit behind adapters, and API keys never reach the browser.

## 3. Decisions

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Recognition | The perception ladder (§6): geometry first, then small local models, then a vision LLM on demand. The JEPA research track is parked (§7). |
| 2 | Lens order | Diagram first. Interface is the headline demo. Art is a time-boxed experiment. |
| 3 | Vision-LLM provider | Phase 1 builds the Interpret (T2) seam: a suggestion plan shared with T0, a provider interface and a mock (§6). The first real adapter speaks the OpenAI-compatible Chat Completions API and targets DeepSeek (`deepseek-flash` accepts images). It is tried in a local-only spike, keeps its key on a server, and stays out of the hosted MVP and the first user tests. The bake-off (Phase 3) can change the default provider. T2 returns actionable suggestions about the user's own strokes, never generated images. |
| 4 | Canvas foundation | Excalidraw (`@excalidraw/excalidraw`, MIT), pinned to an exact version and isolated behind an adapter (§5). |
| 5 | Plan location | This file, linked from the README roadmap. |
| 6 | MVP purpose | Validate demand with real users. |
| 7 | Personas | Five (§1): artists, engineers, UI/UX designers, learners, and people who need motor assistance. The MVP serves engineers. |
| 8 | Business model | Open core: the app is free, and hosted AI features are paid. |
| 9 | Drawit license | Not chosen yet. Until it is, the repo has no `LICENSE` file and the README makes no license claim. |
| 10 | Timeline and team | Two weeks, one developer working with AI assistants. A demo is ready at the end of week 2, and user tests follow. |
| 11 | Two-week scope | Phase 0, a geometry-only Diagram lens with Mermaid export, and online hosting (§9). Everything else waits until after user testing. |
| 12 | Willingness to pay | Measured with a pricing page or waitlist during user testing. |
| 13 | Hosting | GitHub Pages, deployed by a GitHub Actions workflow from the public `drawit` source repo. Pages has no custom headers or serverless functions, so the CSP is a `<meta>` tag and the paid AI proxy (Phase 3) will need another host. Publishing before decision 9 means all rights are reserved by default. |

## 4. Architecture: one core, three lenses

Excalidraw provides the canvas: freehand ink, selection, undo, rendering and export. Everything Drawit adds is plain TypeScript, and only one adapter module imports Excalidraw.

```text
Excalidraw canvas: freedraw ink, selection, undo, JSON/PNG/SVG export
  -> canvas adapter: freedraw elements <-> Drawit strokes; selection -> target
  -> geometry: cleanup, primitives, groups               (already started)
  -> structure: scene graph (nodes, edges, containment, alignment, text regions)
  -> perception ladder T0 -> T1 -> T2                    (escalates on demand)
  -> lens: Art | Diagram | Interface
  -> review: preview on the canvas, accept/reject per element, undo
  -> export: Excalidraw JSON/PNG/SVG, Mermaid/draw.io, HTML, Figma/Penpot
```

| Module | Responsibility |
| --- | --- |
| `src/core/geometry` | Stroke cleanup and fitting: today's `drawing-improvement-engine.ts`, ported unchanged |
| `src/core/structure` | Scene graph |
| `src/core/suggestions` | The suggestion plan that every tier and lens emits, and that the review step previews and applies |
| `src/perception` | T0 recognizers, T1 Web Worker, T2 client |
| `src/lenses` | Diagram, Interface and Art lenses |
| `src/canvas/excalidraw` | The only module that imports Excalidraw |
| `src/ui` | Drawit panels, built with Fluent UI React v9 (`@fluentui/react-components`) |

## 5. Canvas foundation: Excalidraw

Checked against the `@excalidraw/excalidraw@0.18.1` type definitions.

| Drawit need | Excalidraw mechanism |
| --- | --- |
| Read ink | `freedraw` elements (`points`, `pressures`) from `onChange(elements, appState, files)`; `onPointerUp` marks the end of a stroke |
| Target strokes | `appState.selectedElementIds`. With nothing selected, the target is the last stroke. This replaces our marquee and the `M` select mode. |
| Show a preview | Dashed (`strokeStyle: "dashed"`), `locked` elements tagged with `customData` (for example `{ drawit: "preview", sourceIds }`), added with `updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })` so they never enter undo history |
| Apply | Remove the preview with `NEVER`, then replace the source strokes with native elements in one `IMMEDIATELY` update. One undo then restores the original strokes. Removing the preview inside the `IMMEDIATELY` update would record it, and undo would bring it back. |
| Build native elements | `convertToExcalidrawElements` skeletons: rectangle, ellipse, diamond, line, and arrows with `start`/`end` bindings and `label`s |
| Dismiss | Remove the preview with `NEVER`. Also dismiss it whenever the user edits the scene. |
| Imperative access | The `excalidrawAPI` prop |
| Trim the UI | `UIOptions` (`canvasActions`, `tools.image`) |
| Save, export, fixtures | `serializeAsJSON`, `exportToSvg` and `exportToBlob`, after filtering out preview elements. Saved `.excalidraw` files double as test fixtures. |
| Mermaid | Mermaid → Excalidraw import through `@excalidraw/mermaid-to-excalidraw`, already a dependency. Scene graph → Mermaid export is ours to build. |

Constraints to design around:

- **No per-point timing.** `freedraw` elements keep points and pressures but not timestamps, and stroke order comes from element order. If timing matters later, the adapter records it and stores it in `customData`.
- **Shortcuts.** Excalidraw already uses most single-letter keys, so Drawit's `S`, `M` and `G` bindings will change. Choose non-conflicting ones in Phase 0.
- **Fonts and assets.** By default, Excalidraw downloads its fonts from `esm.sh`. Setting `window.EXCALIDRAW_ASSET_PATH` puts our own host first, but `esm.sh` stays as the last fallback. Self-host `dist/prod/fonts` and restrict `font-src` with a Content Security Policy so that a session makes no third-party requests.
- **API stability.** Excalidraw documents the element skeleton API as "in beta and subject to change before stable". Pin the exact version and keep every Excalidraw import inside `src/canvas/excalidraw`.
- **Bundle size.** Lazy-load the editor and run T1 models in a Web Worker.
- **Setup.** Import `@excalidraw/excalidraw/index.css` and give the editor's container an explicit height.

## 6. Perception ladder (do we need LLMs?)

Yes, but only for meaning, and only when the user asks. Precision comes from geometry and small local models.

| Tier | What | Cost / speed | Good for | Not for |
| --- | --- | --- | --- | --- |
| **T0** Geometry + $Q | Deterministic fitting (we already have line, curve, circle, rectangle) plus the $Q point-cloud recognizer with user-defined templates | Free, sub-millisecond, offline | Shapes, arrows, diamonds, connectors, a user's personal symbols | Meaning, handwriting |
| **T1** Small local models | transformers.js in a Web Worker: QuickDraw doodle classifier, DINOv2-small embeddings for few-shot k-NN, optional SigLIP zero-shot labels | Free after a one-time 6–95 MB download; millisecond-scale (to be measured) | "What object is this?", UI component type, personal-symbol lookup | Handwriting, layout intent, code |
| **T2** Vision LLM on demand | Simplified strokes, typed text and the T0 suggestion plan in, plus a Set-of-Mark image for models that accept images; a schema-validated suggestion plan out that references stroke IDs only | Seconds, a few cents per request | Labels and handwriting, element roles, layout intent, composition feedback, generating Mermaid or HTML | Real-time feedback, generating images |

Rule: T0 always runs. T1 gives cheap, continuous hints. T2 runs only when the user presses Interpret, which keeps cost and latency predictable. The two-week MVP ships T0 only (decision 11).

### Interpret seam (T2)

T2 doesn't draw for the user. It interprets their strokes and composition and answers with suggestions they can act on: cleaner strokes, shapes, connectors, labels and, later, guides. Every suggestion points back to the user's own stroke IDs, and T2 never returns a generated image.

- **One suggestion plan.** `src/core/suggestions` defines a versioned, provider-neutral plan. T0 lenses emit it from Phase 1, and T2 will emit the same plan, so both share one preview, per-element review and apply path. Each item names its source element IDs and can carry a confidence and a short reason, which the learner explanations (Phase 6) can reuse.
- **Provider seam.** `src/perception/interpret` holds:
  - an `InterpretProvider` interface that declares its capabilities (image input, JSON mode);
  - a request type: lens, simplified strokes with IDs, typed text, the T0 plan, an optional Set-of-Mark image and the user's intent;
  - a pure prompt builder, a strict response validator and a mock provider.

  Phase 1 adds no network code.
- **First adapter.** OpenAI-compatible Chat Completions, configured for DeepSeek: base URL `https://api.deepseek.com`, model `deepseek-flash`, images sent as `image_url` data URLs, and JSON Output (`response_format: {"type": "json_object"}`). JSON Output needs the word "json" and an example in the prompt. It can occasionally return empty content, which counts as a failed request. Models without image input get the strokes and the plan as text only. Checked against the DeepSeek API docs on 2026-10-17.
- **Keys stay on a server.** In local development, a Vite dev-server route, `/api/interpret`, reads `DEEPSEEK_API_KEY` from `.env.local`, which git ignores. The key never gets a `VITE_` prefix, because Vite inlines those variables into the bundle. The hosted proxy comes in Phase 3 on another host (decision 13), and its origin is added to `connect-src`.

### T1 candidates (verified Oct 2026)

| Model | Size (ONNX) | License | Role |
| --- | --- | --- | --- |
| `Xenova/quickdraw-mobilevit-small` | 5.6 MB quantized | base model `apple/mobilevit-small` uses an "other" license; check before shipping | 345 QuickDraw categories. The Doodle Dash demo runs it in the browser at more than 60 predictions per second. |
| `Xenova/dinov2-small` (ViT-S/14) | 12–14 MB q4, 21–23 MB int8 | Apache-2.0 | Embeddings for few-shot k-NN on a user's own symbols and UI components |
| `onnx-community/dinov3-vits16…` (ViT-S/16) | 14 MB q4, 21 MB int8 | custom DINOv3 License | Alternative to DINOv2 |
| `Xenova/siglip-base-patch16-224` (vision encoder) | 52–95 MB | Apache-2.0 | Zero-shot labels. Precompute the text embeddings offline and ship only the vision encoder. |
| `Xenova/mobileclip_s0` | 11 MB vision (int8) | **Apple research-only terms, no commercial use** | Benchmark only |

Handwriting candidates for a local spike: TrOCR and Florence-2, both supported by transformers.js. Otherwise handwriting goes to T2.

## 7. JEPA assessment

**What JEPA is.** JEPA models are self-supervised encoders that learn by predicting the *embeddings* of masked or missing regions. They output embeddings, not labels. To get labels you need a probe, k-NN, or a language-aligned variant.

| Model | Facts | Fit for Drawit now |
| --- | --- | --- |
| I-JEPA (2023, images) | ViT-H/14 and ViT-g checkpoints; **CC BY-NC 4.0**; ONNX builds exist for transformers.js but weigh 2.4 GB fp32 or about 340–610 MB quantized | No: too large, non-commercial |
| V-JEPA 2 (2025) / 2.1 (Mar 2026) | Video encoders from 80M (2.1 ViT-B) to 2B parameters; mostly MIT; not supported by transformers.js | No: video and robotics focus, too large |
| VL-JEPA (Dec 2025) | 1.6B-parameter vision-language model; open-vocabulary classification benchmarked on video | No: not a browser model |
| LeJEPA (Nov 2025) | A *training recipe* (SIGReg): about 50 lines, one hyperparameter, stable across ResNets, ViTs and ConvNets | Only as a future research track (parked, below) |

No model called "JEV" could be found; it is probably a mix-up with V-JEPA.

**Verdict.** Don't use JEPA for MVP recognition. Off-the-shelf JEPAs are big, trained on photos and video rather than line drawings, partly non-commercial, and blind to stroke order. For cheap, fast recognition, T0 plus the small T1 models above are the better option.

**Parked: a sketch-JEPA research track.** This is not part of the MVP (decision 1). If we revisit it after Phase 4, the idea is to train a small, sketch-native encoder with LeJEPA on QuickDraw (50M timestamped vector drawings, 345 categories, CC BY 4.0) plus our own fixtures. The payoffs would be a permissively licensed T1 encoder under 10 MB and "what's missing here?" completion suggestions. Go/no-go: it must beat DINOv2-small few-shot accuracy at the same size or smaller.

## 8. Lenses

### Diagram / Engineering lens (two-week MVP)

- **Recognize** (geometry only in the MVP): boxes, rounded boxes, diamonds, circles, arrows and connectors with endpoints snapped to shapes, text regions.
- **Structure:** nodes, directed edges, containment (groups and lanes), alignment and spacing.
- **Labels:** in the MVP, typed text: Excalidraw text elements inside a shape or next to an arrow. Handwriting comes later, via T2 or the local TrOCR/Florence-2 spike.
- **Output:** a preview of native Excalidraw shapes with bound arrows, then Mermaid and SVG export; draw.io XML later.
- **Later:** planegcs constraints (parallel, perpendicular, tangent, dimension) leading to DXF.

### Interface lens (headline demo, after the MVP)

- **Component vocabulary:** button, text input, checkbox, radio, toggle, dropdown, image placeholder, icon, heading or text block, card or container, nav bar, list.
- **Recognition:** T0 (rectangles plus the marks inside them), T1 (DINOv2 k-NN or a small classifier trained on UISketch, which has 17,979 sketches in 21 classes; license to confirm), and T2 for text and intent.
- **Layout inference:** rows, columns and stacks; alignment and spacing; producing a layout tree.
- **Output:** a live Fluent UI web-components preview; HTML and SVG export for Figma and Penpot; later a Penpot plugin via the official Penpot MCP server.

### Art lens (time-boxed experiment, after the MVP)

- **Deterministic guides first**, which is the user's stated priority: symmetry, perspective grids, proportion, construction shapes.
- **Pressure-like strokes for free:** Excalidraw already renders `freedraw` elements with perfect-freehand.
- **T1 QuickDraw hint:** for example, "looks like a cat", which then offers relevant guides and references.
- **Opt-in generative ghost layer:** a sketch-conditioned image (ControlNet scribble or lineart via ComfyUI or a hosted API) shown as a translucent underlay that never replaces the artist's strokes.
- **Later:** SketchAgent-style stroke-by-stroke suggestions.

## 9. Phases and exit criteria

Targets marked † are initial guesses, to be recalibrated after the recognition bake-off (Phase 3).

### Two-week MVP

**Phase 0: Move onto Excalidraw (week 1)**
- Add React, `@excalidraw/excalidraw` pinned to `0.18.1`, and `@fluentui/react-components`; keep Vite and TypeScript.
- Restructure into the `src/` modules from §4, porting the geometry engine unchanged.
- Build the canvas adapter (§5). Rebuild suggest → preview → apply or dismiss → undo for single strokes and selected groups (line, curve, circle, rectangle).
- Rebuild the suggestion panel with Fluent UI React v9, and choose non-conflicting shortcuts.
- Self-host Excalidraw's fonts and add `THIRD_PARTY_NOTICES.md` (§10). Hold the `LICENSE` file until decision 9 is made.
- Add Vitest, using `.excalidraw` files as fixtures.
- Remove `quickdraw-integration.ts` and the old canvas markup once the new version reaches parity.
- Once this phase passes review, deploy it to GitHub Pages (decision 13). That tests the sub-path, the CSP and the self-hosted fonts on the real host early.
- *Exit:* parity with today's prototype; geometry and adapter tests pass on fixtures; a sketch round-trips through JSON; the exported SVG opens in Figma or Penpot; a session makes no requests to `esm.sh`.

**Phase 1: Diagram lens, geometry only (week 2)**
- Fit arrows, diamonds and connectors; build the scene graph; emit native Excalidraw shapes with bound arrows.
- Read labels from typed text inside shapes and next to arrows.
- Add the shared suggestion plan (§6) and move the stroke cleanup onto it. Each preview item can be accepted or rejected before applying.
- Build the Interpret seam (§6) without network code: provider interface, prompt builder, response validator and a mock provider, all covered by tests.
- Add Mermaid and SVG export.
- Every push to `main` redeploys to GitHub Pages (decision 13). The workflow type-checks, tests, and builds with the repo's base path. No server is needed while Interpret is out.
- *Exit:* node/edge accuracy of at least 90%† on fixtures; the MVP demo (§11) works on the hosted build; a hosted session makes no third-party requests.

### After the MVP

Phase 2 follows the demo directly. The Interpret spike can run alongside it because it never ships to the hosted build. The order of the later phases will be revisited after user testing.

**Interpret spike (local development only, right after Phase 1)**
- Add the OpenAI-compatible DeepSeek adapter behind the dev-server route `/api/interpret` (§6), plus an **Interpret** button that exists only in development builds.
- Send the simplified strokes, typed text and the T0 plan, plus a Set-of-Mark image when the model accepts images. Validate the answer and show it through the same preview and per-element review as T0.
- *Exit:* a messy flowchart with handwritten labels comes back as a valid plan that previews and applies like a T0 suggestion; invalid or empty answers leave the canvas untouched and say why; the key never appears in the bundle, the browser or git.

**Phase 2: User testing**
- Task-based tests with 3–5 users per persona, starting with engineers.
- A pricing page or waitlist to measure willingness to pay (decision 12).
- Measure the suggestion acceptance rate, users' sense of ownership, and sign-ups.

**Phase 3: Recognition bake-off and Interpret**
- **Bake-off** on our fixtures plus samples from FC_A/OHFCD, UISketch and QuickDraw:
  - Candidates: $Q, QuickDraw-MobileViT, DINOv2-small k-NN (5 examples per class), SigLIP zero-shot, and the vision LLM.
  - Measure accuracy, p50/p95 latency in Edge (WASM and WebGPU), download size, and cost.
  - For each task, pick the cheapest tier that meets its target.
- Add $Q templates for personal symbols.
- Host the `/api/interpret` proxy outside Pages (decision 13), reusing the Phase 1 seam and the spike's adapter, and add its origin to `connect-src`. The bake-off can replace DeepSeek as the default provider. Hosted AI is the paid tier (decision 8), so the proxy also needs access control and quotas.
- *Exit:* with a real provider, flowchart to Mermaid with handwritten labels in under 5 s p95†.

**Phase 4: Interface lens (headline demo)**
- Component recognition, layout inference, Fluent preview, HTML/SVG export.
- *Exit:* five sample wireframes become editable HTML with at least 80%† of components correct before any edits.

**Phase 5: Art lens experiment (time-boxed)**
- Guides, QuickDraw hints, and a ghost-layer spike.
- *Exit:* a go/no-go decision based on users' sense of ownership and their feedback.

**Phase 6: Learner and motor-assistance features**
- A short explanation with each suggestion.
- Stronger smoothing for shaky strokes, and shapes that snap into place with fewer precise movements.
- *Exit:* tested with learners and people who need motor assistance.

## 10. Licensing

Excalidraw is MIT-licensed ("Copyright (c) 2020 Excalidraw"). That allows commercial use, modification, bundling and selling, so it fits the open-core model (decision 8) whichever license Drawit chooses. These findings were checked on 2026-10-17 against version 0.18.1. They are not legal advice.

- **Notices.** Ship Excalidraw's MIT notice, plus the licenses of its dependencies and fonts, in `THIRD_PARTY_NOTICES.md`. The npm package doesn't include the font license files, so we have to add them ourselves.
- **Dependencies.** All 243 packages installed with `@excalidraw/excalidraw@0.18.1` and React 19 use permissive licenses: 182 MIT, 38 ISC, 10 Apache-2.0, 7 BSD-3-Clause, and one each of CC0-1.0, Unlicense and 0BSD. Three needed a closer look:
  - DOMPurify is MPL-2.0 OR Apache-2.0; we take it under Apache-2.0.
  - pako is MIT AND Zlib, both permissive.
  - khroma is MIT according to its license file; its `package.json` doesn't declare a license.
- **Fonts** shipped in `dist/prod/fonts` (OFL fonts can be bundled with commercial software, but can't be sold on their own):

  | Font | License | Evidence |
  | --- | --- | --- |
  | Virgil | OFL-1.1 | `excalidraw/virgil` repository |
  | Excalifont | OFL-1.1 | Maintainer answer in Excalidraw discussion #11623; the "MIT" on the Excalifont page is a typo |
  | Assistant, Lilita One, Nunito | OFL-1.1 | License fields in the font files |
  | Cascadia Code | OFL-1.1 | `microsoft/cascadia-code` LICENSE |
  | Xiaolai SC | OFL-1.1 | `lxgw/kose-font` repository |
  | Comic Shanns | MIT | License field in the font file |
  | Liberation Sans 1.05 | GPLv2 with a font exception (the Liberation 1.x terms) | Debian `fonts-liberation` 1.07.4 `License.txt`. Excalidraw uses it only for server-side PDF and PNG export, so leave it out of our self-hosted fonts. |

- **Brand.** The MIT license grants no rights to the Excalidraw name or logo, so Drawit keeps its own brand.
- **Hosted services.** Excalidraw+ and the collaboration and AI services on excalidraw.com are separate products. Drawit doesn't use them.

## 11. Demo script

**MVP demo (end of week 2, about 1 minute).** Draw a messy flowchart and type its labels. Ask Drawit for a diagram suggestion, and a clean preview with bound arrows appears on the same canvas. Accept it, export Mermaid, and show that one undo brings back the original strokes.

**Full demo (after Phases 3–5, about 2 minutes):**

1. Draw a messy flowchart and press **Interpret**. A clean diagram preview appears with the labels read. Accept it and export Mermaid.
2. Sketch a login screen and switch to the Interface lens. A Fluent UI preview appears. Tweak it, export HTML or SVG, and open it in Penpot or Figma.
3. Sketch a cat. Symmetry and proportion guides appear with an optional ghost reference, and the artist refines their own strokes.

## 12. Metrics

- **Recognition:** precision and recall per element type; character error rate for labels.
- **Latency targets:** T0 under 16 ms; T1 under 100 ms p95†; T2 under 5 s p95†.
- **Cost:** cents per interpreted sketch; share of interactions that need T2.
- **Human-first:** suggestion acceptance rate; edits made after accepting; self-reported sense of ownership.
- **Demand:** waitlist sign-ups or pricing-page visits per tester.

## 13. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Two weeks for one developer | Geometry-only Diagram lens; Interpret, the bake-off and the other lenses wait until after user testing |
| GitHub Pages has no server side | CSP in a `<meta>` tag; host the Phase 3 proxy elsewhere (for example Azure Functions or Cloudflare Workers) and allow only its origin in `connect-src` |
| LLM hallucination | Schema validation, references to stroke IDs only, preview plus per-element accept |
| Latency and cost | Use the ladder, run T2 only on demand, cache results by scene-graph hash |
| API key exposure | Keys live only on a server: `.env.local` behind the dev-server route in development, the hosted proxy in production. Never put a key in a `VITE_`-prefixed variable, because Vite inlines those into the bundle. |
| Model licenses | Keep non-commercial weights such as MobileCLIP out of shipped builds; confirm the MobileViT base and UISketch licenses |
| Excalidraw API changes | Pin the version, keep Excalidraw behind `src/canvas/excalidraw`, and cover the adapter with fixture tests |
| Third-party requests and license drift | Self-host assets behind a strict CSP; re-run the license scan and regenerate `THIRD_PARTY_NOTICES.md` on every upgrade |
| Bundle size | Lazy-load the editor and keep models in a Web Worker |
| Crowded sketch-to-UI market | Differentiate on fidelity to the sketch, traceability and human control |
| Authorship concerns (Art lens) | Ghost layer is opt-in and never applied automatically |

## 14. Sources

- Excalidraw: https://github.com/excalidraw/excalidraw (MIT); developer docs: https://docs.excalidraw.com; npm `@excalidraw/excalidraw` 0.18.1
- Excalidraw element skeleton API: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton
- Excalifont license: https://github.com/excalidraw/excalidraw/discussions/11623
- Other font licenses: https://github.com/excalidraw/virgil; https://github.com/microsoft/cascadia-code/blob/main/LICENSE; https://github.com/lxgw/kose-font
- Liberation 1.x license: https://sources.debian.org/src/fonts-liberation/1:1.07.4-11/License.txt/
- Fluent UI: https://developer.microsoft.com/en-us/fluentui
- DeepSeek API: https://api-docs.deepseek.com; vision: https://api-docs.deepseek.com/guides/vision/; JSON Output: https://api-docs.deepseek.com/guides/json_mode
- V-JEPA 2 / 2.1: https://github.com/facebookresearch/vjepa2 (arXiv 2506.09985)
- I-JEPA: https://github.com/facebookresearch/ijepa; HF `facebook/ijepa_vith14_1k`; ONNX `onnx-community/ijepa_vith14_1k`
- VL-JEPA: arXiv 2512.10942
- LeJEPA: arXiv 2511.08544, https://github.com/rbalestr-lab/lejepa
- transformers.js supported models: https://huggingface.co/docs/transformers.js/index
- Doodle Dash, in-browser QuickDraw recognition: https://huggingface.co/blog/ml-web-games
- QuickDraw dataset: https://github.com/googlecreativelab/quickdraw-dataset
- DINOv2: https://github.com/facebookresearch/dinov2; DINOv3: https://github.com/facebookresearch/dinov3
- MobileCLIP: https://github.com/apple/ml-mobileclip (model license `LICENSE_MODELS`)
- CLIP on sketches: CLIPasso (arXiv 2202.05822); CLIP for zero-shot sketch-based image retrieval (arXiv 2303.13440)
- Set-of-Mark prompting: arXiv 2310.11441, https://github.com/microsoft/SoM
- $P/$Q recognizers: https://depts.washington.edu/acelab/proj/dollar; TypeScript $Q port: kaminorse/qdollar-super-quick-recognizer
- SketchAgent: https://github.com/yael-vinker/SketchAgent
- planegcs: https://github.com/Salusoft89/planegcs
- Penpot MCP: https://github.com/penpot/penpot-mcp
- Krita AI Diffusion: https://github.com/Acly/krita-ai-diffusion
- Datasets: UISketch (Kaggle); FC_A/OHFCD and FC_B (cmp.felk.cvut.cz/~breslmar/flowcharts); CASIA-OHFC; https://github.com/bernhardschaefer/handwritten-diagram-datasets
