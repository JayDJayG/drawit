import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const fixtureRoot = join(root, 'tests', 'fixtures', 'diagram');
const fixtureReadme = `# Diagram fixtures

The deterministic generator is \`scripts/generate-diagram-fixtures.mjs\`, run with
\`npm run fixtures\`. It uses separate layout templates and seed ranges for the
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

Each fixture has an \`.excalidraw\` scene and an \`.expected.json\` ground-truth
file. \`manifest.json\` records the deterministic seeds and split.
`;
const round = (value) => Number(value.toFixed(3));

const randomFor = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const integer = (random, minimum, maximum) => (
  minimum + Math.floor(random() * (maximum - minimum + 1))
);

const between = (random, minimum, maximum) => (
  minimum + random() * (maximum - minimum)
);

const choose = (random, values) => values[Math.floor(random() * values.length)] ?? values[0];

const point = (x, y) => ({ x, y });

const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);

const add = (first, second) => point(first.x + second.x, first.y + second.y);
const subtract = (first, second) => point(first.x - second.x, first.y - second.y);
const scale = (value, amount) => point(value.x * amount, value.y * amount);

const normalize = (value) => {
  const length = Math.hypot(value.x, value.y);
  return length < 0.001 ? point(1, 0) : scale(value, 1 / length);
};

const perpendicular = (value) => point(-value.y, value.x);

const rotate = (value, center, angle) => {
  const dx = value.x - center.x;
  const dy = value.y - center.y;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return point(
    center.x + dx * cosine - dy * sine,
    center.y + dx * sine + dy * cosine,
  );
};

const jitterPoint = (random, value, amount) => point(
  value.x + between(random, -amount, amount),
  value.y + between(random, -amount, amount),
);

const sampleSegment = (random, first, second, options = {}) => {
  const step = options.step ?? between(random, 2, 8);
  const wobble = options.wobble ?? 0;
  const jitter = options.jitter ?? 0;
  const length = distance(first, second);
  const count = Math.max(1, Math.ceil(length / step));
  const direction = normalize(subtract(second, first));
  const normal = perpendicular(direction);
  const phase = between(random, 0, Math.PI * 2);
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const ratio = index / count;
    const base = point(
      first.x + (second.x - first.x) * ratio,
      first.y + (second.y - first.y) * ratio,
    );
    const envelope = Math.sin(Math.PI * ratio);
    const lowFrequency = wobble * envelope * Math.sin(phase + ratio * Math.PI * 2);
    const noisy = add(base, scale(normal, lowFrequency));
    points.push(index === 0 || index === count
      ? noisy
      : jitterPoint(random, noisy, jitter));
  }
  return points;
};

const samplePolyline = (random, vertices, options = {}) => {
  const points = [];
  for (let index = 1; index < vertices.length; index += 1) {
    const segment = sampleSegment(random, vertices[index - 1], vertices[index], options);
    if (index > 1) {
      segment.shift();
    }
    points.push(...segment);
  }
  return points;
};

const pathLength = (points) => {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
};

const pointAtPath = (vertices, ratio) => {
  const lengths = [0];
  for (let index = 1; index < vertices.length; index += 1) {
    lengths.push(lengths[index - 1] + distance(vertices[index - 1], vertices[index]));
  }
  const total = lengths[lengths.length - 1] ?? 0;
  const target = Math.max(0, Math.min(1, ratio)) * total;
  let segment = 1;
  while (segment < lengths.length - 1 && lengths[segment] < target) {
    segment += 1;
  }
  const before = lengths[segment - 1] ?? 0;
  const after = lengths[segment] ?? total;
  const local = after === before ? 0 : (target - before) / (after - before);
  const first = vertices[segment - 1] ?? vertices[0];
  const second = vertices[segment] ?? vertices[vertices.length - 1];
  return point(
    first.x + (second.x - first.x) * local,
    first.y + (second.y - first.y) * local,
  );
};

const makePathFragment = (random, vertices, startRatio, endRatio) => {
  const points = [];
  const length = pathLength(vertices);
  const count = Math.max(2, Math.ceil((length * (endRatio - startRatio)) / between(random, 4, 7)));
  for (let index = 0; index <= count; index += 1) {
    points.push(pointAtPath(vertices, startRatio + ((endRatio - startRatio) * index) / count));
  }
  return points;
};

const rectanglePath = (bounds) => [
  point(bounds.x, bounds.y),
  point(bounds.x + bounds.width, bounds.y),
  point(bounds.x + bounds.width, bounds.y + bounds.height),
  point(bounds.x, bounds.y + bounds.height),
  point(bounds.x, bounds.y),
];

