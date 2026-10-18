import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const fixtureDirectory = join(root, 'tests', 'fixtures');
mkdirSync(fixtureDirectory, { recursive: true });

const round = (value) => Number(value.toFixed(4));

const boundsForPoints = (points) => {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

const freedrawElement = (id, points, index) => {
  const first = points[0];
  const localPoints = points.map(([x, y]) => [round(x - first[0]), round(y - first[1])]);
  const bounds = boundsForPoints(points);

  return {
    id,
    type: 'freedraw',
    x: round(first[0]),
    y: round(first[1]),
    width: round(bounds.width),
    height: round(bounds.height),
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
    index: `a${index.toString(16).padStart(3, '0')}`,
    roundness: null,
    seed: 1000 + index,
    version: 1,
    versionNonce: 2000 + index,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    customData: null,
    points: localPoints,
    pressures: localPoints.map(() => 0.5),
    simulatePressure: true,
    lastCommittedPoint: null,
  };
};

const scene = (name, pointSets) => {
  const elements = pointSets.map((points, index) => {
    return freedrawElement(`${name}-${index + 1}`, points, index + 1);
  });

  return {
    type: 'excalidraw',
    version: 2,
    source: 'drawit-fixture-generator',
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
  };
};

const circlePoints = Array.from({ length: 17 }, (_, index) => {
  const angle = (Math.PI * 2 * index) / 16;
  const radius = 48 + ((index % 3) - 1) * 2;
  return [
    180 + Math.cos(angle) * radius,
    120 + Math.sin(angle) * radius,
  ];
});

const fixtures = {
  'wobbly-line.excalidraw': scene('wobbly-line', [[
    [40, 60],
    [55, 58],
    [70, 63],
    [85, 57],
    [100, 62],
    [115, 59],
    [130, 61],
  ]]),
  'curve.excalidraw': scene('curve', [[
    [40, 180],
    [55, 168],
    [70, 155],
    [85, 146],
    [100, 141],
    [115, 142],
    [130, 148],
    [145, 159],
    [160, 175],
  ]]),
  'rough-circle.excalidraw': scene('rough-circle', [circlePoints]),
  'four-stroke-box.excalidraw': scene('four-stroke-box', [
    [[60, 60], [110, 59], [160, 62], [210, 60]],
    [[62, 140], [112, 141], [160, 138], [208, 140]],
    [[60, 60], [59, 100], [62, 140]],
    [[210, 60], [211, 100], [208, 140]],
  ]),
  'already-clean.excalidraw': scene('already-clean', [[
    [60, 220],
    [160, 220],
  ]]),
  'four-stroke-not-box.excalidraw': scene('four-stroke-not-box', [
    [[60, 60], [110, 57], [160, 60]],
    [[60, 90], [110, 87], [160, 90]],
    [[60, 120], [110, 124], [160, 120]],
    [[60, 150], [110, 147], [160, 150]],
  ]),
};

for (const [filename, document] of Object.entries(fixtures)) {
  writeFileSync(
    join(fixtureDirectory, filename),
    `${JSON.stringify(document, null, 2)}\n`.replaceAll('\r\n', '\n'),
    'utf8',
  );
}

console.log(`Generated ${Object.keys(fixtures).length} Excalidraw fixtures.`);
