import { describe, expect, it } from 'vitest';
import type { SuggestionBounds, SuggestionPoint } from '../src/core/suggestions';
import {
  detectClosedShape,
  detectMultiStrokeShapes,
} from '../src/perception/t0/diagram-recognizer';
import type { T0Stroke } from '../src/perception/t0/types';

type Random = () => number;

const makeRandom = (seed: number): Random => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const between = (random: Random, minimum: number, maximum: number): number => {
  return minimum + random() * (maximum - minimum);
};

const rotatePoint = (
  point: SuggestionPoint,
  center: SuggestionPoint,
  angle: number,
): SuggestionPoint => {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
};

const distance = (first: SuggestionPoint, second: SuggestionPoint): number => {
  return Math.hypot(first.x - second.x, first.y - second.y);
};

const addJitter = (
  point: SuggestionPoint,
  random: Random,
  phase: number,
): SuggestionPoint => ({
  x: point.x
    + Math.sin(phase * 0.13) * 0.7
    + between(random, -1.2, 1.2),
  y: point.y
    + Math.cos(phase * 0.11) * 0.7
    + between(random, -1.2, 1.2),
});

const sampleSegment = (
  first: SuggestionPoint,
  second: SuggestionPoint,
  spacing: number,
  random: Random,
  phase: { value: number },
): SuggestionPoint[] => {
  const length = distance(first, second);
  const count = Math.max(1, Math.ceil(length / spacing));
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / count;
    const point = {
      x: first.x + (second.x - first.x) * ratio,
      y: first.y + (second.y - first.y) * ratio,
    };
    phase.value += 1;
    return addJitter(point, random, phase.value);
  });
};

const pointOnPolyline = (
  points: readonly SuggestionPoint[],
  distanceAlong: number,
): SuggestionPoint => {
  const perimeter = points.reduce((sum, point, index) => {
    const previous = points[index - 1];
    return sum + (previous ? distance(previous, point) : 0);
  }, 0);
  let remaining = ((distanceAlong % perimeter) + perimeter) % perimeter;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!;
    const second = points[(index + 1) % points.length]!;
    const segment = distance(first, second);
    if (remaining <= segment) {
      const ratio = segment === 0 ? 0 : remaining / segment;
      return {
        x: first.x + (second.x - first.x) * ratio,
        y: first.y + (second.y - first.y) * ratio,
      };
    }
    remaining -= segment;
  }
  return { ...points[0]! };
};

const polylineLength = (points: readonly SuggestionPoint[]): number => {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1]!, points[index]!);
  }
  return length;
};

const rectangleCorners = (
  bounds: SuggestionBounds,
  angle: number,
): SuggestionPoint[] => {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
  return corners.map((corner) => rotatePoint(corner, center, angle));
};

const roundedRectanglePolyline = (
  bounds: SuggestionBounds,
  radius: number,
  angle: number,
): SuggestionPoint[] => {
  const r = Math.min(radius, bounds.width / 3, bounds.height / 3);
  const local: SuggestionPoint[] = [];
  const addLine = (first: SuggestionPoint, second: SuggestionPoint) => {
    local.push(first, second);
  };
  const addArc = (
    center: SuggestionPoint,
    start: number,
    end: number,
  ) => {
    const steps = Math.max(3, Math.ceil(Math.abs(end - start) * r / 5));
    for (let index = 0; index <= steps; index += 1) {
      const ratio = index / steps;
      const theta = start + (end - start) * ratio;
      local.push({
        x: center.x + Math.cos(theta) * r,
        y: center.y + Math.sin(theta) * r,
      });
    }
  };
  addLine(
    { x: bounds.x + r, y: bounds.y },
    { x: bounds.x + bounds.width - r, y: bounds.y },
  );
  addArc(
    { x: bounds.x + bounds.width - r, y: bounds.y + r },
    -Math.PI / 2,
    0,
  );
  addLine(
    { x: bounds.x + bounds.width, y: bounds.y + r },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height - r },
  );
  addArc(
    { x: bounds.x + bounds.width - r, y: bounds.y + bounds.height - r },
    0,
    Math.PI / 2,
  );
  addLine(
    { x: bounds.x + bounds.width - r, y: bounds.y + bounds.height },
    { x: bounds.x + r, y: bounds.y + bounds.height },
  );
  addArc(
    { x: bounds.x + r, y: bounds.y + bounds.height - r },
    Math.PI / 2,
    Math.PI,
  );
  addLine(
    { x: bounds.x, y: bounds.y + bounds.height - r },
    { x: bounds.x, y: bounds.y + r },
  );
  addArc(
    { x: bounds.x + r, y: bounds.y + r },
    Math.PI,
    Math.PI * 1.5,
  );
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  return local.map((point) => rotatePoint(point, center, angle));
};

