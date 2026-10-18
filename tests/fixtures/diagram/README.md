# Diagram fixtures

The deterministic generator is `scripts/generate-diagram-fixtures.mjs`, run with
`npm run fixtures`. It uses separate layout templates and seed ranges for the
development and holdout splits; do not tune recognizer thresholds against the
holdout.

Positive fixtures contain five to nine-node flowcharts in top-to-bottom and
left-to-right arrangements. They include ellipses, sharp and rounded
rectangles, diamonds, containers, back-edges, and straight, elbow and curved
connectors. Arrowheads include inline hooks and Vs, separate Vs and paired
barbs, in either direction. Separate heads may be offset from the shaft tip,
drawn toward or away from it, and use uneven lengths and angles. Labels are
typed but deliberately offset.

The noise model samples paths densely (roughly every 2–8 px), adds
low-frequency wobble and small jitter, rotates closed shapes by up to 5
degrees, varies stroke order and direction, leaves closure gaps or overshoots,
and makes connector endpoints stop short of or enter the target by roughly
15 px. Some connectors are drawn from target to source. Rectangles and
diamonds can be drawn in two, three or four strokes. Negative fixtures contain
handwriting-like strokes, hatching, spirals, tangled scribbles and short words,
and should produce no diagram items.

Each fixture has an `.excalidraw` scene and an `.expected.json` ground-truth
file. `manifest.json` records the deterministic seeds and split.
