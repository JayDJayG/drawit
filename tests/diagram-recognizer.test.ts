import { describe, expect, it } from 'vitest';
import { detectClosedShape, recognizeDiagram } from '../src/perception/t0';

const rectangle = (x: number, y: number, width: number, height: number) => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
  { x, y },
];

const diamond = (x: number, y: number, width: number, height: number) => [
  { x: x + width / 2, y },
  { x: x + width, y: y + height / 2 },
  { x: x + width / 2, y: y + height },
  { x, y: y + height / 2 },
  { x: x + width / 2, y },
];

const ellipse = (cx: number, cy: number, rx: number, ry: number, count = 32) => (
  Array.from({ length: count + 1 }, (_unused, index) => {
    const angle = (Math.PI * 2 * index) / count;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  })
);

const roundedRectangle = (x: number, y: number, width: number, height: number, radius = 16) => {
  const corners = [
    [{ x: x + radius, y: y + radius }, Math.PI, Math.PI * 1.5],
    [{ x: x + width - radius, y: y + radius }, -Math.PI / 2, 0],
    [{ x: x + width - radius, y: y + height - radius }, 0, Math.PI / 2],
    [{ x: x + radius, y: y + height - radius }, Math.PI / 2, Math.PI],
  ] as const;
  const points: { x: number; y: number }[] = [];
  for (const [center, start, end] of corners) {
    for (let index = 0; index <= 8; index += 1) {
      const angle = start + ((end - start) * index) / 8;
      points.push({
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      });
    }
  }
  return [...points, points[0]!];
};

const connector = (id: string, first: { x: number; y: number }, second: { x: number; y: number }) => ({
  id,
  points: [first, second],
});

const inlineArrow = (
  id: string,
  at: 'start' | 'end',
  style: 'hook' | 'v',
) => {
  const shaft = [
    { x: 20, y: 40 },
    { x: 30, y: 40 },
    { x: 40, y: 40 },
    { x: 50, y: 40 },
    { x: 60, y: 40 },
    { x: 70, y: 40 },
    { x: 80, y: 40 },
    { x: 90, y: 40 },
    { x: 100, y: 40 },
  ];
  const head = style === 'hook'
    ? [
        { x: 100, y: 40 },
        { x: 90, y: 30 },
      ]
    : [
        { x: 100, y: 40 },
        { x: 90, y: 30 },
        { x: 100, y: 40 },
        { x: 90, y: 50 },
      ];
  const points = at === 'end'
    ? [...shaft, ...head.slice(1)]
    : [...[...shaft, ...head.slice(1)].reverse()];
  return { id, points };
};

const denseSegment = (
  first: { x: number; y: number },
  second: { x: number; y: number },
  step: number,
  jitter = 0,
  seed = 1,
) => {
  const length = Math.hypot(second.x - first.x, second.y - first.y);
  const count = Math.max(1, Math.ceil(length / step));
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return Array.from({ length: count + 1 }, (_unused, index) => {
    const ratio = index / count;
    const envelope = index === 0 || index === count ? 0 : Math.sin(Math.PI * ratio);
    return {
      x: first.x + (second.x - first.x) * ratio
        + (random() * 2 - 1) * jitter * envelope,
      y: first.y + (second.y - first.y) * ratio
        + (random() * 2 - 1) * jitter * envelope,
    };
  });
};

const outlineRadius = (
  kind: 'rectangle' | 'ellipse' | 'diamond',
  width: number,
  height: number,
  direction: { x: number; y: number },
) => {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  if (kind === 'ellipse') {
    return 1 / Math.sqrt(
      (direction.x / halfWidth) ** 2 + (direction.y / halfHeight) ** 2,
    );
  }
  if (kind === 'diamond') {
    return 1 / (
      Math.abs(direction.x) / halfWidth
      + Math.abs(direction.y) / halfHeight
    );
  }
  return Math.min(
    Math.abs(direction.x) > 0 ? halfWidth / Math.abs(direction.x) : Number.POSITIVE_INFINITY,
    Math.abs(direction.y) > 0 ? halfHeight / Math.abs(direction.y) : Number.POSITIVE_INFINITY,
  );
};