const ellipsePolyline = (
  bounds: SuggestionBounds,
  random: Random,
): SuggestionPoint[] => {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const points: SuggestionPoint[] = [];
  const count = Math.ceil(Math.PI * Math.sqrt(
    (bounds.width / 2) ** 2 + (bounds.height / 2) ** 2,
  ) / 4);
  for (let index = 0; index < count; index += 1) {
    const theta = index / count * Math.PI * 2;
    points.push({
      x: center.x + Math.cos(theta) * bounds.width / 2,
      y: center.y + Math.sin(theta) * bounds.height / 2,
    });
  }
  return points.map((point) => addJitter(point, random, point.x + point.y));
};

const diamondPolyline = (bounds: SuggestionBounds): SuggestionPoint[] => {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const vertices = [
    { x: center.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: center.y },
    { x: center.x, y: bounds.y + bounds.height },
    { x: bounds.x, y: center.y },
  ];
  const points: SuggestionPoint[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const first = vertices[index]!;
    const second = vertices[(index + 1) % vertices.length]!;
    const count = Math.ceil(distance(first, second) / 4);
    for (let step = 0; step < count; step += 1) {
      const ratio = step / count;
      points.push({
        x: first.x + (second.x - first.x) * ratio,
        y: first.y + (second.y - first.y) * ratio,
      });
    }
  }
  return points;
};

const noisyClosedPath = (
  perimeter: readonly SuggestionPoint[],
  random: Random,
  phase: { value: number },
  gapOrOvershoot: number,
): SuggestionPoint[] => {
  const total = polylineLength(perimeter);
  const start = between(random, 0, total);
  const signedCompletion = random() < 0.5
    ? total - gapOrOvershoot
    : total + gapOrOvershoot;
  const end = start + signedCompletion;
  const points: SuggestionPoint[] = [];
  let distanceAlong = start;
  while (distanceAlong < end) {
    points.push(addJitter(
      pointOnPolyline(perimeter, distanceAlong),
      random,
      phase.value,
    ));
    phase.value += 1;
    distanceAlong += between(random, 2, 8);
  }
  points.push(addJitter(pointOnPolyline(perimeter, end), random, phase.value));
  return random() < 0.5 ? points : points.reverse();
};

const shapeError = (
  actual: SuggestionBounds | undefined,
  expected: SuggestionBounds,
): number[] => {
  if (!actual) {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  return [
    Math.abs(actual.x - expected.x),
    Math.abs(actual.x + actual.width - (expected.x + expected.width)),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.y + actual.height - (expected.y + expected.height)),
  ];
};