const diamondPath = (bounds) => [
  point(bounds.x + bounds.width / 2, bounds.y),
  point(bounds.x + bounds.width, bounds.y + bounds.height / 2),
  point(bounds.x + bounds.width / 2, bounds.y + bounds.height),
  point(bounds.x, bounds.y + bounds.height / 2),
  point(bounds.x + bounds.width / 2, bounds.y),
];

const roundedRectanglePath = (bounds) => {
  const radius = Math.min(16, bounds.width * 0.18, bounds.height * 0.3);
  const corners = [
    [point(bounds.x + radius, bounds.y + radius), Math.PI, Math.PI * 1.5],
    [point(bounds.x + bounds.width - radius, bounds.y + radius), -Math.PI / 2, 0],
    [point(bounds.x + bounds.width - radius, bounds.y + bounds.height - radius), 0, Math.PI / 2],
    [point(bounds.x + radius, bounds.y + bounds.height - radius), Math.PI / 2, Math.PI],
  ];
  const points = [];
  for (const [center, start, end] of corners) {
    for (let index = 0; index <= 5; index += 1) {
      const angle = start + ((end - start) * index) / 5;
      points.push(point(
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius,
      ));
    }
  }
  points.push(points[0]);
  return points;
};

const ellipsePath = (bounds) => {
  const circumference = Math.PI * (3 * (bounds.width + bounds.height)
    - Math.sqrt((3 * bounds.width + bounds.height) * (bounds.width + 3 * bounds.height)));
  const count = Math.max(36, Math.ceil(circumference / 5));
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const angle = (Math.PI * 2 * index) / count;
    points.push(point(
      bounds.x + bounds.width / 2 + Math.cos(angle) * bounds.width / 2,
      bounds.y + bounds.height / 2 + Math.sin(angle) * bounds.height / 2,
    ));
  }
  return points;
};

const transformPath = (points, center, angle) => points.map((value) => rotate(value, center, angle));

const noisyClosedPath = (random, basePath, bounds, options = {}) => {
  const center = point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const angle = options.angle ?? between(random, -Math.PI / 36, Math.PI / 36);
  const rotated = transformPath(basePath, center, angle);
  const shift = integer(random, 0, Math.max(0, rotated.length - 2));
  const direction = random() < 0.5 ? 1 : -1;
  const ordered = [];
  for (let index = 0; index < rotated.length - 1; index += 1) {
    const sourceIndex = (shift + direction * index + rotated.length - 1) % (rotated.length - 1);
    ordered.push(rotated[sourceIndex]);
  }
  const points = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const first = ordered[index];
    const second = ordered[(index + 1) % ordered.length];
    const segment = sampleSegment(random, first, second, {
      step: between(random, 3, 7),
      wobble: options.wobble ?? between(random, 1, 3),
      jitter: 0.9,
    });
    if (index > 0) {
      segment.shift();
    }
    points.push(...segment);
  }
  const first = points[0];
  const lastIndex = points.length - 1;
  const closing = points[lastIndex];
  const gap = between(random, 0, options.maxGap ?? 16);
  const gapDirection = normalize(subtract(closing, first));
  if (first && closing && gap > 0) {
    points[lastIndex] = add(first, scale(gapDirection, gap));
  }
  if (points.length > 4 && random() < 0.45) {
    const before = points[points.length - 2] ?? points[0];
    const overshootDirection = normalize(subtract(closing ?? first, before ?? first));
    points.push(add(closing ?? first, scale(overshootDirection, between(random, 3, 18))));
  }
  return points;
};

const multiStrokeShape = (random, kind, bounds, count) => {
  const base = kind === 'diamond' ? diamondPath(bounds) : rectanglePath(bounds);
  const angle = between(random, -Math.PI / 36, Math.PI / 36);
  const center = point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const rotated = transformPath(base, center, angle);
  const strokes = [];
  const order = Array.from({ length: count }, (_unused, index) => index)
    .sort(() => random() - 0.5);
  for (const chunk of order) {
    const startRatio = chunk / count;
    const endRatio = (chunk + 1) / count;
    let fragment = makePathFragment(random, rotated, startRatio, endRatio);
    if (random() < 0.5) {
      fragment = fragment.reverse();
    }
    const start = fragment[0];
    const end = fragment[fragment.length - 1];
    if (start && end) {
      const startGap = between(random, 0, 14);
      const endGap = between(random, 0, 14);
      const startDirection = normalize(subtract(end, start));
      const endDirection = normalize(subtract(start, end));
      fragment[0] = add(start, scale(startDirection, startGap));
      fragment[fragment.length - 1] = add(end, scale(endDirection, endGap));
    }
    const dense = [];
    for (let index = 1; index < fragment.length; index += 1) {
      const segment = sampleSegment(random, fragment[index - 1], fragment[index], {
        step: between(random, 3, 7),
        wobble: between(random, 0.5, 1.8),
        jitter: 0.8,
      });
      if (index > 1) {
        segment.shift();
      }
      dense.push(...segment);
    }
    strokes.push(dense);
  }
  return strokes;
};