const generatedInlineArrow = (
  targetKind: 'rectangle' | 'ellipse' | 'diamond',
  at: 'start' | 'end',
  style: 'hook' | 'v',
  angle: number,
  barbLength: number,
  halfAngle: number,
  step: number,
  jitter: number,
  offset: number,
  seed: number,
) => {
  const targetBounds = { x: 360, y: 200, width: 120, height: 80 };
  const targetCenter = {
    x: targetBounds.x + targetBounds.width / 2,
    y: targetBounds.y + targetBounds.height / 2,
  };
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -direction.y, y: direction.x };
  const radius = outlineRadius(
    targetKind,
    targetBounds.width,
    targetBounds.height,
    direction,
  );
  const tip = {
    x: targetCenter.x + direction.x * (radius + offset),
    y: targetCenter.y + direction.y * (radius + offset),
  };
  const sourceCenter = {
    x: targetCenter.x - direction.x * 360,
    y: targetCenter.y - direction.y * 360,
  };
  const sourceBounds = {
    x: sourceCenter.x - 60,
    y: sourceCenter.y - 40,
    width: 120,
    height: 80,
  };
  const sourceTipRadius = outlineRadius('rectangle', 120, 80, direction);
  const sourceTip = {
    x: sourceCenter.x + direction.x * sourceTipRadius,
    y: sourceCenter.y + direction.y * sourceTipRadius,
  };
  const shaft = denseSegment(sourceTip, tip, step, jitter, seed);
  const barbBase = {
    x: tip.x - direction.x * barbLength,
    y: tip.y - direction.y * barbLength,
  };
  const barbOne = {
    x: barbBase.x + normal.x * barbLength * Math.tan((halfAngle * Math.PI) / 180),
    y: barbBase.y + normal.y * barbLength * Math.tan((halfAngle * Math.PI) / 180),
  };
  const barbTwo = {
    x: barbBase.x - normal.x * barbLength * Math.tan((halfAngle * Math.PI) / 180),
    y: barbBase.y - normal.y * barbLength * Math.tan((halfAngle * Math.PI) / 180),
  };
  const head = style === 'hook'
    ? [
        ...denseSegment(tip, barbOne, step, jitter, seed + 11).slice(1),
      ]
    : [
        ...denseSegment(tip, barbOne, step, jitter, seed + 11).slice(1),
        ...denseSegment(barbOne, tip, step, jitter, seed + 17).slice(1),
        ...denseSegment(tip, barbTwo, step, jitter, seed + 23).slice(1),
      ];
  const points = at === 'end'
    ? [...shaft, ...head]
    : [...[...shaft, ...head].reverse()];
  const shapePoints = targetKind === 'rectangle'
    ? rectangle(targetBounds.x, targetBounds.y, targetBounds.width, targetBounds.height)
    : targetKind === 'diamond'
      ? diamond(targetBounds.x, targetBounds.y, targetBounds.width, targetBounds.height)
      : ellipse(
        targetCenter.x,
        targetCenter.y,
        targetBounds.width / 2,
        targetBounds.height / 2,
      );
  return {
    strokes: [
      { id: 'source-node', points: rectangle(sourceBounds.x, sourceBounds.y, sourceBounds.width, sourceBounds.height) },
      { id: 'target-node', points: shapePoints },
      { id: `generated-arrow-${seed}`, points },
    ],
    tip,
    targetBounds,
    sourceBounds,
  };
};