const rectangleCase = (seed: number, multi: boolean): {
  expected: SuggestionBounds;
  strokes: T0Stroke[];
} => {
  const random = makeRandom(seed);
  const expected = {
    x: between(random, 100, 300),
    y: between(random, 100, 300),
    width: between(random, 90, 190),
    height: between(random, 55, 120),
  };

  const angle = between(random, -5, 5) * Math.PI / 180;
  const corners = rectangleCorners(expected, angle);
  if (!multi) {
    const radius = between(random, 0, 9);
    const perimeter = radius > 1
      ? roundedRectanglePolyline(expected, radius, angle)
      : corners;
    const phase = { value: seed % 31 };
    return {
      expected,
      strokes: [{
        id: `single-${seed}`,
        points: noisyClosedPath(
          perimeter,
          random,
          phase,
          between(random, 5, 18),
        ),
      }],
    };
  }

  const count = 2 + Math.floor(random() * 3);
  const phase = { value: seed % 31 };
  const groups: SuggestionPoint[][] = [];
  for (let group = 0; group < count; group += 1) {
    const firstCorner = Math.floor(group * 4 / count);
    const lastCorner = Math.floor((group + 1) * 4 / count) % 4;
    const path: SuggestionPoint[] = [];
    const start = corners[firstCorner]!;
    const next = corners[(firstCorner + 1) % 4]!;
    const previous = corners[(firstCorner + 3) % 4]!;
    const startExtension = between(random, -6, 8);
    const startLength = distance(previous, start);
    path.push({
      x: start.x + (previous.x - start.x) * startExtension / startLength,
      y: start.y + (previous.y - start.y) * startExtension / startLength,
    });
    let corner = firstCorner;
    path.push(start);
    while (corner !== lastCorner) {
      corner = (corner + 1) % 4;
      path.push(corners[corner]!);
    }
    const end = corners[lastCorner]!;
    const following = corners[(lastCorner + 1) % 4]!;
    const endExtension = between(random, -6, 8);
    const endLength = distance(end, following);
    path.push({
      x: end.x + (following.x - end.x) * endExtension / endLength,
      y: end.y + (following.y - end.y) * endExtension / endLength,
    });
    const sampled: SuggestionPoint[] = [];
    for (let index = 1; index < path.length; index += 1) {
      const segment = sampleSegment(path[index - 1]!, path[index]!, between(random, 2, 6), random, phase);
      sampled.push(...segment);
    }
    groups.push(sampled.map((point) => addJitter(point, random, phase.value++)));
  }
  if (random() < 0.5) {
    groups.reverse();
  }
  groups.forEach((group) => {
    if (random() < 0.5) {
      group.reverse();
    }
  });
  return {
    expected,
    strokes: groups.map((points, index) => ({
      id: `multi-${seed}-${index}`,
      points: points.map((point) => ({ ...point })),
    })),
  };
};