const shapePath = (random, kind, bounds) => {
  if (kind === 'ellipse') {
    return noisyClosedPath(random, ellipsePath(bounds), bounds, { maxGap: 14 });
  }
  if (kind === 'diamond') {
    return noisyClosedPath(random, diamondPath(bounds), bounds, { maxGap: 16 });
  }
  if (kind === 'roundedRectangle') {
    return noisyClosedPath(random, roundedRectanglePath(bounds), bounds, { maxGap: 16 });
  }
  return noisyClosedPath(random, rectanglePath(bounds), bounds, { maxGap: 18 });
};

const outlinePoint = (bounds, side) => {
  const center = point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  if (side === 'top') return point(center.x, bounds.y);
  if (side === 'bottom') return point(center.x, bounds.y + bounds.height);
  if (side === 'left') return point(bounds.x, center.y);
  return point(bounds.x + bounds.width, center.y);
};

const addEndpointError = (random, outline, direction) => {
  const mode = random();
  if (mode < 0.35) {
    return add(outline, scale(direction, between(random, -14, -2)));
  }
  if (mode < 0.7) {
    return add(outline, scale(direction, between(random, 1, 10)));
  }
  return add(outline, scale(direction, between(random, -2, 3)));
};

const sampleQuadratic = (random, first, control, last) => {
  const count = Math.max(8, Math.ceil((distance(first, control) + distance(control, last)) / 7));
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const firstWeight = (1 - t) ** 2;
    const middleWeight = 2 * (1 - t) * t;
    const lastWeight = t ** 2;
    points.push(point(
      first.x * firstWeight + control.x * middleWeight + last.x * lastWeight,
      first.y * firstWeight + control.y * middleWeight + last.y * lastWeight,
    ));
  }
  return points.map((value, index) => {
    if (index === 0 || index === points.length - 1) return value;
    return jitterPoint(random, value, 0.9);
  });
};

const connectorPath = (random, first, last, mode) => {
  if (mode === 'elbow') {
    const midpoint = point(
      between(random, first.x + 24, last.x - 24),
      between(random, Math.min(first.y, last.y) - 36, Math.max(first.y, last.y) + 36),
    );
    return [
      ...sampleSegment(random, first, point(midpoint.x, first.y), { step: between(random, 3, 7), wobble: 1.2, jitter: 0.8 }),
      ...sampleSegment(random, point(midpoint.x, first.y), point(midpoint.x, last.y), { step: between(random, 3, 7), wobble: 1.2, jitter: 0.8 }).slice(1),
      ...sampleSegment(random, point(midpoint.x, last.y), last, { step: between(random, 3, 7), wobble: 1.2, jitter: 0.8 }).slice(1),
    ];
  }
  if (mode === 'curve') {
    const direction = normalize(subtract(last, first));
    const normal = perpendicular(direction);
    const control = add(
      point((first.x + last.x) / 2, (first.y + last.y) / 2),
      scale(normal, between(random, -64, 64)),
    );
    return sampleQuadratic(random, first, control, last);
  }
  return sampleSegment(random, first, last, { step: between(random, 3, 7), wobble: between(random, 1, 3), jitter: 0.9 });
};

const addInlineHead = (random, shaft, atStart, style) => {
  if (shaft.length < 2) {
    return shaft;
  }
  const tip = atStart ? shaft[0] : shaft[shaft.length - 1];
  const adjacent = atStart ? shaft[1] : shaft[shaft.length - 2];
  const direction = normalize(subtract(tip, adjacent));
  const normal = perpendicular(direction);
  const base = add(tip, scale(direction, -22));
  const barbLength = style === 'hook' ? 16 : 12;
  const barb = add(tip, scale(direction, -barbLength));
  const upper = add(barb, scale(normal, -10));
  const lower = add(barb, scale(normal, 10));
  const head = style === 'hook'
    ? [base, upper, tip]
    : [base, upper, tip, lower, tip];
  if (atStart) {
    return [...head.reverse(), ...shaft.slice(1)];
  }
  return [...shaft.slice(0, -1), ...head];
};

