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

  it('tidies and binds the captured horizontal arrow to native nodes', () => {
    const stroke = {
      id: 's1',
      points: [
        [824.94, 993.67], [829.39, 993.67], [836.06, 993.67], [849.39, 993.67],
        [866.06, 993.67], [883.83, 993.67], [896.06, 993.67], [897.17, 993.67],
        [908.28, 991.44], [913.83, 990.33], [917.17, 990.33], [919.39, 990.33],
        [923.83, 992.56], [926.06, 993.67], [927.17, 994.78], [928.28, 994.78],
        [929.39, 994.78], [930.5, 994.78], [931.61, 994.78], [934.94, 994.78],
        [939.39, 994.78], [943.83, 994.78], [947.17, 995.89], [949.39, 995.89],
        [950.5, 995.89], [951.61, 995.89], [952.72, 993.67], [952.72, 992.56],
        [953.83, 992.56], [954.94, 991.44], [954.94, 990.33], [953.83, 992.56],
        [950.5, 995.89], [944.94, 1001.44], [944.94, 1004.78], [943.83, 1005.89],
        [943.83, 1007], [943.83, 1008.11], [943.83, 1009.22], [948.28, 1009.22],
        [954.94, 1009.22], [960.5, 1009.22], [966.06, 1009.22], [969.39, 1008.11],
        [970.5, 1008.11], [970.5, 1007], [971.61, 1007], [974.94, 1007],
        [977.17, 1005.89], [979.39, 1004.78], [981.61, 1004.78], [982.72, 1004.78],
        [982.72, 1003.67], [983.83, 1003.67], [984.94, 1003.67], [986.06, 1002.56],
        [986.06, 1001.44], [984.94, 1001.44], [979.39, 998.11], [973.83, 998.11],
        [969.39, 995.89], [964.94, 995.89], [960.5, 993.67], [958.28, 992.56],
        [957.17, 992.56], [957.17, 992.56],
      ].map(([x, y]) => ({ x, y })),
    };
    const nativeNodes = [
      {
        id: 'native-shape-1',
        kind: 'rectangle' as const,
        bounds: { x: 550, y: 664, width: 241, height: 115 },
      },
      {
        id: 'native-shape-2',
        kind: 'ellipse' as const,
        bounds: { x: 620, y: 910, width: 204, height: 165 },
      },
      {
        id: 'native-shape-3',
        kind: 'diamond' as const,
        bounds: { x: 982, y: 905, width: 200, height: 190 },
      },
    ];
    const plan = recognizeDiagram({
      strokes: [stroke],
      texts: [],
      nativeNodes,
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    expect(edge).toMatchObject({
      sourceIds: ['s1'],
      start: { elementId: 'native-shape-2' },
      end: { elementId: 'native-shape-3' },
      startArrowhead: null,
      endArrowhead: 'arrow',
    });
    if (edge?.kind !== 'connector') {
      throw new Error('expected a native-bound connector');
    }
    expect(edge.points).toHaveLength(2);
    expect(edge.points[0]?.[0]).toBeGreaterThanOrEqual(823);
    expect(edge.points[0]?.[0]).toBeLessThanOrEqual(827);
    expect(edge.points[1]?.[0]).toBeGreaterThanOrEqual(983);
    expect(edge.points[1]?.[0]).toBeLessThanOrEqual(990);
    expect(edge.points[0]?.[1]).toBeGreaterThanOrEqual(993);
    expect(edge.points[0]?.[1]).toBeLessThanOrEqual(997);
    expect(edge.points[1]?.[1]).toBe(edge.points[0]?.[1]);
  });

  it('leaves the captured arrow unresolved without native nodes', () => {
    const plan = recognizeDiagram({
      strokes: [{
        id: 's1',
        points: [{ x: 824.94, y: 993.67 }, { x: 957.17, y: 992.56 }],
      }],
      texts: [],
    });
    expect(plan.items.some((item) => item.kind === 'connector')).toBe(false);
    expect(plan.unresolved).toMatchObject([{ sourceIds: ['s1'] }]);
  });

  it('keeps a separate start arrowhead on a curved shaft', () => {
    const shaft = [
      { x: 387.429, y: 265.179 },
      { x: 392.722, y: 264.697 },
      { x: 397.907, y: 265.985 },
      { x: 402.515, y: 265.248 },
      { x: 407.457, y: 265.179 },
      { x: 407.954, y: 268.592 },
      { x: 407.92, y: 271.616 },
      { x: 407.194, y: 274.287 },
      { x: 407.7, y: 300 },
      { x: 407.7, y: 350 },
      { x: 407.7, y: 400 },
      { x: 407.7, y: 450 },
      { x: 407.7, y: 500 },
      { x: 407.7, y: 550 },
      { x: 407.7, y: 600 },
      { x: 407.7, y: 650 },
      { x: 407.7, y: 700 },
      { x: 407.7, y: 730 },
      { x: 400, y: 750 },
      { x: 390, y: 770 },
      { x: 374.201, y: 782.441 },
    ];
    const plan = recognizeDiagram({
      strokes: [{
        id: 'curved-shaft',
        points: shaft,
      }, {
        id: 'curved-shaft-start-arrow',
        points: [
          { x: 384.088, y: 265.483 },
          { x: 409.002, y: 284.673 },
          { x: 405.127, y: 242.109 },
        ],
      }],
      texts: [],
      nativeNodes: [
        {
          id: 'source',
          kind: 'roundedRectangle',
          bounds: { x: 373.758, y: 230.61, width: 148.554, height: 82.267 },
        },
        {
          id: 'target',
          kind: 'diamond',
          bounds: { x: 372.548, y: 730.698, width: 135.038, height: 82.075 },
        },
      ],
    });
    const edge = plan.items.find((item) => item.kind === 'connector');
    expect(edge).toMatchObject({
      startArrowhead: 'arrow',
      sourceIds: expect.arrayContaining(['curved-shaft-start-arrow']),
    });
  });
});