const multiDiamondCase = (seed: number): {
  expected: SuggestionBounds;
  strokes: T0Stroke[];
} => {
  const random = makeRandom(seed);
  const expected = {
    x: between(random, 140, 340),
    y: between(random, 120, 320),
    width: between(random, 115, 150),
    height: between(random, 80, 110),
  };
  const angle = between(random, -3, 3) * Math.PI / 180;
  const center = {
    x: expected.x + expected.width / 2,
    y: expected.y + expected.height / 2,
  };
  const baseVertices = [
    { x: center.x, y: expected.y },
    { x: expected.x + expected.width, y: center.y },
    { x: center.x, y: expected.y + expected.height },
    { x: expected.x, y: center.y },
  ];
  const vertices = baseVertices.map((vertex) => rotatePoint({
    x: vertex.x + between(random, -4, 4),
    y: vertex.y + between(random, -4, 4),
  }, center, angle));
  const count = 2 + Math.floor(random() * 3);
  const wobbleX = between(random, 1.5, 3.5);
  const wobbleY = between(random, 1.5, 3.5);
  const wavelengthX = between(random, 70, 180);
  const wavelengthY = between(random, 70, 180);
  const wobblePhaseX = between(random, 0, Math.PI * 2);
  const wobblePhaseY = between(random, 0, Math.PI * 2);
  const distort = (point: SuggestionPoint, distanceAlong: number): SuggestionPoint => ({
    x: point.x
      + Math.sin(distanceAlong / wavelengthX * Math.PI * 2 + wobblePhaseX) * wobbleX
      + between(random, -1, 1),
    y: point.y
      + Math.sin(distanceAlong / wavelengthY * Math.PI * 2 + wobblePhaseY) * wobbleY
      + between(random, -1, 1),
  });
  const groups: SuggestionPoint[][] = [];
  for (let group = 0; group < count; group += 1) {
    const firstSide = Math.floor(group * 4 / count);
    const lastSide = Math.floor((group + 1) * 4 / count) % 4;
    const path: SuggestionPoint[] = [];
    const first = vertices[firstSide]!;
    const previous = vertices[(firstSide + 3) % 4]!;
    const last = vertices[lastSide]!;
    const following = vertices[(lastSide + 1) % 4]!;
    const startExtension = between(random, -6, 8);
    const endExtension = between(random, -6, 8);
    const startLength = distance(previous, first);
    const endLength = distance(last, following);
    path.push({
      x: first.x + (previous.x - first.x) * startExtension / startLength,
      y: first.y + (previous.y - first.y) * startExtension / startLength,
    });
    path.push(first);
    let side = firstSide;
    while (side !== lastSide) {
      side = (side + 1) % 4;
      path.push(vertices[side]!);
    }
    path.push({
      x: last.x + (following.x - last.x) * endExtension / endLength,
      y: last.y + (following.y - last.y) * endExtension / endLength,
    });
    const sampled: SuggestionPoint[] = [];
    let distanceAlong = 0;
    for (let index = 1; index < path.length; index += 1) {
      const firstPoint = path[index - 1]!;
      const secondPoint = path[index]!;
      const length = distance(firstPoint, secondPoint);
      const spacing = between(random, 3, 6);
      const countOnSide = Math.max(2, Math.ceil(length / spacing));
      for (let step = 0; step < countOnSide; step += 1) {
        const ratio = step / countOnSide;
        const point = {
          x: firstPoint.x + (secondPoint.x - firstPoint.x) * ratio,
          y: firstPoint.y + (secondPoint.y - firstPoint.y) * ratio,
        };
        sampled.push(distort(point, distanceAlong));
        distanceAlong += length / countOnSide;
      }
    }
    sampled.push(distort(path[path.length - 1]!, distanceAlong));
    groups.push(random() < 0.5 ? sampled.reverse() : sampled);
  }
  if (random() < 0.5) {
    groups.reverse();
  }
  return {
    expected,
    strokes: groups.map((points, index) => ({
      id: `diamond-${seed}-${index}`,
      points,
    })),
  };
};

const worstSidePercentile = (errors: readonly number[], fraction: number): number => {
  const sorted = [...errors].sort((first, second) => first - second);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
};