const separateArrowhead = (random, tip, shaftDirection, style) => {
  const direction = normalize(shaftDirection);
  const normal = perpendicular(direction);
  const offsetTip = add(tip, scale(direction, between(random, -6, 6)));
  if (style === 'v') {
    const length = between(random, 10, 24);
    const halfAngle = between(random, 24, 52) * (Math.PI / 180);
    const base = add(offsetTip, scale(direction, -length));
    const first = add(base, scale(normal, -length * Math.tan(halfAngle)));
    const second = add(base, scale(normal, length * Math.tan(halfAngle)));
    const points = random() < 0.5
      ? [offsetTip, first, second]
      : [second, first, offsetTip];
    return points;
  }
  return [0, 1].map((index) => {
    const length = between(random, 9 + index * 3, 22 + index * 4);
    const halfAngle = between(random, 22, 55) * (Math.PI / 180);
    const base = add(offsetTip, scale(direction, -length));
    const endpoint = add(
      base,
      scale(normal, (index === 0 ? -1 : 1) * length * Math.tan(halfAngle)),
    );
    return random() < 0.5
      ? [offsetTip, endpoint]
      : [endpoint, offsetTip];
  });
};

const typeToExpected = (kind) => kind === 'multiRectangle' || kind === 'rectangle'
  ? 'rectangle'
  : kind === 'multiDiamond'
    ? 'diamond'
    : kind;

const freedrawElement = (id, points, index) => {
  const first = points[0] ?? point(0, 0);
  const xs = points.map((value) => value.x);
  const ys = points.map((value) => value.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    id,
    type: 'freedraw',
    x: round(minX),
    y: round(minY),
    width: round(Math.max(...xs) - minX),
    height: round(Math.max(...ys) - minY),
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `d${index.toString(16).padStart(4, '0')}`,
    roundness: null,
    seed: 5000 + index,
    version: 1,
    versionNonce: 7000 + index,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    customData: null,
    points: points.map((value) => [round(value.x - minX), round(value.y - minY)]),
    pressures: points.map(() => 0.5),
    simulatePressure: true,
    lastCommittedPoint: null,
  };
};

const textElement = (id, text, bounds, random, index, outside = false) => {
  const width = Math.max(36, text.length * 9);
  const height = 20;
  const x = outside
    ? bounds.x + between(random, 12, Math.max(12, bounds.width - width - 12))
    : bounds.x + (bounds.width - width) / 2 + between(random, -5, 5);
  const y = outside
    ? bounds.y + between(random, 7, 18)
    : bounds.y + (bounds.height - height) / 2 + between(random, -5, 5);
  return {
    id,
    type: 'text',
    x: round(x),
    y: round(y),
    width: round(width),
    height,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `t${index.toString(16).padStart(4, '0')}`,
    roundness: null,
    seed: 8000 + index,
    version: 1,
    versionNonce: 9000 + index,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    customData: null,
    text,
    originalText: text,
    fontSize: 18,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  };
};

const scene = (elements) => ({
  type: 'excalidraw',
  version: 2,
  source: 'drawit-phase1-diagram-fixture-generator',
  elements,
  appState: {
    gridSize: null,
    gridStep: 5,
    viewBackgroundColor: '#ffffff',
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    selectedElementIds: {},
  },
  files: {},
});

const addShape = (random, elements, nodes, split, fixtureIndex, nodeIndex, kind, bounds, state) => {
  const sourceIds = [];
  const addStroke = (points) => {
    const id = `${split}-${fixtureIndex}-node-${nodeIndex}-stroke-${sourceIds.length + 1}`;
    sourceIds.push(id);
    elements.push(freedrawElement(id, points, state.elementIndex++));
  };
  if (kind === 'multiRectangle' || kind === 'multiDiamond') {
    const count = kind === 'multiRectangle'
      ? state.rectangleStrokeCount
      : state.diamondStrokeCount;
    multiStrokeShape(random, typeToExpected(kind), bounds, count).forEach(addStroke);
  } else {
    addStroke(shapePath(random, kind, bounds));
  }
  const label = nodeIndex === 0
    ? 'Start'
    : nodeIndex === state.nodeCount - 1
      ? 'End'
      : kind === 'diamond'
        ? 'Ready?'
        : `Step ${nodeIndex}`;
  const textId = `${split}-${fixtureIndex}-node-${nodeIndex}-label`;
  elements.push(textElement(textId, label, bounds, random, state.elementIndex++));
  nodes.push({
    id: `${split}-${fixtureIndex}-node-${nodeIndex}`,
    kind: typeToExpected(kind),
    sourceIds,
    label,
    bounds,
    textId,
  });
};