describe('diagram recognizer', () => {
  it('recognizes shapes, labels, and a bound connector', () => {
    const plan = recognizeDiagram({
      strokes: [
        { id: 'start', points: [{ x: 20, y: 30 }, ...rectangle(20, 30, 120, 60)] },
        { id: 'decision', points: diamond(220, 30, 120, 80) },
        { id: 'edge', points: [{ x: 140, y: 60 }, { x: 220, y: 70 }] },
      ],
      texts: [
        { id: 'start-label', text: 'Start', x: 55, y: 50, width: 50, height: 20 },
        { id: 'decision-label', text: 'Ready?', x: 250, y: 60, width: 60, height: 20 },
      ],
    });

    expect(plan.items.filter((item) => item.kind === 'shape')).toHaveLength(2);
    expect(plan.items.find((item) => item.id.startsWith('shape-start'))).toMatchObject({
      kind: 'shape',
      label: 'Start',
    });
    expect(plan.items.some((item) => item.kind === 'connector')).toBe(true);
  });

  it('recognizes a four-stroke box in arbitrary order', () => {
    const sides = rectangle(100, 100, 180, 100);
    const plan = recognizeDiagram({
      strokes: [
        { id: 'right', points: [sides[1], sides[2]] },
        { id: 'top', points: [sides[0], sides[1]] },
        { id: 'left', points: [sides[3], sides[0]] },
        { id: 'bottom', points: [sides[2], sides[3]] },
      ],
      texts: [],
    });
    expect(plan.items.filter((item) => item.kind === 'shape')).toHaveLength(1);
    expect(plan.items[0]?.sourceIds).toEqual(['right', 'top', 'left', 'bottom']);
  });

  it('projects an ellipse endpoint onto the ellipse outline', () => {
    const target = { x: 282.426, y: 148.284 };
    const plan = recognizeDiagram({
      strokes: [
        { id: 'ellipse-node', points: ellipse(240, 120, 60, 40) },
        connector('ellipse-edge', target, { x: 330, y: 185 }),
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    expect(edge).toMatchObject({ start: { itemId: expect.stringContaining('ellipse-node') } });
    if (edge?.kind !== 'connector' || !edge.start) {
      throw new Error('expected an ellipse-bound connector');
    }
    const endpoint = edge.points[0];
    expect(endpoint?.[0]).toBeCloseTo(target.x, 1);
    expect(endpoint?.[1]).toBeCloseTo(target.y, 1);
  });

  it('projects a diamond endpoint onto the diamond outline', () => {
    const target = { x: 457.5, y: 60 };
    const plan = recognizeDiagram({
      strokes: [
        { id: 'diamond-node', points: diamond(360, 40, 130, 80) },
        connector('diamond-edge', target, { x: 510, y: 35 }),
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    expect(edge).toMatchObject({ start: { itemId: expect.stringContaining('diamond-node') } });
    if (edge?.kind !== 'connector') {
      throw new Error('expected a diamond-bound connector');
    }
    const endpoint = edge.points[0];
    expect(endpoint?.[0]).toBeCloseTo(target.x, 1);
    expect(endpoint?.[1]).toBeCloseTo(target.y, 1);
  });

  it('keeps an endpoint already placed on a node outline', () => {
    const target = { x: 360, y: 80 };
    const plan = recognizeDiagram({
      strokes: [
        { id: 'outline-node', points: rectangle(240, 40, 120, 80) },
        connector('outline-edge', target, { x: 430, y: 80 }),
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    if (edge?.kind !== 'connector') {
      throw new Error('expected an outline-bound connector');
    }
    const endpoint = edge.points[0];
    expect(endpoint?.[0]).toBeCloseTo(target.x, 1);
    expect(endpoint?.[1]).toBeCloseTo(target.y, 1);
  });

  it('binds a near-outline arrow tip without moving the user-drawn tip', () => {
    const tip = { x: 95, y: 140 };
    const plan = recognizeDiagram({
      strokes: [
        { id: 'diamond-node', points: diamond(100, 100, 120, 80) },
        connector('near-tip-edge', { x: 240, y: 140 }, tip),
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    expect(edge).toMatchObject({ end: { itemId: expect.stringContaining('diamond-node') } });
    if (edge?.kind !== 'connector') {
      throw new Error('expected a diamond-bound connector');
    }
    expect(edge.points.at(-1)?.[0]).toBeCloseTo(tip.x, 1);
    expect(edge.points.at(-1)?.[1]).toBeCloseTo(tip.y, 1);
  });

  it('defaults sharp boxes to rectangles and requires clear arcs for rounded boxes', () => {
    expect(detectClosedShape(rectangle(0, 0, 120, 70))?.kind).toBe('rectangle');
    expect(detectClosedShape(roundedRectangle(0, 0, 120, 70))?.kind)
      .toBe('roundedRectangle');
  });

  it('removes an inline V barb from the shaft before binding its end', () => {
    const plan = recognizeDiagram({
      strokes: [
        { id: 'target', points: rectangle(100, 0, 120, 80) },
        {
          id: 'inline-v',
          points: [
            { x: 20, y: 40 },
            { x: 80, y: 40 },
            { x: 92, y: 30 },
            { x: 100, y: 40 },
            { x: 108, y: 30 },
            { x: 100, y: 40 },
          ],
        },
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    if (edge?.kind !== 'connector') {
      throw new Error('expected an inline-V connector');
    }
    expect(edge.end).toMatchObject({ itemId: expect.stringContaining('target') });
    const last = edge.points.at(-1)!;
    const previous = edge.points.at(-2)!;
    expect(last[0]).toBeCloseTo(100, 1);
    expect(last[1]).toBeCloseTo(40, 1);
    expect(Math.hypot(last[0] - previous[0], last[1] - previous[1])).toBeGreaterThan(1);
  });

  it.each([
    ['hook', 'end'],
    ['v', 'end'],
    ['hook', 'start'],
    ['v', 'start'],
  ] as const)('keeps an inline %s arrowhead at the %s tip', (style, end) => {
    const plan = recognizeDiagram({
      strokes: [
        { id: 'target', points: rectangle(100, 0, 120, 80) },
        inlineArrow('inline-arrow', end, style),
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    if (edge?.kind !== 'connector') {
      throw new Error('expected an inline arrow connector');
    }
    if (end === 'end') {
      expect(edge.endArrowhead).toBe('arrow');
      expect(edge.startArrowhead).toBeNull();
      expect(edge.end).toMatchObject({ itemId: expect.stringContaining('target') });
      expect(edge.points.at(-1)).toEqual([100, 40]);
    } else {
      expect(edge.startArrowhead).toBe('arrow');
      expect(edge.endArrowhead).toBeNull();
      expect(edge.start).toMatchObject({ itemId: expect.stringContaining('target') });
      expect(edge.points[0]).toEqual([100, 40]);
    }
  });

  it('recognizes generated inline heads across directions, spacing, targets, and tip offsets', () => {
    const cases: Array<{
      kind: 'rectangle' | 'ellipse' | 'diamond';
      at: 'start' | 'end';
      style: 'hook' | 'v';
      angle: number;
      barbLength: number;
      halfAngle: number;
      step: number;
      jitter: number;
      offset: number;
    }> = [];
    for (const kind of ['rectangle', 'ellipse', 'diamond'] as const) {
      for (const at of ['start', 'end'] as const) {
        for (const style of ['hook', 'v'] as const) {
          for (let direction = 0; direction < 8; direction += 1) {
            cases.push(
              { kind, at, style, angle: direction * Math.PI / 4, barbLength: 8, halfAngle: 20, step: 1, jitter: 0, offset: 8 },
              { kind, at, style, angle: direction * Math.PI / 4, barbLength: 25, halfAngle: 55, step: 4, jitter: 1, offset: -4 },
            );
          }
        }
      }
    }

    for (const [index, testCase] of cases.entries()) {
      const generated = generatedInlineArrow(
        testCase.kind,
        testCase.at,
        testCase.style,
        testCase.angle,
        testCase.barbLength,
        testCase.halfAngle,
        testCase.step,
        testCase.jitter,
        testCase.offset,
        index + 100,
      );
      const plan = recognizeDiagram({
        strokes: generated.strokes,
        texts: [],
      });
      const edge = plan.items.find((item) => item.kind === 'connector');
      expect(edge, `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`).toBeDefined();
      if (edge?.kind !== 'connector') {
        continue;
      }
      const arrowTargetRef = testCase.at === 'end' ? edge.end : edge.start;
      const arrowheadKind = testCase.kind;
      const arrowheadBounds = generated.targetBounds;
      expect(arrowTargetRef, `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`)
        .toMatchObject({
          itemId: expect.stringContaining('target-node'),
        });
      expect(
        testCase.at === 'end' ? edge.endArrowhead : edge.startArrowhead,
        `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`,
      ).toBe('arrow');
      const endpoint = testCase.at === 'end' ? edge.points.at(-1) : edge.points[0];
      const adjacent = testCase.at === 'end' ? edge.points.at(-2) : edge.points[1];
      expect(endpoint).toBeDefined();
      expect(adjacent).toBeDefined();
      if (!endpoint || !adjacent) {
        continue;
      }
      expect(
        Math.hypot(endpoint[0] - adjacent[0], endpoint[1] - adjacent[1]),
        `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`,
      ).toBeGreaterThanOrEqual(10);
      const center = {
        x: arrowheadBounds.x + arrowheadBounds.width / 2,
        y: arrowheadBounds.y + arrowheadBounds.height / 2,
      };
      const dx = endpoint[0] - center.x;
      const dy = endpoint[1] - center.y;
      const radius = outlineRadius(
        arrowheadKind,
        arrowheadBounds.width,
        arrowheadBounds.height,
        { x: Math.cos(testCase.angle), y: Math.sin(testCase.angle) },
      );
      const expectedDistance = Math.hypot(dx, dy);
      expect(
        Math.abs(expectedDistance - radius),
        `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`,
      ).toBeLessThanOrEqual(testCase.offset > 0 ? testCase.offset + 1 : 6);
      if (arrowheadKind === 'ellipse') {
        expect(
          (dx / 60) ** 2 + (dy / 40) ** 2,
          `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`,
        ).toBeGreaterThanOrEqual(0.98);
      } else if (arrowheadKind === 'diamond') {
        expect(
          Math.abs(dx) / 60 + Math.abs(dy) / 40,
          `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`,
        ).toBeGreaterThanOrEqual(0.98);
      } else {
        expect(
          Math.max(Math.abs(dx) / 60, Math.abs(dy) / 40),
          `${testCase.kind}/${testCase.at}/${testCase.style}/${index}`,
        ).toBeGreaterThanOrEqual(0.98);
      }
    }
  });

  it.each([
    {
      id: 'hook-into-diamond',
      target: diamond(714, 193, 153, 114),
      arrow: [
        { x: 624, y: 249 },
        { x: 709, y: 250 },
        { x: 697, y: 240 },
      ],
    },
    {
      id: 'v-into-rectangle',
      target: rectangle(739, 428, 162, 85),
      arrow: [
        { x: 790, y: 310 },
        { x: 790, y: 430 },
        { x: 781, y: 417 },
        { x: 790, y: 431 },
        { x: 800, y: 418 },
      ],
    },
  ])('cuts the reviewer barb regressions at the true tip: $id', ({ id: caseId, target, arrow }) => {
    const plan = recognizeDiagram({
      strokes: [
        { id: 'target', points: target },
        { id: 'arrow', points: arrow },
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    if (edge?.kind !== 'connector') {
      throw new Error('expected a connector');
    }
    expect(edge.endArrowhead).toBe('arrow');
    expect(edge.end).toMatchObject({ itemId: expect.stringContaining('target') });
    const endpoint = edge.points.at(-1)!;
    const adjacent = edge.points.at(-2)!;
    expect(Math.hypot(endpoint[0] - adjacent[0], endpoint[1] - adjacent[1])).toBeGreaterThan(10);
    if (caseId === 'hook-into-diamond') {
      expect(Math.abs(endpoint[1] - 251)).toBeLessThanOrEqual(6);
    } else {
      expect(endpoint[1]).toBeGreaterThanOrEqual(427);
      expect(endpoint[1]).toBeLessThanOrEqual(434);
    }
  });

  it('does not turn a short pen flick into an inline arrowhead', () => {
    const plan = recognizeDiagram({
      strokes: [
        { id: 'target', points: rectangle(100, 0, 120, 80) },
        {
          id: 'pen-flick',
          points: [
            { x: 20, y: 40 },
            { x: 70, y: 40 },
            { x: 96, y: 36 },
            { x: 100, y: 40 },
          ],
        },
      ],
      texts: [],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    expect(edge?.kind).toBe('connector');
    if (edge?.kind === 'connector') {
      expect(edge.startArrowhead).toBeNull();
      expect(edge.endArrowhead).toBeNull();
    }
  });

  it('ignores text that belongs to an existing container', () => {
    const plan = recognizeDiagram({
      strokes: [
        { id: 'left-node', points: rectangle(40, 40, 120, 60) },
        { id: 'right-node', points: rectangle(280, 40, 120, 60) },
        connector('edge', { x: 160, y: 70 }, { x: 280, y: 70 }),
      ],
      texts: [
        {
          id: 'native-label',
          text: 'Keep me',
          containerId: 'native-rectangle',
          x: 205,
          y: 58,
          width: 70,
          height: 20,
        },
      ],
      nativeNodes: [{
        id: 'native-rectangle',
        kind: 'rectangle',
        bounds: { x: 180, y: 20, width: 110, height: 120 },
      }],
    });

    expect(plan.items.every((item) => !item.sourceIds.includes('native-label'))).toBe(true);
    expect(plan.items.some((item) => item.kind === 'connector' && item.label === 'Keep me')).toBe(false);
  });
});