describe('generated shape fitting', () => {
  it('fits 120 noisy single-stroke rectangles to their intended sides', () => {
    const errors: number[] = [];
    let detected = 0;
    for (let index = 0; index < 120; index += 1) {
      const generated = rectangleCase(0x5100 + index, false);
      const candidate = detectClosedShape(generated.strokes[0]!.points);
      if (candidate?.kind === 'rectangle' || candidate?.kind === 'roundedRectangle') {
        detected += 1;
        errors.push(Math.max(...shapeError(candidate.bounds, generated.expected)));
      } else {
        errors.push(Number.POSITIVE_INFINITY);
      }
    }
    const finite = errors.filter(Number.isFinite);
    const median = worstSidePercentile(finite, 0.5);
    const p90 = worstSidePercentile(finite, 0.9);
    console.log(`FIT_METRICS single rectangles detected=${detected}/120 medianWorst=${median.toFixed(2)} p90Worst=${p90.toFixed(2)}`);
    expect(detected).toBeGreaterThanOrEqual(114);
    expect(median).toBeLessThanOrEqual(2);
    expect(p90).toBeLessThanOrEqual(5);
  });

  it('fits 120 noisy multi-stroke rectangles to their intended sides', () => {
    const errors: number[] = [];
    let detected = 0;
    for (let index = 0; index < 120; index += 1) {
      const generated = rectangleCase(0x7200 + index, true);
      const candidates = detectMultiStrokeShapes(generated.strokes, new Set());
      const candidate = candidates[0]?.shape;
      if (candidate?.kind === 'rectangle') {
        detected += 1;
        errors.push(Math.max(...shapeError(candidate.bounds, generated.expected)));
      } else {
        errors.push(Number.POSITIVE_INFINITY);
      }
    }
    const finite = errors.filter(Number.isFinite);
    const median = worstSidePercentile(finite, 0.5);
    const p90 = worstSidePercentile(finite, 0.9);
    console.log(`FIT_METRICS multi rectangles detected=${detected}/120 medianWorst=${median.toFixed(2)} p90Worst=${p90.toFixed(2)}`);
    expect(detected).toBeGreaterThanOrEqual(114);
    expect(median).toBeLessThanOrEqual(2);
    expect(p90).toBeLessThanOrEqual(5);
  });

  it('reports generated ellipse and diamond fit metrics without regression', () => {
    const shapeMetrics = (kind: 'ellipse' | 'diamond') => {
      const errors: number[] = [];
      let detected = 0;
      for (let index = 0; index < 60; index += 1) {
        const random = makeRandom(
          (kind === 'ellipse' ? 0x8300 : 0x9400) + index,
        );
        const expected = {
          x: between(random, 100, 300),
          y: between(random, 100, 300),
          width: between(random, 90, 180),
          height: between(random, 55, 115),
        };
        const phase = { value: index };
        const perimeter = kind === 'ellipse'
          ? ellipsePolyline(expected, random)
          : diamondPolyline(expected);
        const candidate = detectClosedShape(noisyClosedPath(
          perimeter,
          random,
          phase,
          between(random, 5, 15),
        ));
        if (candidate?.kind === kind) {
          detected += 1;
          errors.push(Math.max(...shapeError(candidate.bounds, expected)));
        } else {
          errors.push(Number.POSITIVE_INFINITY);
        }
      }
      const finite = errors.filter(Number.isFinite);
      const median = worstSidePercentile(finite, 0.5);
      const p90 = worstSidePercentile(finite, 0.9);
      console.log(`FIT_METRICS ${kind} detected=${detected}/60 medianWorst=${median.toFixed(2)} p90Worst=${p90.toFixed(2)}`);
      return { detected, median, p90 };
    };

    const ellipse = shapeMetrics('ellipse');
    const diamond = shapeMetrics('diamond');
    expect(ellipse.detected).toBeGreaterThanOrEqual(56);
    expect(diamond.detected).toBeGreaterThanOrEqual(56);
    expect(ellipse.median).toBeLessThanOrEqual(3);
    expect(diamond.median).toBeLessThanOrEqual(3);
  });

  it('fits 220 noisy multi-stroke diamonds without tail inflation', () => {
    const errors: number[] = [];
    let detected = 0;
    for (let index = 0; index < 220; index += 1) {
      const generated = multiDiamondCase(0xa500 + index);
      const candidates = detectMultiStrokeShapes(generated.strokes, new Set());
      const candidate = candidates[0]?.shape;
      if (candidate?.kind === 'diamond') {
        detected += 1;
        errors.push(Math.max(...shapeError(candidate.bounds, generated.expected)));
      } else {
        errors.push(Number.POSITIVE_INFINITY);
      }
    }
    const finite = errors.filter(Number.isFinite);
    const p90 = worstSidePercentile(finite, 0.9);
    const maximum = Math.max(...finite);
    console.log(
      `FIT_METRICS multi diamonds detected=${detected}/220 p90Worst=${p90.toFixed(2)} maxWorst=${maximum.toFixed(2)}`,
    );
    expect(detected).toBeGreaterThanOrEqual(205);
    expect(p90).toBeLessThanOrEqual(5);
    expect(maximum).toBeLessThanOrEqual(8);
  });
});