const addConnector = (random, elements, edges, split, fixtureIndex, edgeIndex, from, to, state, options = {}) => {
  const reversePath = Boolean(options.reversePath);
  const pathFrom = reversePath ? to : from;
  const pathTo = reversePath ? from : to;
  const fromSide = options.fromSide ?? (pathTo.bounds.x >= pathFrom.bounds.x ? 'right' : 'bottom');
  const toSide = options.toSide ?? (pathTo.bounds.x >= pathFrom.bounds.x ? 'left' : 'top');
  const fromOutline = outlinePoint(pathFrom.bounds, fromSide);
  const toOutline = outlinePoint(pathTo.bounds, toSide);
  const startDirection = normalize(subtract(toOutline, fromOutline));
  const endDirection = scale(startDirection, -1);
  const start = addEndpointError(random, fromOutline, startDirection);
  const end = addEndpointError(random, toOutline, endDirection);
  let shaft = connectorPath(random, start, end, options.mode ?? choose(random, ['straight', 'elbow', 'curve']));
  const labelPoint = pointAtPath(shaft, 0.5);
  const arrowAtStart = options.arrowAtStart ?? false;
  const arrowAtEnd = options.arrowAtEnd ?? true;
  const style = options.style ?? choose(random, ['hook', 'v']);
  const sourceIds = [];
  const connectorId = `${split}-${fixtureIndex}-edge-${edgeIndex}`;
  if (options.inline) {
    shaft = addInlineHead(random, shaft, arrowAtStart, style);
    elements.push(freedrawElement(connectorId, shaft, state.elementIndex++));
    sourceIds.push(connectorId);
  } else {
    elements.push(freedrawElement(connectorId, shaft, state.elementIndex++));
    sourceIds.push(connectorId);
    const tips = [];
    if (arrowAtStart) {
      const adjacent = shaft[1] ?? shaft[0] ?? start;
      tips.push({
        endpoint: 'start',
        tip: start,
        direction: normalize(subtract(start, adjacent)),
      });
    }
    if (arrowAtEnd) {
      const adjacent = shaft[shaft.length - 2] ?? shaft[shaft.length - 1] ?? end;
      tips.push({
        endpoint: 'end',
        tip: end,
        direction: normalize(subtract(end, adjacent)),
      });
    }
    for (const tip of tips) {
      const head = separateArrowhead(random, tip.tip, tip.direction, style === 'hook' ? 'v' : style);
      const strokes = Array.isArray(head[0]) ? head : [head];
      strokes.forEach((points, headIndex) => {
        const id = `${connectorId}-arrowhead-${tip.endpoint}-${headIndex + 1}`;
        elements.push(freedrawElement(id, points, state.elementIndex++));
        sourceIds.push(id);
      });
    }
  }
  const label = options.label ?? (edgeIndex % 3 === 1 ? 'no' : 'yes');
  const labelBounds = {
    x: labelPoint.x - 22 + between(random, -8, 8),
    y: labelPoint.y - 12 + between(random, -8, 8),
    width: 44,
    height: 20,
  };
  const labelId = `${connectorId}-label`;
  elements.push(textElement(labelId, label, labelBounds, random, state.elementIndex++));
  state.connectorLabels.push({
    textId: labelId,
    shaft,
  });
  edges.push({
    from: pathFrom.id,
    to: pathTo.id,
    direction: arrowAtStart && arrowAtEnd ? 'both' : arrowAtStart ? 'backward' : arrowAtEnd ? 'forward' : 'none',
    label,
    sourceIds,
  });
};

const pointDistanceToPolyline = (value, points) => {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1];
    const second = points[index];
    const direction = subtract(second, first);
    const lengthSquared = direction.x ** 2 + direction.y ** 2;
    const ratio = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, (
        (value.x - first.x) * direction.x + (value.y - first.y) * direction.y
      ) / lengthSquared));
    const projection = add(first, scale(direction, ratio));
    minimum = Math.min(minimum, distance(value, projection));
  }
  return minimum;
};

const connectorLabelPoint = (shaft, ratio) => {
  const center = pointAtPath(shaft, ratio);
  const before = pointAtPath(shaft, Math.max(0, ratio - 0.02));
  const after = pointAtPath(shaft, Math.min(1, ratio + 0.02));
  const tangent = normalize(subtract(after, before));
  return { center, normal: perpendicular(tangent) };
};

const placeConnectorLabels = (random, elements, nodes, labels) => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  for (const record of labels) {
    const element = byId.get(record.textId);
    if (!element) {
      continue;
    }
    const candidates = [];
    for (const ratio of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const { center, normal } = connectorLabelPoint(record.shaft, ratio);
      for (const offset of [0, -18, 18, -28, 28]) {
        const candidate = add(center, scale(normal, offset));
        if (nodes.some((node) => (
          candidate.x >= node.bounds.x
          && candidate.x <= node.bounds.x + node.bounds.width
          && candidate.y >= node.bounds.y
          && candidate.y <= node.bounds.y + node.bounds.height
        ))) {
          continue;
        }
        const ownDistance = pointDistanceToPolyline(candidate, record.shaft);
        if (ownDistance > 24) {
          continue;
        }
        const otherDistance = Math.min(
          ...labels
            .filter((other) => other !== record)
            .map((other) => pointDistanceToPolyline(candidate, other.shaft)),
          Number.POSITIVE_INFINITY,
        );
        candidates.push({
          candidate,
          score: otherDistance - ownDistance * 0.35,
        });
      }
    }
    candidates.sort((first, second) => second.score - first.score);
    const selected = candidates[0]?.candidate;
    if (!selected) {
      continue;
    }
    const jittered = jitterPoint(random, selected, 4);
    const safe = nodes.some((node) => (
      jittered.x >= node.bounds.x
      && jittered.x <= node.bounds.x + node.bounds.width
      && jittered.y >= node.bounds.y
      && jittered.y <= node.bounds.y + node.bounds.height
    ))
      ? selected
      : jittered;
    element.x = round(safe.x - element.width / 2);
    element.y = round(safe.y - element.height / 2);
  }
};

const addContainer = (random, elements, nodes, split, fixtureIndex, state, bounds, children) => {
  const sourceId = `${split}-${fixtureIndex}-container-stroke`;
  elements.push(freedrawElement(sourceId, shapePath(random, 'rectangle', bounds), state.elementIndex++));
  const labelBounds = { ...bounds, width: 100, height: 20 };
  const labelId = `${split}-${fixtureIndex}-container-label`;
  elements.push(textElement(labelId, 'Main lane', labelBounds, random, state.elementIndex++, true));
  nodes.push({
    id: `${split}-${fixtureIndex}-container`,
    kind: 'rectangle',
    sourceIds: [sourceId],
    label: 'Main lane',
    bounds,
    textId: labelId,
    children: children.map((child) => child.id),
  });
};

const chooseContainerChildren = (nodes) => {
  const candidates = [];
  for (let first = 0; first < nodes.length; first += 1) {
    for (let second = first + 1; second < nodes.length; second += 1) {
      const children = [nodes[first], nodes[second]];
      const minX = Math.min(...children.map((node) => node.bounds.x));
      const minY = Math.min(...children.map((node) => node.bounds.y));
      const maxX = Math.max(...children.map((node) => node.bounds.x + node.bounds.width));
      const maxY = Math.max(...children.map((node) => node.bounds.y + node.bounds.height));
      const bounds = {
        x: minX - 24,
        y: minY - 30,
        width: maxX - minX + 48,
        height: maxY - minY + 60,
      };
      const containsOther = nodes.some((node, index) => {
        return index !== first
          && index !== second
          && node.bounds.x >= bounds.x
          && node.bounds.y >= bounds.y
          && node.bounds.x + node.bounds.width <= bounds.x + bounds.width
          && node.bounds.y + node.bounds.height <= bounds.y + bounds.height;
      });
      candidates.push({ children, bounds, containsOther });
      if (!containsOther) {
        return { children, bounds };
      }
    }
  }
  const fallback = candidates[0];
  return fallback
    ? { children: fallback.children, bounds: fallback.bounds }
    : { children: nodes.slice(0, 2), bounds: { x: 0, y: 0, width: 1, height: 1 } };
};

const devLayout = (random, fixtureIndex, count) => {
  const layout = fixtureIndex % 3;
  const nodes = [];
  if (layout === 0) {
    for (let index = 0; index < count; index += 1) {
      nodes.push({ x: 90 + index * 205, y: 180 + (index % 2) * 42, width: 128, height: 76 });
    }
  } else if (layout === 1) {
    for (let index = 0; index < count; index += 1) {
      nodes.push({ x: 220 + (index % 3) * 220, y: 90 + Math.floor(index / 3) * 170, width: 132, height: 78 });
    }
  } else {
    for (let index = 0; index < count; index += 1) {
      nodes.push({ x: 120 + (index % 2) * 260, y: 100 + index * 125, width: 132, height: 78 });
    }
  }
  return nodes.map((bounds) => ({
    ...bounds,
    x: bounds.x + between(random, -8, 8),
    y: bounds.y + between(random, -8, 8),
  }));
};

const holdoutLayout = (random, fixtureIndex, count) => {
  const layout = fixtureIndex % 3;
  const nodes = [];
  if (layout === 0) {
    for (let index = 0; index < count; index += 1) {
      nodes.push({ x: 110 + (index % 2) * 300, y: 85 + Math.floor(index / 2) * 145, width: 124, height: 80 });
    }
  } else if (layout === 1) {
    for (let index = 0; index < count; index += 1) {
      nodes.push({ x: 80 + index * 185, y: 120 + ((index * 3) % 4) * 55, width: 130, height: 74 });
    }
  } else {
    for (let index = 0; index < count; index += 1) {
      nodes.push({ x: 140 + (index % 3) * 235, y: 105 + Math.floor(index / 3) * 185, width: 126, height: 82 });
    }
  }
  return nodes.map((bounds) => ({
    ...bounds,
    x: bounds.x + between(random, -10, 10),
    y: bounds.y + between(random, -10, 10),
  }));
};

const makePositiveFixture = (seed, fixtureIndex, split) => {
  const random = randomFor(seed);
  const count = 5 + (fixtureIndex % 5);
  const state = {
    elementIndex: 1,
    nodeCount: count,
    rectangleStrokeCount: 2 + (fixtureIndex % 3),
    diamondStrokeCount: 2 + ((fixtureIndex + 1) % 3),
    connectorLabels: [],
  };
  const boundsList = split === 'dev'
    ? devLayout(random, fixtureIndex, count)
    : holdoutLayout(random, fixtureIndex, count);
  const elements = [];
  const nodes = [];
  const kinds = ['ellipse', 'rectangle', 'diamond', 'roundedRectangle', 'multiRectangle', 'multiDiamond'];
  for (let index = 0; index < count; index += 1) {
    const kind = kinds[(fixtureIndex + index * 2 + (split === 'holdout' ? 1 : 0)) % kinds.length];
    addShape(random, elements, nodes, split, fixtureIndex, index, kind, boundsList[index], state);
  }
  const edges = [];
  for (let index = 0; index < count - 1; index += 1) {
    const style = index % 4;
    addConnector(random, elements, edges, split, fixtureIndex, edges.length, nodes[index], nodes[index + 1], state, {
      arrowAtStart: style === 3,
      arrowAtEnd: style !== 3,
      inline: style === 0 || style === 1,
      style: style === 1 ? 'hook' : style === 2 ? 'v' : 'barb',
      mode: index % 3 === 0 ? 'straight' : index % 3 === 1 ? 'elbow' : 'curve',
      label: index === 0 ? 'yes' : index === 1 ? 'no' : `step ${index}`,
      reversePath: !((style === 0 || style === 1)) && random() < 0.5,
    });
  }
  if (count >= 5) {
    addConnector(random, elements, edges, split, fixtureIndex, edges.length, nodes[2], nodes[4], state, {
      arrowAtStart: false,
      arrowAtEnd: true,
      inline: false,
      style: 'v',
      mode: 'curve',
      label: 'no',
      fromSide: 'bottom',
      toSide: 'top',
      reversePath: random() < 0.5,
    });
    addConnector(random, elements, edges, split, fixtureIndex, edges.length, nodes[count - 1], nodes[1], state, {
      arrowAtStart: true,
      arrowAtEnd: false,
      inline: false,
      style: 'v',
      mode: 'elbow',
      label: 'back',
      fromSide: 'left',
      toSide: 'left',
      reversePath: random() < 0.5,
    });
  }
  if (fixtureIndex % 4 === 0) {
    const selected = chooseContainerChildren(nodes);
    addContainer(random, elements, nodes, split, fixtureIndex, state, selected.bounds, selected.children);
  }
  placeConnectorLabels(random, elements, nodes, state.connectorLabels);
  elements.sort(() => random() - 0.5);
  return {
    document: scene(elements),
    expected: {
      split,
      seed,
      nodes: nodes.map(({ id, kind, sourceIds, label }) => ({ id, kind, sourceIds, label })),
      edges: edges.map(({ from, to, direction, label }) => ({ from, to, direction, label })),
      containers: nodes
        .filter((node) => node.children)
        .map((node) => ({
          sourceIds: node.sourceIds,
          children: node.children.map((childId) => nodes.find((child) => child.id === childId)?.sourceIds ?? []),
          title: node.label,
        })),
    },
  };
};

const negativeStrokes = (random, index, split) => {
  const strokes = [];
  if (index % 5 === 0) {
    for (let loop = 0; loop < 2; loop += 1) {
      const points = [];
      for (let step = 0; step <= 90; step += 1) {
        const t = (Math.PI * 4 * step) / 90;
        const radius = 24 + 11 * Math.sin(t * 1.5 + loop);
        points.push(point(
          210 + loop * 70 + Math.cos(t) * radius,
          180 + Math.sin(t) * (18 + 8 * Math.cos(t * 0.5)),
        ));
      }
      strokes.push(points);
    }
  } else if (index % 5 === 1) {
    for (let line = 0; line < 10; line += 1) {
      strokes.push([
        point(100 + line * 13, 100),
        point(200 + line * 13, 145 + (line % 2) * 8),
      ]);
    }
  } else if (index % 5 === 2) {
    const points = [];
    for (let step = 0; step <= 70; step += 1) {
      const t = step / 8;
      points.push(point(250 + Math.cos(t) * t * 5, 240 + Math.sin(t) * t * 5));
    }
    strokes.push(points);
  } else if (index % 5 === 3) {
    for (let stroke = 0; stroke < 4; stroke += 1) {
      const points = [];
      for (let step = 0; step <= 30; step += 1) {
        points.push(point(
          140 + step * 6 + Math.sin(step * 1.7 + stroke) * 22,
          220 + stroke * 18 + Math.cos(step * 1.3 + stroke) * 24,
        ));
      }
      strokes.push(points);
    }
  } else {
    const words = ['yes', 'note', 'draw'];
    for (let letter = 0; letter < 3; letter += 1) {
      const points = [];
      for (let step = 0; step <= 12; step += 1) {
        points.push(point(
          130 + letter * 75 + step * 4,
          120 + Math.sin(step * 0.8 + letter) * 12 + between(random, -1, 1),
        ));
      }
      strokes.push(points);
    }
    void words;
  }
  return strokes.map((points, strokeIndex) => ({
    id: `${split}-${index}-negative-${strokeIndex + 1}`,
    points,
  }));
};

const makeNegativeFixture = (seed, index, split) => {
  const random = randomFor(seed);
  const elements = negativeStrokes(random, index, split)
    .map((stroke, strokeIndex) => freedrawElement(stroke.id, stroke.points, strokeIndex + 1));
  return {
    document: scene(elements),
    expected: {
      split,
      seed,
      negative: true,
      nodes: [],
      edges: [],
      containers: [],
    },
  };
};

const writeFixture = (split, name, result) => {
  const directory = join(fixtureRoot, split);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.excalidraw`), `${JSON.stringify(result.document, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, `${name}.expected.json`), `${JSON.stringify(result.expected, null, 2)}\n`, 'utf8');
};

rmSync(join(fixtureRoot, 'dev'), { recursive: true, force: true });
rmSync(join(fixtureRoot, 'holdout'), { recursive: true, force: true });
mkdirSync(fixtureRoot, { recursive: true });
writeFileSync(join(fixtureRoot, 'README.md'), fixtureReadme, 'utf8');
const manifest = [];
for (const [split, count, offset] of [['dev', 24, 1100], ['holdout', 20, 9100]]) {
  for (let index = 0; index < count; index += 1) {
    const seed = offset + index;
    const result = index < 5
      ? makeNegativeFixture(seed, index, split)
      : makePositiveFixture(seed, index - 5, split);
    const name = `${split}-${String(index + 1).padStart(2, '0')}`;
    writeFixture(split, name, result);
    manifest.push({ split, name, seed, negative: Boolean(result.expected.negative) });
  }
}
writeFileSync(join(fixtureRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Generated ${manifest.length} diagram fixtures.`);
