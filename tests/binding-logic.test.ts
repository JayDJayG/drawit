import { describe, expect, it, vi } from 'vitest';
vi.mock('open-color/open-color.json', () => ({}));
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: {
    NEVER: 'NEVER',
    IMMEDIATELY: 'IMMEDIATELY',
  },
  ROUNDNESS: {
    PROPORTIONAL_RADIUS: 'proportional-radius',
  },
  convertToExcalidrawElements: (skeletons: readonly Record<string, unknown>[]) => (
    skeletons.map((skeleton) => ({
      ...skeleton,
      boundElements: null,
      isDeleted: false,
      version: 1,
    }))
  ),
  exportToSvg: vi.fn(),
  newElementWith: (element: Record<string, unknown>, changes: Record<string, unknown>) => ({
    ...element,
    ...changes,
  }),
  viewportCoordsToSceneCoords: vi.fn(),
}));
import { CanvasAdapter } from '../src/canvas/excalidraw/CanvasAdapter';
import {
  bindArrowEndpoint,
  calculateBinding,
  determineFocusPoint,
  ensureBinding,
  inspectBindingInvariants,
  stabilizeBinding,
  synchronizeBindingMutuality,
  updateBoundPoint,
  type BindingElement,
  type BindingGeometry,
} from '../src/canvas/excalidraw/binding-logic';
import { recognizeDiagram } from '../src/perception/t0';
import type { SuggestionPlan } from '../src/core/suggestions';

type AdapterTestElement = {
  id: string;
  type: string;
  x?: number;
  y?: number;
  points?: readonly [number, number][];
  isDeleted?: boolean;
  customData?: { planItemId?: string };
  boundElements?: readonly { id: string; type: string }[] | null;
  startBinding?: AdapterBinding | null;
  endBinding?: AdapterBinding | null;
  [key: string]: unknown;
};

type AdapterBinding = {
  elementId: string;
  focus: number;
  gap: number;
};

const distance = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) => Math.hypot(first.x - second.x, first.y - second.y);

const angleVector = (angle: number) => ({
  x: Math.cos(angle),
  y: Math.sin(angle),
});

const normalizeVector = (value: { x: number; y: number }) => {
  const length = Math.hypot(value.x, value.y);
  return length < 0.001
    ? { x: 1, y: 0 }
    : { x: value.x / length, y: value.y / length };
};

const outlineRadius = (
  target: BindingGeometry,
  direction: { x: number; y: number },
): number => {
  const halfWidth = target.width / 2;
  const halfHeight = target.height / 2;
  const dx = Math.abs(direction.x);
  const dy = Math.abs(direction.y);
  if (target.type === 'ellipse') {
    return 1 / Math.sqrt((direction.x / halfWidth) ** 2 + (direction.y / halfHeight) ** 2);
  }
  if (target.type === 'diamond') {
    return 1 / (dx / halfWidth + dy / halfHeight);
  }
  return Math.min(
    dx > 0 ? halfWidth / dx : Number.POSITIVE_INFINITY,
    dy > 0 ? halfHeight / dy : Number.POSITIVE_INFINITY,
  );
};

const rotatePoint = (
  point: { x: number; y: number },
  center: { x: number; y: number },
  angle: number,
) => {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
};

const rotateVector = (
  vector: { x: number; y: number },
  angle: number,
) => ({
  x: vector.x * Math.cos(angle) - vector.y * Math.sin(angle),
  y: vector.x * Math.sin(angle) + vector.y * Math.cos(angle),
});

const pointInsideTarget = (
  target: BindingGeometry,
  point: { x: number; y: number },
): boolean => {
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const local = rotatePoint(point, center, -(target.angle ?? 0));
  const dx = local.x - center.x;
  const dy = local.y - center.y;
  if (target.type === 'ellipse') {
    return (
      (dx / (target.width / 2)) ** 2
      + (dy / (target.height / 2)) ** 2
    ) <= 1;
  }
  if (target.type === 'diamond') {
    const vertices = [
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y },
      { x: target.x + target.width, y: target.y + Math.floor(target.height / 2) + 1 },
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y + target.height },
      { x: target.x, y: target.y + Math.floor(target.height / 2) + 1 },
    ];
    let hasPositive = false;
    let hasNegative = false;
    for (let index = 0; index < vertices.length; index += 1) {
      const first = vertices[index]!;
      const second = vertices[(index + 1) % vertices.length]!;
      const side = (
        (second.x - first.x) * (local.y - first.y)
        - (second.y - first.y) * (local.x - first.x)
      );
      hasPositive ||= side > 0.000001;
      hasNegative ||= side < -0.000001;
      if (hasPositive && hasNegative) {
        return false;
      }
    }
    return true;
  }
  return (
    local.x >= target.x
    && local.x <= target.x + target.width
    && local.y >= target.y
    && local.y <= target.y + target.height
  );
};

const shaftEntry = (
  target: BindingGeometry,
  adjacent: { x: number; y: number },
  edge: { x: number; y: number },
) => {
  if (!pointInsideTarget(target, edge) || pointInsideTarget(target, adjacent)) {
    return undefined;
  }
  let outside = adjacent;
  let inside = edge;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = {
      x: (outside.x + inside.x) / 2,
      y: (outside.y + inside.y) / 2,
    };
    if (pointInsideTarget(target, middle)) {
      inside = middle;
    } else {
      outside = middle;
    }
  }
  return inside;
};

const shaftBoundaryEntry = (
  target: BindingGeometry,
  edge: { x: number; y: number },
  adjacent: { x: number; y: number },
) => {
  let previous = adjacent;
  let previousInside = pointInsideTarget(target, previous);
  for (let index = 1; index <= 96; index += 1) {
    const fraction = index / 96;
    const current = {
      x: adjacent.x + (edge.x - adjacent.x) * fraction,
      y: adjacent.y + (edge.y - adjacent.y) * fraction,
    };
    const currentInside = pointInsideTarget(target, current);
    if (currentInside !== previousInside) {
      let outside = previousInside ? current : previous;
      let inside = previousInside ? previous : current;
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const middle = {
          x: (outside.x + inside.x) / 2,
          y: (outside.y + inside.y) / 2,
        };
        if (pointInsideTarget(target, middle)) {
          inside = middle;
        } else {
          outside = middle;
        }
      }
      return inside;
    }
    previous = current;
    previousInside = currentInside;
  }
  return undefined;
};

const makeInsideBindingCases = () => {
  const cases: Array<{
    target: BindingGeometry;
    endpoint: 'start' | 'end';
    points: readonly [number, number][];
    origin: { x: number; y: number };
    originalAdjacent: { x: number; y: number };
    originalEdge: { x: number; y: number };
    hasEntry: boolean;
    category: string;
  }> = [];
  const shapes = [
    { type: 'rectangle', roundness: null },
    { type: 'rectangle', roundness: { type: 'proportional-radius' } },
    { type: 'ellipse', roundness: undefined },
    { type: 'diamond', roundness: undefined },
  ] as const;
  const rotations = [0, 0.11, -0.09];
  const depths = [-6, 0, 2, 8, 20];
  const approachOffsets = [-80, -60, -30, 0, 30, 60, 80];
  let index = 0;
  for (const shape of shapes) {
    for (const angle of rotations) {
      const target: BindingGeometry = {
        id: `inside-target-${index}`,
        type: shape.type,
        x: 140,
        y: 120,
        width: 140,
        height: 90,
        angle,
        roundness: shape.roundness,
      };
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      for (let directionIndex = 0; directionIndex < 8; directionIndex += 1) {
        const localDirection = angleVector(directionIndex * Math.PI / 4);
        const worldDirection = rotateVector(localDirection, angle);
        const localTarget = { ...target, angle: 0 };
        const radius = outlineRadius(localTarget, localDirection);
        const boundary = rotatePoint({
          x: center.x + localDirection.x * radius,
          y: center.y + localDirection.y * radius,
        }, center, angle);
        for (const depth of depths) {
          const edge = {
            x: boundary.x - worldDirection.x * depth,
            y: boundary.y - worldDirection.y * depth,
          };
          for (const approachOffset of approachOffsets) {
            const inward = rotateVector(
              { x: -worldDirection.x, y: -worldDirection.y },
              approachOffset * Math.PI / 180,
            );
            let adjacent: { x: number; y: number } | undefined;
            for (const length of [24, 40, 64, 96, 140]) {
              const candidate = {
                x: edge.x - inward.x * length,
                y: edge.y - inward.y * length,
              };
              if (!pointInsideTarget(target, candidate)) {
                adjacent = candidate;
                break;
              }
            }
            if (!adjacent) {
              continue;
            }
            const entry = shaftBoundaryEntry(target, edge, adjacent);
            if (!entry || distance(entry, adjacent) < 11.05) {
              continue;
            }
            const tangent = { x: -inward.y, y: inward.x };
            const previous = {
              x: adjacent.x + tangent.x * 18,
              y: adjacent.y + tangent.y * 18,
            };
            for (const pointCount of [2, 3]) {
              if (pointCount === 2 && Math.abs(approachOffset) > 60) {
                continue;
              }
              for (const endpoint of ['start', 'end'] as const) {
                const absolutePoints = endpoint === 'end'
                  ? pointCount === 2
                    ? [adjacent, edge]
                    : [previous, adjacent, edge]
                  : pointCount === 2
                    ? [edge, adjacent]
                    : [edge, adjacent, previous];
                const origin = absolutePoints[0]!;
                cases.push({
                  target: { ...target, id: `${target.id}-${index}` },
                  endpoint,
                  points: absolutePoints.map((point) => [
                    point.x - origin.x,
                    point.y - origin.y,
                  ] as [number, number]),
                  origin,
                  originalAdjacent: adjacent,
                  originalEdge: edge,
                  hasEntry: depth > 0,
                  category: `${shape.type}:${depth > 0 ? 'inside' : 'outside'}:${pointCount}p`,
                });
                index += 1;
              }
            }
          }
        }
      }
    }
  }
  return cases;
};

const generatedAdapterCases = () => {
  const cases: Array<{
    target: BindingGeometry;
    endpoint: 'start' | 'end';
    points: readonly [number, number][];
    origin: { x: number; y: number };
    outside: number;
    angle: number;
  }> = [];
  const shapeKinds = [
    { type: 'diamond', roundness: undefined },
    { type: 'rectangle', roundness: null },
    { type: 'rectangle', roundness: { type: 'proportional-radius' } },
    { type: 'ellipse', roundness: undefined },
  ] as const;
  const outsideValues = [0, 4, 8];
  const approachAngles = [-30, 0, 30].map((degrees) => degrees * Math.PI / 180);
  let index = 0;
  for (const shape of shapeKinds) {
    for (let directionIndex = 0; directionIndex < 8; directionIndex += 1) {
      const angle = directionIndex * Math.PI / 4;
      const direction = angleVector(angle);
      const perpendicular = { x: -direction.y, y: direction.x };
      const target = {
        id: `target-${index}`,
        type: shape.type,
        x: 100,
        y: 100,
        width: 120,
        height: 80,
        roundness: shape.roundness,
      };
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const radius = outlineRadius(target, direction);
      for (const outside of outsideValues) {
        for (const approachAngle of approachAngles) {
          const offAxis = 4;
          const endpoint = {
            x: center.x + direction.x * (radius + outside) + perpendicular.x * offAxis,
            y: center.y + direction.y * (radius + outside) + perpendicular.y * offAxis,
          };
          const approach = angleVector(angle + approachAngle);
          const adjacent = {
            x: endpoint.x + approach.x * 32,
            y: endpoint.y + approach.y * 32,
          };
          const previous = {
            x: adjacent.x + perpendicular.x * 18,
            y: adjacent.y + perpendicular.y * 18,
          };
          for (const endpointKind of ['start', 'end'] as const) {
            const absolutePoints = endpointKind === 'end'
              ? [previous, adjacent, endpoint]
              : [endpoint, adjacent, previous];
            const origin = absolutePoints[0]!;
            cases.push({
              target,
              endpoint: endpointKind,
              points: absolutePoints.map((point) => [
                point.x - origin.x,
                point.y - origin.y,
              ] as [number, number]),
              origin,
              outside,
              angle,
            });
            index += 1;
          }
        }
      }
    }
  }
  return cases;
};

const generatedEndpointStressCases = () => {
  const cases: Array<{
    target: BindingGeometry;
    endpoint: 'start' | 'end';
    points: readonly [number, number][];
    origin: { x: number; y: number };
    outside: number;
    offAxis: number;
    approachAngle: number;
    shaftDirection: { x: number; y: number };
  }> = [];
  const targets = [
    { type: 'diamond', roundness: undefined },
    { type: 'rectangle', roundness: null },
    { type: 'rectangle', roundness: { type: 'proportional-radius' } },
    { type: 'ellipse', roundness: undefined },
  ] as const;
  let index = 0;
  for (const targetShape of targets) {
    for (let directionIndex = 0; directionIndex < 8; directionIndex += 1) {
      const baseAngle = directionIndex * Math.PI / 4;
      const direction = angleVector(baseAngle);
      const perpendicular = { x: -direction.y, y: direction.x };
      const target = {
        id: `stress-target-${index}`,
        type: targetShape.type,
        x: 100,
        y: 100,
        width: 120,
        height: 80,
        roundness: targetShape.roundness,
      };
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const baseRadius = outlineRadius(target, direction);
      for (const offAxis of [0, 8, 16, 22]) {
        const ray = direction;
        const radius = baseRadius;
        for (const outside of [0, 4, 8]) {
          const endpoint = {
            x: center.x + ray.x * (radius + outside) + perpendicular.x * offAxis,
            y: center.y + ray.y * (radius + outside) + perpendicular.y * offAxis,
          };
          for (const approachOffset of [-30, 0, 30]) {
            const endpointNormal = normalizeVector({
              x: endpoint.x - center.x,
              y: endpoint.y - center.y,
            });
            const inwardAngle = Math.atan2(endpointNormal.y, endpointNormal.x) + Math.PI;
            const approach = angleVector(inwardAngle + approachOffset * Math.PI / 180);
            for (const segmentLength of [10, 15, 20]) {
              const adjacent = {
                x: endpoint.x - approach.x * segmentLength,
                y: endpoint.y - approach.y * segmentLength,
              };
              const previous = {
                x: adjacent.x + perpendicular.x * 8,
                y: adjacent.y + perpendicular.y * 8,
              };
              for (const endpointKind of ['start', 'end'] as const) {
                const absolutePoints = endpointKind === 'end'
                  ? [previous, adjacent, endpoint]
                  : [endpoint, adjacent, previous];
                const origin = absolutePoints[0]!;
                cases.push({
                  target,
                  endpoint: endpointKind,
                  points: absolutePoints.map((point) => [
                    point.x - origin.x,
                    point.y - origin.y,
                  ] as [number, number]),
                  origin,
                  outside,
                  offAxis,
                  approachAngle: approachOffset,
                  shaftDirection: approach,
                });
                index += 1;
              }
            }
          }
        }
      }
    }
  }
  return cases;
};

type Round7DiamondCase = {
  target: BindingGeometry;
  endpoint: 'start' | 'end';
  arrow: BindingElement;
  entry: { x: number; y: number } | undefined;
  targetPoint: { x: number; y: number };
  entryVertexDistance: number;
};

const makeSeededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const diamondVertices = (target: BindingGeometry): { x: number; y: number }[] => {
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  return [
    { x: target.x + Math.floor(target.width / 2) + 1, y: target.y },
    { x: target.x + target.width, y: target.y + Math.floor(target.height / 2) + 1 },
    { x: target.x + Math.floor(target.width / 2) + 1, y: target.y + target.height },
    { x: target.x, y: target.y + Math.floor(target.height / 2) + 1 },
  ].map((point) => rotatePoint(point, center, target.angle ?? 0));
};

const distanceToSegment = (
  point: { x: number; y: number },
  first: { x: number; y: number },
  second: { x: number; y: number },
) => {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator < 0.000001
    ? 0
    : Math.max(
      0,
      Math.min(
        1,
        ((point.x - first.x) * dx + (point.y - first.y) * dy) / denominator,
      ),
    );
  return distance(point, {
    x: first.x + dx * t,
    y: first.y + dy * t,
  });
};

const nearestDiamondSide = (
  target: BindingGeometry,
  point: { x: number; y: number },
) => {
  const vertices = diamondVertices(target);
  let index = 0;
  let sideDistance = Number.POSITIVE_INFINITY;
  let vertexDistance = Number.POSITIVE_INFINITY;
  for (let side = 0; side < vertices.length; side += 1) {
    const next = vertices[(side + 1) % vertices.length]!;
    const currentDistance = distanceToSegment(point, vertices[side]!, next);
    if (currentDistance < sideDistance) {
      index = side;
      sideDistance = currentDistance;
      vertexDistance = Math.min(
        distance(point, vertices[side]!),
        distance(point, next),
      );
    }
  }
  return { index, vertexDistance };
};

const nearestDiamondOutlinePoint = (
  target: BindingGeometry,
  point: { x: number; y: number },
) => {
  const vertices = diamondVertices(target);
  let best = vertices[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let side = 0; side < vertices.length; side += 1) {
    const first = vertices[side]!;
    const second = vertices[(side + 1) % vertices.length]!;
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const denominator = dx * dx + dy * dy;
    const projection = denominator < 0.000001
      ? 0
      : Math.max(
        0,
        Math.min(
          1,
          ((point.x - first.x) * dx + (point.y - first.y) * dy) / denominator,
        ),
      );
    const candidate = {
      x: first.x + dx * projection,
      y: first.y + dy * projection,
    };
    const candidateDistance = distance(point, candidate);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return best;
};

const diamondShaftTarget = (
  target: BindingGeometry,
  edge: { x: number; y: number },
  adjacent: { x: number; y: number },
) => {
  if (pointInsideTarget(target, edge)) {
    return shaftBoundaryEntry(target, edge, adjacent)
      ?? nearestDiamondOutlinePoint(target, edge);
  }
  const direction = normalizeVector({
    x: edge.x - adjacent.x,
    y: edge.y - adjacent.y,
  });
  let previous = edge;
  for (let distanceAlongRay = 1; distanceAlongRay <= 256; distanceAlongRay += 1) {
    const current = {
      x: edge.x + direction.x * distanceAlongRay,
      y: edge.y + direction.y * distanceAlongRay,
    };
    if (pointInsideTarget(target, current)) {
      let outside = previous;
      let inside = current;
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const middle = {
          x: (outside.x + inside.x) / 2,
          y: (outside.y + inside.y) / 2,
        };
        if (pointInsideTarget(target, middle)) {
          inside = middle;
        } else {
          outside = middle;
        }
      }
      return inside;
    }
    previous = current;
  }
  return nearestDiamondOutlinePoint(target, edge);
};

const rectangleShaftTarget = (
  target: BindingGeometry,
  edge: { x: number; y: number },
  adjacent: { x: number; y: number },
) => {
  if (pointInsideTarget(target, edge)) {
    return shaftBoundaryEntry(target, edge, adjacent)
      ?? edge;
  }
  const direction = normalizeVector({
    x: edge.x - adjacent.x,
    y: edge.y - adjacent.y,
  });
  let previous = edge;
  for (let step = 1; step <= 2048; step += 1) {
    const current = {
      x: edge.x + direction.x * step,
      y: edge.y + direction.y * step,
    };
    if (pointInsideTarget(target, current)) {
      let outside = previous;
      let inside = current;
      for (let iteration = 0; iteration < 48; iteration += 1) {
        const middle = {
          x: (outside.x + inside.x) / 2,
          y: (outside.y + inside.y) / 2,
        };
        if (pointInsideTarget(target, middle)) {
          inside = middle;
        } else {
          outside = middle;
        }
      }
      return inside;
    }
    previous = current;
  }
  return edge;
};

const makeRound7DiamondCases = (
  count: number,
  seed: number,
  harsh = false,
  includeShort = false,
): Round7DiamondCase[] => {
  const random = makeSeededRandom(seed);
  const cases: Round7DiamondCase[] = [];
  const targetCenter = { x: 260, y: 220 };
  for (let index = 0; index < count; index += 1) {
    while (true) {
    const target: BindingGeometry = {
      id: `round7-diamond-${harsh ? 'harsh' : 'realistic'}-${index}`,
      type: 'diamond',
      x: targetCenter.x - 75,
      y: targetCenter.y - 50,
      width: 150,
      height: 100,
      angle: random() < 0.7 ? 0 : (random() * 0.12 - 0.06),
    };
    const localVertices = [
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y },
      { x: target.x + target.width, y: target.y + Math.floor(target.height / 2) + 1 },
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y + target.height },
      { x: target.x, y: target.y + Math.floor(target.height / 2) + 1 },
    ];
    const localFirst = localVertices[harsh
      ? Math.floor(random() * localVertices.length)
      : Math.floor(random() * localVertices.length)]!;
    const localSecond = localVertices[
      (localVertices.indexOf(localFirst) + 1) % localVertices.length
    ]!;
    const center = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    };
    const first = rotatePoint(localFirst, center, target.angle ?? 0);
    const second = rotatePoint(localSecond, center, target.angle ?? 0);
    const t = harsh
      ? (random() < 0.5 ? 0.02 + random() * 0.10 : 0.88 + random() * 0.10)
      : 0.1 + random() * 0.8;
    const boundary = {
      x: first.x + (second.x - first.x) * t,
      y: first.y + (second.y - first.y) * t,
    };
    let outward = normalizeVector({
      x: second.y - first.y,
      y: -(second.x - first.x),
    });
    if (
      (center.x - boundary.x) * outward.x
      + (center.y - boundary.y) * outward.y > 0
    ) {
      outward = { x: -outward.x, y: -outward.y };
    }
    const approachOffset = (harsh ? (random() * 140 - 70) : (random() * 60 - 30))
      * Math.PI / 180;
    const inward = rotateVector(
      { x: -outward.x, y: -outward.y },
      approachOffset,
    );
    const depth = harsh
      ? (includeShort ? random() * 26 - 6 : random() * 20)
      : random() * 26 - 6;
    let edge = {
      x: boundary.x + inward.x * depth,
      y: boundary.y + inward.y * depth,
    };
    if (harsh && !includeShort && !pointInsideTarget(target, edge)) {
      edge = boundary;
    }
    const outsideLength = harsh
      ? 30 + random() * 170
      : 30 + random() * 170;
    const adjacent = {
      x: edge.x - inward.x * outsideLength,
      y: edge.y - inward.y * outsideLength,
    };
    const tangent = { x: -inward.y, y: inward.x };
    const previous = {
      x: adjacent.x - inward.x * (20 + random() * 60) + tangent.x * (random() * 120 - 60),
      y: adjacent.y - inward.y * (20 + random() * 60) + tangent.y * (random() * 120 - 60),
    };
    const pointCount = random() < 0.6 ? 2 : 3;
    const endpoint = random() < 0.5 ? 'start' : 'end';
    const absolutePoints = endpoint === 'end'
      ? pointCount === 2
        ? [adjacent, edge]
        : [previous, adjacent, edge]
      : pointCount === 2
        ? [edge, adjacent]
        : [edge, adjacent, previous];
    const origin = absolutePoints[0]!;
    const arrow: BindingElement = {
      id: `round7-arrow-${harsh ? 'harsh' : 'realistic'}-${index}`,
      type: 'arrow',
      x: origin.x,
      y: origin.y,
      points: absolutePoints.map((point) => [
        point.x - origin.x,
        point.y - origin.y,
      ] as [number, number]),
      boundElements: null,
    };
    if (random() < 0.3) {
      arrow[`${endpoint}Binding`] = {
        elementId: target.id,
        focus: random() * 2 - 1,
        gap: 0.5 + random() * 19.5,
      };
    }
    const entry = pointInsideTarget(target, edge)
      ? shaftBoundaryEntry(target, adjacent, edge)
      : undefined;
    const targetPoint = diamondShaftTarget(target, edge, adjacent);
    const shaft = normalizeVector({
      x: edge.x - adjacent.x,
      y: edge.y - adjacent.y,
    });
    const targetOffset = {
      x: targetPoint.x - edge.x,
      y: targetPoint.y - edge.y,
    };
    const targetAlongShaft = targetOffset.x * shaft.x + targetOffset.y * shaft.y;
    const targetLineDistance = Math.abs(
      targetOffset.x * shaft.y - targetOffset.y * shaft.x,
    );
    if (
      targetLineDistance > 0.75
      || (!pointInsideTarget(target, edge) && targetAlongShaft < 0)
    ) {
      continue;
    }
    const entrySide = nearestDiamondSide(target, targetPoint);
    cases.push({
      target,
      endpoint,
      arrow,
      entry,
      targetPoint,
      entryVertexDistance: entrySide?.vertexDistance ?? Number.POSITIVE_INFINITY,
    });
    break;
    }
  }
  return cases;
};

const roundTrip = (
  target: BindingGeometry,
  points: readonly [number, number][],
  endpoint: 'start' | 'end',
) => {
  const arrow = { x: 0, y: 0, points };
  const binding = calculateBinding(arrow, target, endpoint);
  const boundArrow = {
    ...arrow,
    ...(endpoint === 'start' ? { startBinding: binding } : { endBinding: binding }),
  };
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const edge = points[edgeIndex]!;
  const recomputed = updateBoundPoint(boundArrow, target, endpoint);
  const focusPoint = determineFocusPoint(
    target,
    binding.focus,
    endpoint === 'start'
      ? { x: points[1]![0], y: points[1]![1] }
      : { x: points[points.length - 2]![0], y: points[points.length - 2]![1] },
  );
  return {
    binding,
    edge: { x: edge[0], y: edge[1] },
    focusPoint,
    recomputed,
  };
};

describe('Excalidraw 0.18.1 binding geometry port', () => {
  it('round-trips off-centre and multi-point bindings for rectangles, diamonds, and ellipses', () => {
    const cases: Array<{
      target: BindingGeometry;
      points: readonly [number, number][];
      endpoint: 'start' | 'end';
    }> = [
      {
        target: { id: 'rectangle', type: 'rectangle', x: 100, y: 100, width: 120, height: 80 },
        points: [[100, 125], [40, 125], [25, 155]],
        endpoint: 'start',
      },
      {
        target: { id: 'diamond', type: 'diamond', x: 100, y: 100, width: 120, height: 80 },
        points: [[40, 140], [70, 140], [100, 140]],
        endpoint: 'end',
      },
      {
        target: { id: 'ellipse', type: 'ellipse', x: 100, y: 100, width: 120, height: 80 },
        points: [[100, 140], [70, 140], [35, 210]],
        endpoint: 'start',
      },
    ];

    for (const testCase of cases) {
      const result = roundTrip(testCase.target, testCase.points, testCase.endpoint);
      expect(Math.abs(result.binding.focus)).toBeLessThanOrEqual(1);
      expect(result.binding.gap).toBeGreaterThanOrEqual(1);
      expect(distance(result.edge, result.recomputed), testCase.target.id).toBeLessThanOrEqual(1.01);
    }
  });

  it('uses the edge-through-shape ray direction for off-centre focus points', () => {
    const target: BindingGeometry = {
      id: 'existing-rectangle',
      type: 'rectangle',
      x: 200,
      y: 120,
      width: 140,
      height: 90,
    };
    const adjacent = { x: 150, y: 145 };
    const edge = { x: 200, y: 145 };
    const binding = calculateBinding({
      x: 0,
      y: 0,
      points: [[150, 145], [200, 145]],
    }, target, 'end');
    const focusPoint = determineFocusPoint(target, binding.focus, adjacent);

    expect(Math.abs(binding.focus)).toBeLessThanOrEqual(1);
    expect(focusPoint.x).toBeGreaterThan(target.x);
  });

  it.each([
    {
      name: 'hook into the left diamond vertex',
      target: { id: 'decision', type: 'diamond', x: 712.89, y: 194.1, width: 153.54, height: 113.82 },
      arrow: {
        x: 624.8,
        y: 249.8,
        points: [[0, 0], [84.28, 0.3]] as readonly [number, number][],
      },
      endpoint: 'end' as const,
    },
    {
      name: 'V out of the bottom diamond vertex',
      target: { id: 'decision', type: 'diamond', x: 712.89, y: 194.1, width: 153.54, height: 113.82 },
      arrow: {
        x: 791.4,
        y: 310.64,
        points: [[0, 0], [-3.4, 82.86], [-3.3, 116.76]] as readonly [number, number][],
      },
      endpoint: 'start' as const,
    },
  ])('converges vertex bindings without dropping them: $name', ({ target, arrow, endpoint }) => {
    const result = stabilizeBinding(arrow, target, endpoint);
    expect(result.binding).not.toBeNull();
    expect(result.movement).toBeLessThanOrEqual(0.5);
    expect(result.points).toHaveLength(arrow.points.length);
  });

  it.each(generatedAdapterCases())(
    'keeps generated $target.type $endpoint binding at angle $angle outside=$outside',
    ({ target, endpoint, points, origin, outside }) => {
      const arrow: BindingElement = {
        id: `arrow-${target.id}-${endpoint}-${outside}`,
        type: 'arrow',
        x: origin.x,
        y: origin.y,
        points,
        boundElements: null,
      };
      const bound = bindArrowEndpoint(arrow, target, endpoint);
      const binding = endpoint === 'start' ? bound.startBinding : bound.endBinding;
      expect(binding).not.toBeNull();
      expect(binding?.elementId).toBe(target.id);
      expect(binding?.gap).toBeGreaterThanOrEqual(1);
      const elements = synchronizeBindingMutuality([
        targetElement(target),
        bound,
      ]);
      const liveTarget = elements.find((element) => element.id === target.id)!;
      expect(liveTarget.boundElements).toContainEqual({
        id: arrow.id,
        type: 'arrow',
      });
      const boundPoints = bound.points ?? [];
      const edgeIndex = endpoint === 'start' ? 0 : boundPoints.length - 1;
      const adjacentIndex = endpoint === 'start' ? 1 : boundPoints.length - 2;
      const edgePoint = boundPoints[edgeIndex]!;
      const adjacentPoint = boundPoints[adjacentIndex]!;
      const edge = {
        x: bound.x + edgePoint[0],
        y: bound.y + edgePoint[1],
      };
      const adjacent = {
        x: bound.x + adjacentPoint[0],
        y: bound.y + adjacentPoint[1],
      };
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const radial = {
        x: edge.x - center.x,
        y: edge.y - center.y,
      };
      const length = Math.hypot(radial.x, radial.y);
      const direction = { x: radial.x / length, y: radial.y / length };
      const radialGap = length - outlineRadius(target, direction);
      expect(radialGap).toBeGreaterThanOrEqual(-0.5);
      expect(radialGap).toBeLessThanOrEqual(6.5);
      expect(distance(edge, adjacent)).toBeGreaterThanOrEqual(10);
      const roundTrip = updateBoundPoint(
        bound,
        target,
        endpoint,
      );
      expect(distance(edge, roundTrip)).toBeLessThanOrEqual(0.5);
    },
  );

  it.each(generatedEndpointStressCases())(
    'keeps stress binding for $target.type $endpoint offAxis=$offAxis outside=$outside approach=$approachAngle',
    ({ target, endpoint, points, origin, shaftDirection }) => {
      const arrow: BindingElement = {
        id: `stress-arrow-${target.id}-${endpoint}`,
        type: 'arrow',
        x: origin.x,
        y: origin.y,
        points,
        boundElements: null,
      };
      const bound = bindArrowEndpoint(arrow, target, endpoint);
      const binding = endpoint === 'start' ? bound.startBinding : bound.endBinding;
      if (!binding) {
        return;
      }
      const edgeIndex = endpoint === 'start' ? 0 : (bound.points?.length ?? 1) - 1;
      const adjacentIndex = endpoint === 'start' ? 1 : (bound.points?.length ?? 2) - 2;
      const edgePoint = bound.points?.[edgeIndex];
      const adjacentPoint = bound.points?.[adjacentIndex];
      expect(edgePoint).toBeDefined();
      expect(adjacentPoint).toBeDefined();
      if (!edgePoint || !adjacentPoint) {
        return;
      }
      const edge = {
        x: bound.x + edgePoint[0],
        y: bound.y + edgePoint[1],
      };
      const adjacent = {
        x: bound.x + adjacentPoint[0],
        y: bound.y + adjacentPoint[1],
      };
      expect(distance(edge, adjacent)).toBeGreaterThanOrEqual(10);
      const targetCenter = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const radial = {
        x: edge.x - targetCenter.x,
        y: edge.y - targetCenter.y,
      };
      const radialLength = Math.hypot(radial.x, radial.y);
      const radialDirection = {
        x: radial.x / Math.max(0.001, radialLength),
        y: radial.y / Math.max(0.001, radialLength),
      };
      const radialGap = radialLength - outlineRadius(target, radialDirection);
      expect(radialGap).toBeGreaterThanOrEqual(-0.5);
      expect(radialGap).toBeLessThanOrEqual(6.5);
      expect(radialLength).toBeGreaterThan(10);
      const actualDirection = normalizeVector({
        x: edge.x - adjacent.x,
        y: edge.y - adjacent.y,
      });
      const directionCosine = actualDirection.x * shaftDirection.x
        + actualDirection.y * shaftDirection.y;
      expect(directionCosine).toBeGreaterThanOrEqual(Math.cos(20 * Math.PI / 180));
      expect(distance(
        edge,
        updateBoundPoint(bound, target, endpoint),
      )).toBeLessThanOrEqual(0.5);
      const elements = synchronizeBindingMutuality([
        targetElement(target),
        bound,
      ]);
      expect(elements.find((element) => element.id === target.id)?.boundElements)
        .toContainEqual({ id: bound.id, type: 'arrow' });
    },
  );

  it('keeps generated interior endpoints on the shaft entry without moving the other end', () => {
    const cases = makeInsideBindingCases();
    const fallbackDistances: number[] = [];
    const failures: string[] = [];
    const unboundByCategory = new Map<string, number>();
    let unbound = 0;
    const absolutePoint = (
      arrow: BindingElement,
      endpoint: 'start' | 'end',
    ) => {
      const points = arrow.points ?? [];
      const point = points[endpoint === 'start' ? 0 : points.length - 1]!;
      return { x: arrow.x + point[0], y: arrow.y + point[1] };
    };

    for (const testCase of cases) {
      const arrow: BindingElement = {
        id: `inside-arrow-${testCase.target.id}-${testCase.endpoint}`,
        type: 'arrow',
        x: testCase.origin.x,
        y: testCase.origin.y,
        points: testCase.points,
        boundElements: null,
      };
      const oppositeBefore = absolutePoint(
        arrow,
        testCase.endpoint === 'start' ? 'end' : 'start',
      );
      const bound = bindArrowEndpoint(arrow, testCase.target, testCase.endpoint);
      const binding = testCase.endpoint === 'start'
        ? bound.startBinding
        : bound.endBinding;
      if (!binding) {
        unbound += 1;
        unboundByCategory.set(
          testCase.category,
          (unboundByCategory.get(testCase.category) ?? 0) + 1,
        );
        continue;
      }
      const invariant = inspectBindingInvariants(
        bound,
        testCase.target,
        testCase.endpoint,
        arrow,
      );
      if (!invariant.valid) {
        failures.push(`${testCase.category}: invariant ${JSON.stringify(invariant)}`);
      }
      const oppositeAfter = absolutePoint(
        bound,
        testCase.endpoint === 'start' ? 'end' : 'start',
      );
      if (distance(oppositeBefore, oppositeAfter) > 0.5) {
        failures.push(`${testCase.category}: opposite endpoint moved ${distance(oppositeBefore, oppositeAfter)}`);
      }
      const synced = synchronizeBindingMutuality([
        targetElement(testCase.target),
        bound,
      ]);
      if (!synced.find((element) => element.id === testCase.target.id)?.boundElements
        ?.some((element) => element.id === bound.id && element.type === 'arrow')) {
        failures.push(`${testCase.category}: binding was not mutual`);
      }

      if (testCase.hasEntry) {
        const entry = shaftEntry(
          testCase.target,
          testCase.originalAdjacent,
          testCase.originalEdge,
        );
        if (!entry) {
          failures.push(`${testCase.category}: missing shaft entry`);
          continue;
        }
        const outward = normalizeVector({
          x: testCase.originalAdjacent.x - entry.x,
          y: testCase.originalAdjacent.y - entry.y,
        });
        const expectedBoundPoint = {
          x: entry.x + outward.x,
          y: entry.y + outward.y,
        };
        const actual = absolutePoint(bound, testCase.endpoint);
        const entryDistance = distance(actual, entry);
        if (distance(actual, expectedBoundPoint) > 1.25) {
          fallbackDistances.push(entryDistance);
        }
      }
    }

    const percentile = (values: readonly number[], fraction: number) => {
      if (values.length === 0) {
        return 0;
      }
      const sorted = [...values].sort((first, second) => first - second);
      return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
    };
    console.log(
      `BINDING_INSIDE total=${cases.length} failures=${failures.length} `
      + `unbound=${unbound} byCategory=${JSON.stringify(Object.fromEntries(unboundByCategory))} `
      + `fallbacks=${fallbackDistances.length} `
      + `fallbackDistance(p50/p90/max)=${
        [0.5, 0.9, 1].map((fraction) => percentile(fallbackDistances, fraction).toFixed(2)).join('/')
      }`,
    );
    expect(failures).toEqual([]);
    expect(unbound).toBeLessThanOrEqual(Math.ceil(cases.length * 0.01));
  }, 30_000);

  it('solves realistic and harsh diamond bindings by nearest shaft entry', () => {
    const percentile = (values: readonly number[], fraction: number) => {
      if (values.length === 0) {
        return 0;
      }
      const sorted = [...values].sort((first, second) => first - second);
      return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
    };
    const absoluteEndpoint = (
      arrow: BindingElement,
      endpoint: 'start' | 'end',
    ) => {
      const points = arrow.points ?? [];
      const point = points[endpoint === 'start' ? 0 : points.length - 1]!;
      return { x: arrow.x + point[0], y: arrow.y + point[1] };
    };
    const runCases = (
      cases: readonly Round7DiamondCase[],
      pureCount: number,
    ) => {
      const entryDistances: number[] = [];
      const timing: number[] = [];
      const failures: string[] = [];
      const worst: Array<Record<string, unknown>> = [];
      let unbound = 0;
      let sideChanges = 0;
      let pureFailures = 0;
      for (const [index, testCase] of cases.entries()) {
        const input = {
          ...testCase.arrow,
          points: testCase.arrow.points?.map(([x, y]) => [x, y] as [number, number]),
        };
        const started = performance.now();
        const bound = bindArrowEndpoint(input, testCase.target, testCase.endpoint);
        timing.push(performance.now() - started);
        if (index < pureCount) {
          const pure = ensureBinding(
            {
              ...input,
              points: input.points?.map(([x, y]) => [x, y] as [number, number]),
            },
            testCase.target,
            testCase.endpoint,
          );
          const pureInvariant = inspectBindingInvariants(
            pure,
            testCase.target,
            testCase.endpoint,
            input,
          );
          if (!pureInvariant.valid) {
            pureFailures += 1;
          }
        }
        const binding = testCase.endpoint === 'start'
          ? bound.startBinding
          : bound.endBinding;
        if (!binding) {
          unbound += 1;
          continue;
        }
        const invariant = inspectBindingInvariants(
          bound,
          testCase.target,
          testCase.endpoint,
          input,
        );
        if (!invariant.valid) {
          failures.push(`${testCase.arrow.id}: ${JSON.stringify(invariant)}`);
        }
        const actual = absoluteEndpoint(bound, testCase.endpoint);
        if (testCase.entry) {
          const entryDistance = distance(actual, testCase.entry);
          entryDistances.push(entryDistance);
          if (worst.length < 5 || entryDistance > Number(worst[0]?.distance ?? -1)) {
            worst.push({
              distance: entryDistance,
              target: testCase.target,
              endpoint: testCase.endpoint,
              arrow: input,
              bound,
              entry: testCase.entry,
            });
            worst.sort((first, second) => Number(second.distance) - Number(first.distance));
            worst.splice(5);
          }
          const expectedSide = nearestDiamondSide(testCase.target, testCase.entry);
          const actualSide = nearestDiamondSide(testCase.target, actual);
          if (
            expectedSide.index !== actualSide.index
            && expectedSide.vertexDistance > 3
            && actualSide.vertexDistance > 3
          ) {
            sideChanges += 1;
          }
        }
        const mutual = synchronizeBindingMutuality([
          {
            ...bound,
            boundElements: null,
          },
          {
            ...testCase.target,
            boundElements: null,
            id: testCase.target.id,
            type: 'diamond',
          } as BindingElement,
        ]);
        if (!mutual.some((element) => (
          element.id === testCase.target.id
          && element.boundElements?.some((item) => item.id === bound.id)
        ))) {
          failures.push(`${testCase.arrow.id}: not mutual`);
        }
      }
      return {
        entryDistances,
        timing,
        failures,
        unbound,
        sideChanges,
        pureFailures,
        worst,
      };
    };

    const realistic = runCases(makeRound7DiamondCases(768, 0x7d1a_2025), 256);
    const harsh = runCases(makeRound7DiamondCases(468, 0x7d1a_2026, true), 0);
    const timingP50 = percentile(realistic.timing, 0.5);
    const realisticP99 = percentile(realistic.entryDistances, 0.99);
    const harshP99 = percentile(harsh.entryDistances, 0.99);
    console.log(
      `DIAMOND_R7 realistic=${realistic.entryDistances.length} `
      + `unbound=${realistic.unbound} p99/max=${
        realisticP99.toFixed(2)
      }/${Math.max(...realistic.entryDistances).toFixed(2)} `
      + `sideChanges=${realistic.sideChanges} pureFailures=${realistic.pureFailures} `
      + `harsh=${harsh.entryDistances.length} unbound=${harsh.unbound} `
      + `p99/max=${harshP99.toFixed(2)}/${Math.max(...harsh.entryDistances).toFixed(2)} `
      + `sideChanges=${harsh.sideChanges} timingP50=${timingP50.toFixed(3)}ms`,
    );
    expect(realistic.failures).toEqual([]);
    expect(harsh.failures).toEqual([]);
    expect(realistic.unbound).toBe(0);
    expect(harsh.unbound).toBe(0);
    expect(realistic.pureFailures).toBe(0);
    expect(realisticP99).toBeLessThanOrEqual(2.5);
    expect(Math.max(...realistic.entryDistances)).toBeLessThanOrEqual(6);
    expect(harshP99).toBeLessThanOrEqual(6);
    expect(harsh.sideChanges).toBe(0);
    expect(timingP50).toBeLessThan(16);
  }, 30_000);

  it('keeps the deterministic Round 8 repro endpoints and bend points stable', () => {
    const diamond: BindingGeometry = {
      id: 'r8-diamond',
      type: 'diamond',
      x: 100,
      y: 100,
      width: 150,
      height: 100,
      angle: 0,
      roundness: null,
    };
    const rectangle: BindingGeometry = {
      ...diamond,
      id: 'r8-rectangle',
      type: 'rectangle',
    };
    const cases = [
      {
        name: 'R1',
        target: diamond,
        endpoint: 'start' as const,
        points: [{ x: 202.01, y: 117.22 }, { x: 265.96, y: -20.28 }],
      },
      {
        name: 'R2',
        target: diamond,
        endpoint: 'end' as const,
        points: [{ x: 101.55, y: 352.53 }, { x: 149.25, y: 186.31 }],
      },
      {
        name: 'R3',
        target: diamond,
        endpoint: 'end' as const,
        points: [{ x: 203.5, y: 371.12 }, { x: 186.56, y: 192.68 }],
        binding: { elementId: diamond.id, focus: -0.93, gap: 12.2 },
      },
      {
        name: 'R4',
        target: diamond,
        endpoint: 'end' as const,
        points: [
          { x: 207.2, y: 365.71 },
          { x: 156.53, y: 332.02 },
          { x: 164.96, y: 196.77 },
        ],
      },
      {
        name: 'R5',
        target: diamond,
        endpoint: 'end' as const,
        points: [
          { x: 188.85, y: 53.57 },
          { x: 128.41, y: 91.14 },
          { x: 102.9, y: 146.28 },
        ],
      },
      {
        name: 'R6',
        target: rectangle,
        endpoint: 'end' as const,
        points: [
          { x: 60, y: 330 },
          { x: 150, y: 260 },
          { x: 170, y: 190 },
        ],
      },
      {
        name: 'R7',
        target: rectangle,
        endpoint: 'end' as const,
        points: [
          { x: 60, y: 330 },
          { x: 150, y: 260 },
          { x: 166, y: 204 },
        ],
      },
      {
        name: 'R8',
        target: rectangle,
        endpoint: 'end' as const,
        points: [{ x: 150, y: 260 }, { x: 170, y: 190 }],
      },
    ];
    const outputs: string[] = [];
    for (const testCase of cases) {
      const origin = testCase.points[0]!;
      const arrow: BindingElement = {
        id: `r8-${testCase.name.toLowerCase()}`,
        type: 'arrow',
        x: origin.x,
        y: origin.y,
        points: testCase.points.map((point) => [
          point.x - origin.x,
          point.y - origin.y,
        ] as [number, number]),
        endBinding: testCase.binding,
        boundElements: null,
      };
      const originalAdjacent = testCase.endpoint === 'start'
        ? testCase.points[1]!
        : testCase.points[testCase.points.length - 2]!;
      const originalEdge = testCase.endpoint === 'start'
        ? testCase.points[0]!
        : testCase.points[testCase.points.length - 1]!;
      const targetPoint = testCase.target.type === 'diamond'
        ? diamondShaftTarget(testCase.target, originalEdge, originalAdjacent)
        : rectangleShaftTarget(testCase.target, originalEdge, originalAdjacent);
      const bound = bindArrowEndpoint(arrow, testCase.target, testCase.endpoint);
      const binding = testCase.endpoint === 'start'
        ? bound.startBinding
        : bound.endBinding;
      expect(binding).not.toBeNull();
      expect(binding?.gap).toBeGreaterThanOrEqual(1);
      const boundPoints = bound.points!;
      const edgePoint = boundPoints[testCase.endpoint === 'start' ? 0 : boundPoints.length - 1]!;
      const actual = {
        x: bound.x + edgePoint[0],
        y: bound.y + edgePoint[1],
      };
      expect(distance(actual, targetPoint)).toBeLessThanOrEqual(2.5);
      for (let index = 0; index < boundPoints.length; index += 1) {
        if (index === (testCase.endpoint === 'start' ? 0 : boundPoints.length - 1)) {
          continue;
        }
        const preserved = {
          x: bound.x + boundPoints[index]![0],
          y: bound.y + boundPoints[index]![1],
        };
        if (
          (testCase.name === 'R6' || testCase.name === 'R7')
          && index === 1
        ) {
          expect(preserved).toEqual({ x: 150, y: 260 });
        } else {
          expect(distance(preserved, testCase.points[index]!)).toBeLessThanOrEqual(0.5);
        }
      }
      outputs.push(
        `${testCase.name} in=${JSON.stringify(testCase.points)} `
        + `out=${JSON.stringify(actual)} T=${JSON.stringify(targetPoint)} `
        + `binding=${JSON.stringify(binding)}`,
      );
    }
    console.log(`BINDING_R1_R8 ${outputs.join(' | ')}`);
  });

  it('measures Round 8 diamond targets across every generated case and seed', () => {
    type Stats = {
      total: number;
      bound: number;
      unbound: number;
      distances: number[];
      crossEdge: number;
      invariantFailures: number;
      interiorMovementFailures: number;
      interiorExceptions: number;
      fallbackDistances: number[];
    };
    const createStats = (): Stats => ({
      total: 0,
      bound: 0,
      unbound: 0,
      distances: [],
      crossEdge: 0,
      invariantFailures: 0,
      interiorMovementFailures: 0,
      interiorExceptions: 0,
      fallbackDistances: [],
    });
    const percentile = (values: readonly number[], fraction: number) => {
      if (values.length === 0) {
        return 0;
      }
      const sorted = [...values].sort((first, second) => first - second);
      return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
    };
    const absoluteEndpoint = (
      arrow: BindingElement,
      endpoint: 'start' | 'end',
    ) => {
      const points = arrow.points ?? [];
      const point = points[endpoint === 'start' ? 0 : points.length - 1]!;
      return { x: arrow.x + point[0], y: arrow.y + point[1] };
    };
    const failures: string[] = [];
    const run = (
      cases: readonly Round7DiamondCase[],
      label: string,
    ) => {
      const total = createStats();
      const inside = createStats();
      const short = createStats();
      for (const testCase of cases) {
        const input: BindingElement = {
          ...testCase.arrow,
          points: testCase.arrow.points?.map(([x, y]) => [x, y] as [number, number]),
        };
        const originalEdge = absoluteEndpoint(input, testCase.endpoint);
        const category = pointInsideTarget(testCase.target, originalEdge) ? inside : short;
        total.total += 1;
        category.total += 1;
        const bound = bindArrowEndpoint(input, testCase.target, testCase.endpoint);
        const binding = testCase.endpoint === 'start'
          ? bound.startBinding
          : bound.endBinding;
        if (!binding) {
          total.unbound += 1;
          category.unbound += 1;
          continue;
        }
        total.bound += 1;
        category.bound += 1;
        const actual = absoluteEndpoint(bound, testCase.endpoint);
        const targetDistance = distance(actual, testCase.targetPoint);
        total.distances.push(targetDistance);
        category.distances.push(targetDistance);
        if (targetDistance > 2.5) {
          total.fallbackDistances.push(targetDistance);
          category.fallbackDistances.push(targetDistance);
        }
        const invariant = inspectBindingInvariants(
          bound,
          testCase.target,
          testCase.endpoint,
          input,
        );
        const targetSide = nearestDiamondSide(testCase.target, testCase.targetPoint);
        const actualSide = nearestDiamondSide(testCase.target, actual);
        if (
          targetSide.index !== actualSide.index
          && targetSide.vertexDistance > 3
          && actualSide.vertexDistance > 3
        ) {
          total.crossEdge += 1;
          category.crossEdge += 1;
        }
        if (!invariant.valid) {
          total.invariantFailures += 1;
          category.invariantFailures += 1;
        }
        if (invariant.interiorPointException) {
          total.interiorExceptions += 1;
          category.interiorExceptions += 1;
        }
        if (invariant.interiorPointMovement > 0.5 && !invariant.interiorPointException) {
          total.interiorMovementFailures += 1;
          category.interiorMovementFailures += 1;
        }
      }
      const format = (stats: Stats) => (
        `total=${stats.total} bound=${stats.bound} unbound=${stats.unbound} `
        + `p50/p90/p99/max=${
          [0.5, 0.9, 0.99, 1]
            .map((fraction) => percentile(stats.distances, fraction).toFixed(2))
            .join('/')
        } cross=${stats.crossEdge} invariants=${stats.invariantFailures} `
        + `interiorMove=${stats.interiorMovementFailures} exceptions=${stats.interiorExceptions} `
        + `fallbacks=${stats.fallbackDistances.length}`
      );
      console.log(
        `BINDING_R8 ${label} all={${format(total)}} `
        + `inside={${format(inside)}} short={${format(short)}}`,
      );
      failures.push(
        ...[
          ['all', total],
          ['inside', inside],
          ['short', short],
        ].flatMap(([name, stats]) => {
          const result = stats as Stats;
          return result.invariantFailures > 0 || result.interiorMovementFailures > 0
            ? `${label}:${name}:${format(result)}`
            : [];
        }),
      );
      return total;
    };

    const realistic = run([
      ...makeRound7DiamondCases(1200, 0x7d1a_2025),
      ...makeRound7DiamondCases(1200, 0x7d1a_2027),
    ], 'realistic');
    const harsh = run([
      ...makeRound7DiamondCases(1200, 0x7d1a_2026, true, true),
      ...makeRound7DiamondCases(1200, 0x7d1a_2028, true, true),
    ], 'harsh');
    expect(realistic.unbound).toBe(0);
    expect(realistic.crossEdge).toBe(0);
    expect(percentile(realistic.distances, 0.99)).toBeLessThanOrEqual(2.5);
    expect(Math.max(...realistic.distances)).toBeLessThanOrEqual(6);
    expect(harsh.unbound).toBeLessThanOrEqual(Math.ceil(harsh.total * 0.01));
    expect(harsh.crossEdge).toBe(0);
    expect(percentile(harsh.distances, 0.99)).toBeLessThanOrEqual(6);
    expect(failures).toEqual([]);
  }, 60_000);

  it('covers the Round 9 pass-through, idempotence, and on-band repros', () => {
    type Repro = {
      name: string;
      target: BindingGeometry;
      points: Array<{ x: number; y: number }>;
      endpoint: 'start' | 'end';
      entry?: { x: number; y: number };
      binding?: AdapterBinding;
    };
    const cases: Repro[] = [
      {
        name: 'P1',
        target: {
          id: 'r9-p1',
          type: 'rectangle',
          x: 100,
          y: 100,
          width: 160,
          height: 80,
          angle: 0,
          roundness: null,
        },
        points: [{ x: 149.13, y: 1.83 }, { x: 267.79, y: 113.70 }],
        endpoint: 'end',
        entry: { x: 253.26, y: 100 },
      },
      {
        name: 'P2',
        target: {
          id: 'r9-p2',
          type: 'diamond',
          x: 100,
          y: 100,
          width: 150,
          height: 100,
          angle: -0.0439,
          roundness: null,
        },
        points: [{ x: 62.05, y: -19.76 }, { x: 112.49, y: 163.02 }],
        endpoint: 'end',
        entry: { x: 108.40, y: 148.19 },
      },
      {
        name: 'P3',
        target: {
          id: 'r9-p3',
          type: 'diamond',
          x: -80.4,
          y: 15.9,
          width: 80,
          height: 140,
          angle: 0,
          roundness: null,
        },
        points: [{ x: -34.08, y: 147.52 }, { x: -166.85, y: 157.58 }],
        endpoint: 'start',
        entry: { x: -43.93, y: 148.27 },
      },
      {
        name: 'P4',
        target: {
          id: 'r9-p4',
          type: 'diamond',
          x: 100,
          y: 100,
          width: 150,
          height: 100,
          angle: 0,
          roundness: null,
        },
        points: [{ x: 237.58, y: 35.31 }, { x: 247.21, y: 154.11 }],
        endpoint: 'end',
        entry: { x: 246.78, y: 148.78 },
      },
      {
        name: 'P5',
        target: {
          id: 'r9-p5',
          type: 'diamond',
          x: 100,
          y: 100,
          width: 150,
          height: 100,
          angle: -0.0303,
          roundness: null,
        },
        points: [
          { x: 422.19, y: 281.94 },
          { x: 360.42, y: 219.53 },
          { x: 168.67, y: 195.26 },
        ],
        endpoint: 'end',
        entry: { x: 181.80, y: 196.92 },
        binding: { elementId: 'r9-p5', focus: 0.985, gap: 14.02 },
      },
      {
        name: 'P6',
        target: {
          id: 'r9-p6',
          type: 'ellipse',
          x: 100,
          y: 100,
          width: 140,
          height: 80,
          angle: 0,
          roundness: null,
        },
        points: [{ x: 104.51, y: 155.32 }, { x: 84.34, y: 66.16 }],
        endpoint: 'start',
        entry: { x: 100.26, y: 136.55 },
        binding: { elementId: 'r9-p6', focus: -0.180, gap: 8.99 },
      },
      {
        name: 'I1',
        target: {
          id: 'r9-i1',
          type: 'ellipse',
          x: 100,
          y: 100,
          width: 140,
          height: 80,
          angle: 0.0550,
          roundness: null,
        },
        points: [{ x: 302.59, y: 131.19 }, { x: 232.34, y: 161.57 }],
        endpoint: 'end',
      },
      {
        name: 'I2',
        target: {
          id: 'r9-i2',
          type: 'ellipse',
          x: 100,
          y: 100,
          width: 140,
          height: 80,
          angle: 0,
          roundness: null,
        },
        points: [{ x: 207.67, y: 87.28 }, { x: 165.40, y: 102.15 }],
        endpoint: 'end',
      },
      {
        name: 'I3',
        target: {
          id: 'r9-i3',
          type: 'ellipse',
          x: 100,
          y: 100,
          width: 140,
          height: 80,
          angle: -0.0287,
          roundness: null,
        },
        points: [{ x: 368.36, y: 82.18 }, { x: 225.20, y: 160.81 }],
        endpoint: 'end',
      },
      {
        name: 'O1',
        target: {
          id: 'r9-o1',
          type: 'ellipse',
          x: 100,
          y: 100,
          width: 140,
          height: 80,
          angle: 0,
          roundness: null,
        },
        points: [{ x: 288.50, y: -57.42 }, { x: 180.72, y: 100.13 }],
        endpoint: 'end',
      },
      {
        name: 'O2',
        target: {
          id: 'r9-o2',
          type: 'ellipse',
          x: 100,
          y: 100,
          width: 140,
          height: 80,
          angle: 0.0314,
          roundness: null,
        },
        points: [{ x: 110.15, y: 116.97 }, { x: 37.39, y: 66.41 }],
        endpoint: 'start',
      },
    ];

    const vertices = (target: BindingGeometry) => {
      const local = target.type === 'diamond'
        ? [
            { x: target.x + Math.floor(target.width / 2) + 1, y: target.y },
            { x: target.x + target.width, y: target.y + Math.floor(target.height / 2) + 1 },
            { x: target.x + Math.floor(target.width / 2) + 1, y: target.y + target.height },
            { x: target.x, y: target.y + Math.floor(target.height / 2) + 1 },
          ]
        : [
            { x: target.x, y: target.y },
            { x: target.x + target.width, y: target.y },
            { x: target.x + target.width, y: target.y + target.height },
            { x: target.x, y: target.y + target.height },
          ];
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      return local.map((point) => rotatePoint(point, center, target.angle ?? 0));
    };
    const nearestSide = (target: BindingGeometry, point: { x: number; y: number }) => {
      const sides = vertices(target).map((first, index, all) => ({
        index,
        first,
        second: all[(index + 1) % all.length]!,
      }));
      let best = { index: 0, distance: Number.POSITIVE_INFINITY, vertexDistance: Number.POSITIVE_INFINITY };
      for (const side of sides) {
        const dx = side.second.x - side.first.x;
        const dy = side.second.y - side.first.y;
        const denominator = dx * dx + dy * dy;
        const projection = denominator < 0.000001
          ? 0
          : Math.max(0, Math.min(1, (
            (point.x - side.first.x) * dx + (point.y - side.first.y) * dy
          ) / denominator));
        const projected = {
          x: side.first.x + dx * projection,
          y: side.first.y + dy * projection,
        };
        const sideDistance = distance(point, projected);
        const vertexDistance = Math.min(
          distance(point, side.first),
          distance(point, side.second),
        );
        if (sideDistance < best.distance) {
          best = { index: side.index, distance: sideDistance, vertexDistance };
        }
      }
      return best;
    };
    const arrowFor = (testCase: Repro): BindingElement => {
      const origin = testCase.points[0]!;
      return {
        id: `arrow-${testCase.name}`,
        type: 'arrow',
        x: origin.x,
        y: origin.y,
        points: testCase.points.map((point) => [
          point.x - origin.x,
          point.y - origin.y,
        ] as [number, number]),
        ...(testCase.endpoint === 'start'
          ? { startBinding: testCase.binding ?? null }
          : { endBinding: testCase.binding ?? null }),
        boundElements: null,
      };
    };
    const endpointPoint = (arrow: BindingElement, endpoint: 'start' | 'end') => {
      const point = arrow.points?.[endpoint === 'start' ? 0 : arrow.points.length - 1];
      return point
        ? { x: arrow.x + point[0], y: arrow.y + point[1] }
        : undefined;
    };
    const bindingFor = (arrow: BindingElement, endpoint: 'start' | 'end') => (
      endpoint === 'start' ? arrow.startBinding : arrow.endBinding
    );

    for (const testCase of cases) {
      const original = arrowFor(testCase);
      const first = ensureBinding(original, testCase.target, testCase.endpoint);
      const firstBinding = bindingFor(first, testCase.endpoint);
      expect(firstBinding, testCase.name).not.toBeNull();
      if (!firstBinding) {
        continue;
      }
      expect(inspectBindingInvariants(
        first,
        testCase.target,
        testCase.endpoint,
        original,
      ).valid, testCase.name).toBe(true);
      const firstPoint = endpointPoint(first, testCase.endpoint)!;
      const stablePoint = updateBoundPoint(first, testCase.target, testCase.endpoint);
      expect(distance(firstPoint, stablePoint), `${testCase.name} on-band`).toBeLessThanOrEqual(0.5);
      const perturbedPoints = first.points!.map((point, index) => {
        const edgeIndex = testCase.endpoint === 'start' ? 0 : first.points!.length - 1;
        return index === edgeIndex
          ? [point[0] + 3, point[1] - 2] as [number, number]
          : [point[0], point[1]] as [number, number];
      });
      const perturbed = { ...first, points: perturbedPoints };
      expect(
        distance(
          updateBoundPoint(perturbed, testCase.target, testCase.endpoint),
          stablePoint,
        ),
        `${testCase.name} band crossing`,
      ).toBeLessThanOrEqual(0.01);

      if (testCase.entry) {
        const shaftEdge = testCase.endpoint === 'start'
          ? testCase.points[0]!
          : testCase.points.at(-1)!;
        const shaftAdjacent = testCase.endpoint === 'start'
          ? testCase.points[1]!
          : testCase.points.at(-2)!;
        const direction = normalizeVector({
          x: shaftEdge.x - shaftAdjacent.x,
          y: shaftEdge.y - shaftAdjacent.y,
        });
        const center = {
          x: testCase.target.x + testCase.target.width / 2,
          y: testCase.target.y + testCase.target.height / 2,
        };
        const radial = normalizeVector({
          x: testCase.entry.x - center.x,
          y: testCase.entry.y - center.y,
        });
        const cosine = Math.max(0.05, Math.abs(direction.x * radial.x + direction.y * radial.y));
        const maximum = Math.max(2.5, firstBinding.gap / cosine + 0.5);
        expect(distance(firstPoint, testCase.entry), `${testCase.name} entry`).toBeLessThanOrEqual(maximum);
        if (testCase.target.type === 'rectangle' || testCase.target.type === 'diamond') {
          const expectedSide = nearestSide(testCase.target, testCase.entry);
          const actualSide = nearestSide(testCase.target, firstPoint);
          expect(
            expectedSide.index === actualSide.index
              || expectedSide.vertexDistance <= 3
              || actualSide.vertexDistance <= 3,
            `${testCase.name} side`,
          ).toBe(true);
        }
      }

      let current = first;
      for (let call = 0; call < 2; call += 1) {
        const next = ensureBinding(current, testCase.target, testCase.endpoint);
        const nextBinding = bindingFor(next, testCase.endpoint);
        expect(nextBinding, `${testCase.name} call ${call + 2}`).not.toBeNull();
        if (!nextBinding) {
          continue;
        }
        expect(Math.abs(nextBinding.focus - firstBinding.focus), `${testCase.name} focus`).toBeLessThanOrEqual(0.0001);
        expect(Math.abs(nextBinding.gap - firstBinding.gap), `${testCase.name} gap`).toBeLessThanOrEqual(0.0001);
        expect(next.points).toHaveLength(first.points!.length);
        expect(
          distance(endpointPoint(next, testCase.endpoint)!, endpointPoint(current, testCase.endpoint)!),
          `${testCase.name} endpoint call ${call + 2}`,
        ).toBeLessThanOrEqual(0.01);
        current = next;
      }
    }
  });

  it('stress-tests Round 9 bindings across seeded realistic, variety, and harsh families', () => {
    type Family = 'realistic' | 'variety' | 'harsh';
    type Point = { x: number; y: number };
    type ShapeKind = 'rectangle' | 'diamond' | 'ellipse';
    type Side = {
      index: number;
      distance: number;
      vertexDistance: number;
      normal: Point;
    };
    type FamilyStats = {
      total: number;
      skipped: number;
      bound: number;
      unbound: number;
      agreementFailures: number;
      wrongSide: number;
      offBand: number;
      idempotence: number;
      entryFailures: number;
      interiorMoved: number;
      interiorExceptions: number;
      interiorMax: number;
      entryDistances: number[];
      byShape: Record<ShapeKind, { total: number; unbound: number }>;
      byMode: Record<string, { total: number; unbound: number }>;
      durations: number[];
      examples: string[];
    };

    const configuredCases = Number(process.env.DRAWIT_BINDING_STRESS_N ?? 500);
    const configuredSeeds = process.env.DRAWIT_BINDING_STRESS_SEEDS
      ?.split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));
    const seeds = configuredSeeds?.length
      ? configuredSeeds
      : [0x91e10da, 0x91e10db];
    expect(Number.isInteger(configuredCases) && configuredCases > 0).toBe(true);
    expect(seeds.length).toBeGreaterThan(0);
    const casesPerSeed = configuredCases;

    const createStats = (): FamilyStats => ({
      total: 0,
      skipped: 0,
      bound: 0,
      unbound: 0,
      agreementFailures: 0,
      wrongSide: 0,
      offBand: 0,
      idempotence: 0,
      entryFailures: 0,
      interiorMoved: 0,
      interiorExceptions: 0,
      interiorMax: 0,
      entryDistances: [],
      byShape: {
        rectangle: { total: 0, unbound: 0 },
        diamond: { total: 0, unbound: 0 },
        ellipse: { total: 0, unbound: 0 },
      },
      byMode: {},
      durations: [],
      examples: [],
    });

    const randomFor = (seed: number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    };
    const randomBetween = (random: () => number, minimum: number, maximum: number) => (
      minimum + (maximum - minimum) * random()
    );
    const dot = (first: Point, second: Point) => first.x * second.x + first.y * second.y;
    const pointToSegment = (point: Point, first: Point, second: Point) => {
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const denominator = dx * dx + dy * dy;
      const projection = denominator < 0.000001
        ? 0
        : Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / denominator));
      return distance(point, {
        x: first.x + dx * projection,
        y: first.y + dy * projection,
      });
    };
    const vertices = (target: BindingGeometry) => target.type === 'diamond'
      ? [
          { x: target.x + Math.floor(target.width / 2) + 1, y: target.y },
          { x: target.x + target.width, y: target.y + Math.floor(target.height / 2) + 1 },
          { x: target.x + Math.floor(target.width / 2) + 1, y: target.y + target.height },
          { x: target.x, y: target.y + Math.floor(target.height / 2) + 1 },
        ]
      : [
          { x: target.x, y: target.y },
          { x: target.x + target.width, y: target.y },
          { x: target.x + target.width, y: target.y + target.height },
          { x: target.x, y: target.y + target.height },
        ];
    const nearestSide = (target: BindingGeometry, point: Point): Side => {
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const rotated = vertices(target).map((vertex) => rotatePoint(vertex, center, target.angle ?? 0));
      let best: Side = {
        index: 0,
        distance: Number.POSITIVE_INFINITY,
        vertexDistance: Number.POSITIVE_INFINITY,
        normal: { x: 1, y: 0 },
      };
      for (let index = 0; index < rotated.length; index += 1) {
        const first = rotated[index]!;
        const second = rotated[(index + 1) % rotated.length]!;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const denominator = dx * dx + dy * dy;
        const projection = denominator < 0.000001
          ? 0
          : Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / denominator));
        const projected = {
          x: first.x + dx * projection,
          y: first.y + dy * projection,
        };
        const sideDistance = distance(point, projected);
        if (sideDistance < best.distance) {
          best = {
            index,
            distance: sideDistance,
            vertexDistance: Math.min(distance(point, first), distance(point, second)),
            normal: normalizeVector({ x: dy, y: -dx }),
          };
        }
      }
      return best;
    };
    const nearestVertex = (target: BindingGeometry, point: Point) => {
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const rotated = vertices(target).map((vertex) => rotatePoint(vertex, center, target.angle ?? 0));
      let index = 0;
      let vertexDistance = Number.POSITIVE_INFINITY;
      for (let vertexIndex = 0; vertexIndex < rotated.length; vertexIndex += 1) {
        const candidateDistance = distance(point, rotated[vertexIndex]!);
        if (candidateDistance < vertexDistance) {
          index = vertexIndex;
          vertexDistance = candidateDistance;
        }
      }
      const vertex = rotated[index]!;
      const previous = rotated[(index + rotated.length - 1) % rotated.length]!;
      const next = rotated[(index + 1) % rotated.length]!;
      const first = normalizeVector({ x: previous.x - vertex.x, y: previous.y - vertex.y });
      const second = normalizeVector({ x: next.x - vertex.x, y: next.y - vertex.y });
      return {
        index,
        vertexDistance,
        interiorAngle: Math.acos(Math.max(-1, Math.min(1, dot(first, second)))),
      };
    };
    const outlineDistance = (target: BindingGeometry, point: Point) => {
      if (target.type === 'ellipse') {
        const center = {
          x: target.x + target.width / 2,
          y: target.y + target.height / 2,
        };
        const local = rotatePoint(point, center, -(target.angle ?? 0));
        const dx = local.x - center.x;
        const dy = local.y - center.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.000001) {
          return Math.min(target.width, target.height) / 2;
        }
        const unit = { x: dx / length, y: dy / length };
        const radius = 1 / Math.sqrt(
          (unit.x / (target.width / 2)) ** 2
          + (unit.y / (target.height / 2)) ** 2,
        );
        return Math.abs(length - radius);
      }
      const all = vertices(target);
      return Math.min(...all.map((first, index) => (
        pointToSegment(point, rotatePoint(first, {
          x: target.x + target.width / 2,
          y: target.y + target.height / 2,
        }, target.angle ?? 0), rotatePoint(all[(index + 1) % all.length]!, {
          x: target.x + target.width / 2,
          y: target.y + target.height / 2,
        }, target.angle ?? 0))
      )));
    };
    const entryForRay = (target: BindingGeometry, adjacent: Point, edge: Point, direction: Point) => {
      const travel = distance(adjacent, edge) + 50;
      let previous = adjacent;
      let previousInside = pointInsideTarget(target, previous);
      for (let step = 1; step <= Math.ceil(travel / 0.25); step += 1) {
        const currentTravel = Math.min(travel, step * 0.25);
        const current = {
          x: adjacent.x + direction.x * currentTravel,
          y: adjacent.y + direction.y * currentTravel,
        };
        const currentInside = pointInsideTarget(target, current);
        if (!previousInside && currentInside) {
          let outside = previous;
          let inside = current;
          for (let iteration = 0; iteration < 40; iteration += 1) {
            const middle = {
              x: (outside.x + inside.x) / 2,
              y: (outside.y + inside.y) / 2,
            };
            if (pointInsideTarget(target, middle)) {
              inside = middle;
            } else {
              outside = middle;
            }
          }
          return inside;
        }
        previous = current;
        previousInside = currentInside;
      }
      return undefined;
    };
    const normalAtEntry = (target: BindingGeometry, entry: Point) => {
      if (target.type !== 'ellipse') {
        return nearestSide(target, entry).normal;
      }
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const local = rotatePoint(entry, center, -(target.angle ?? 0));
      return rotateVector(normalizeVector({
        x: (local.x - center.x) / (target.width / 2) ** 2,
        y: (local.y - center.y) / (target.height / 2) ** 2,
      }), target.angle ?? 0);
    };
    const endpointPoint = (arrow: BindingElement, endpoint: 'start' | 'end'): Point | undefined => {
      const point = arrow.points?.[endpoint === 'start' ? 0 : arrow.points.length - 1];
      return point
        ? { x: arrow.x + point[0], y: arrow.y + point[1] }
        : undefined;
    };
    const endpointBinding = (arrow: BindingElement, endpoint: 'start' | 'end') => (
      endpoint === 'start' ? arrow.startBinding : arrow.endBinding
    );
    const percentile = (values: readonly number[], fraction: number) => {
      if (values.length === 0) {
        return 0;
      }
      const sorted = [...values].sort((first, second) => first - second);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
    };
    const recordFailure = (
      stats: FamilyStats,
      reason: string,
      arrow: BindingElement,
      target: BindingGeometry,
      result: BindingElement | undefined,
      entry: Point | undefined,
    ) => {
      if (stats.examples.length >= 3) {
        return;
      }
      const stressMetadata = arrow.customData as { stress?: { endpoint?: string } } | undefined;
      stats.examples.push(JSON.stringify({
        reason,
        target,
        origin: { x: arrow.x, y: arrow.y },
        points: arrow.points,
        metadata: arrow.customData,
        endpoint: stressMetadata?.stress?.endpoint ?? 'unknown',
        preBinding: arrow.startBinding ?? arrow.endBinding,
        result: result?.points,
        resultBinding: result?.startBinding ?? result?.endBinding,
        entry,
      }));
    };
    const familySeed: Record<Family, number> = {
      realistic: 0x13579bdf,
      variety: 0x2468ace0,
      harsh: 0x31415926,
    };
    const runFamily = (family: Family): FamilyStats => {
      const stats = createStats();
      for (const seed of seeds) {
        const random = randomFor((seed + familySeed[family]) >>> 0);
        for (let index = 0; index < casesPerSeed; index += 1) {
          const shapeChoice = random();
          const shape: ShapeKind = shapeChoice < 1 / 3
            ? 'rectangle'
            : shapeChoice < 2 / 3
              ? 'diamond'
              : 'ellipse';
          const target: BindingGeometry = {
            id: `r10-${family}-${seed}-${index}`,
            type: shape,
            x: randomBetween(random, -220, 1000),
            y: randomBetween(random, -160, 640),
            width: randomBetween(random, 61, 240),
            height: randomBetween(random, 41, 160),
            angle: family === 'realistic'
              ? random() < 0.7 ? 0 : randomBetween(random, -0.06, 0.06)
              : randomBetween(random, -Math.PI, Math.PI),
            roundness: shape === 'rectangle' && random() < 0.5
              ? { type: 'proportional-radius' }
              : null,
          };
          const center = {
            x: target.x + target.width / 2,
            y: target.y + target.height / 2,
          };
          let boundary: Point;
          let outward: Point;
          if (shape === 'ellipse') {
            const theta = randomBetween(random, -Math.PI, Math.PI);
            const localBoundary = {
              x: center.x + target.width / 2 * Math.cos(theta),
              y: center.y + target.height / 2 * Math.sin(theta),
            };
            boundary = rotatePoint(localBoundary, center, target.angle ?? 0);
            outward = rotateVector(normalizeVector({
              x: Math.cos(theta) / (target.width / 2),
              y: Math.sin(theta) / (target.height / 2),
            }), target.angle ?? 0);
          } else {
            const unrotated = vertices(target);
            const sideIndex = Math.floor(random() * 4);
            const first = unrotated[sideIndex]!;
            const second = unrotated[(sideIndex + 1) % 4]!;
            let position = random();
            if (family === 'realistic') {
              position = randomBetween(random, 0.1, 0.9);
            } else if (family === 'harsh' && random() < 0.5) {
              position = random() < 0.5
                ? randomBetween(random, 0, 0.1)
                : randomBetween(random, 0.9, 1);
            }
            const localBoundary = {
              x: first.x + (second.x - first.x) * position,
              y: first.y + (second.y - first.y) * position,
            };
            boundary = rotatePoint(localBoundary, center, target.angle ?? 0);
            outward = rotateVector(normalizeVector({
              x: second.y - first.y,
              y: -(second.x - first.x),
            }), target.angle ?? 0);
          }
          const phiMax = family === 'realistic' ? 30 : family === 'variety' ? 55 : 80;
          const phi = randomBetween(random, -phiMax, phiMax) * Math.PI / 180;
          const direction = rotateVector({ x: -outward.x, y: -outward.y }, phi);
          const passThroughProbability = family === 'realistic'
            ? 0
            : family === 'variety' ? 0.25 : 0.4;
          const passThrough = random() < passThroughProbability;
          const depth = passThrough
            ? Math.max(target.width, target.height) * randomBetween(random, 1.1, 1.8)
              + randomBetween(random, 0, 20)
            : randomBetween(random, -6, 20);
          const mode = passThrough ? 'passThrough' : depth < 0 ? 'short' : 'inside';
          stats.byMode[mode] ??= { total: 0, unbound: 0 };
          stats.byMode[mode].total += 1;
          stats.total += 1;
          stats.byShape[shape].total += 1;
          const shaftLength = randomBetween(random, 30, 200);
          const adjacent = {
            x: boundary.x - direction.x * shaftLength,
            y: boundary.y - direction.y * shaftLength,
          };
          const edge = {
            x: boundary.x + direction.x * depth,
            y: boundary.y + direction.y * depth,
          };
          const perpendicular = { x: -direction.y, y: direction.x };
          const back = randomBetween(random, 20, 80);
          const lateral = randomBetween(random, -60, 60);
          const previous = {
            x: adjacent.x - direction.x * back + perpendicular.x * lateral,
            y: adjacent.y - direction.y * back + perpendicular.y * lateral,
          };
          const endpoint = random() < 0.5 ? 'start' : 'end';
          const pointCount = random() < 0.4 ? 3 : 2;
          const absolutePoints = endpoint === 'end'
            ? pointCount === 3 ? [previous, adjacent, edge] : [adjacent, edge]
            : pointCount === 3 ? [edge, adjacent, previous] : [edge, adjacent];
          const origin = absolutePoints[0]!;
          const preBinding = random() < 0.3
            ? {
                elementId: target.id,
                focus: randomBetween(random, -1, 1),
                gap: randomBetween(random, 0.5, 20),
              }
            : null;
          const arrow: BindingElement = {
            id: `r10-arrow-${family}-${seed}-${index}`,
            type: 'arrow',
            x: origin.x,
            y: origin.y,
            points: absolutePoints.map((point) => [
              point.x - origin.x,
              point.y - origin.y,
            ] as [number, number]),
            ...(endpoint === 'start'
              ? { startBinding: preBinding }
              : { endBinding: preBinding }),
            customData: {
              stress: { adjacent, edge, boundary, direction, depth, mode, endpoint },
            },
            boundElements: null,
          };
          const stabilized = stabilizeBinding(arrow, target, endpoint);
          if (stabilized.binding) {
            const stabilizedArrow: BindingElement = {
              ...arrow,
              points: stabilized.points,
              ...(endpoint === 'start'
                ? { startBinding: stabilized.binding }
                : { endBinding: stabilized.binding }),
            };
            const invariant = inspectBindingInvariants(
              stabilizedArrow,
              target,
              endpoint,
              arrow,
            );
            if (!invariant.valid) {
              stats.agreementFailures += 1;
              recordFailure(stats, 'stabilize-agreement', arrow, target, stabilizedArrow, undefined);
            }
          }
          const entry = entryForRay(target, adjacent, edge, direction);
          if (!entry) {
            stats.skipped += 1;
            continue;
          }
          const started = performance.now();
          const first = ensureBinding(arrow, target, endpoint);
          stats.durations.push(performance.now() - started);
          const binding = endpointBinding(first, endpoint);
          if (!binding) {
            stats.unbound += 1;
            stats.byShape[shape].unbound += 1;
            stats.byMode[mode].unbound += 1;
            continue;
          }
          stats.bound += 1;
          const firstPoint = endpointPoint(first, endpoint)!;
          const originalEdge = endpointPoint(arrow, endpoint)!;
          const adjacentIndex = endpoint === 'start' ? 1 : arrow.points!.length - 2;
          const edgeIndex = endpoint === 'start' ? 0 : arrow.points!.length - 1;
          const originalAdjacent = endpoint === 'start'
            ? endpointPoint({ ...arrow, points: [arrow.points![1]!] }, 'start')!
            : endpointPoint({ ...arrow, points: [arrow.points![arrow.points!.length - 2]!] }, 'start')!;
          const adjacentMayMove = pointInsideTarget(target, originalAdjacent)
            || outlineDistance(target, originalAdjacent) <= 1
            || distance(originalEdge, originalAdjacent) < 10.05;
          for (let pointIndex = 0; pointIndex < arrow.points!.length; pointIndex += 1) {
            if (pointIndex === edgeIndex) {
              continue;
            }
            const originalPoint = arrow.points![pointIndex]!;
            const resultPoint = first.points![pointIndex]!;
            const movement = Math.hypot(
              first.x + resultPoint[0] - (arrow.x + originalPoint[0]),
              first.y + resultPoint[1] - (arrow.y + originalPoint[1]),
            );
            stats.interiorMax = Math.max(stats.interiorMax, movement);
            if (movement > 0.5) {
              if (pointIndex === adjacentIndex && adjacentMayMove) {
                stats.interiorExceptions += 1;
              } else {
                stats.interiorMoved += 1;
                recordFailure(stats, 'interior-movement', arrow, target, first, entry);
              }
            }
          }
          const stable = updateBoundPoint(first, target, endpoint);
          const perturbedPoints = first.points!.map((point, pointIndex) => (
            pointIndex === edgeIndex
              ? [point[0] + 3, point[1] - 2] as [number, number]
              : [point[0], point[1]] as [number, number]
          ));
          const perturbed: BindingElement = { ...first, points: perturbedPoints };
          const perturbedStable = updateBoundPoint(perturbed, target, endpoint);
          if (
            distance(firstPoint, stable) > 0.5
            || distance(perturbedStable, stable) > 0.01
          ) {
            stats.offBand += 1;
            recordFailure(stats, 'on-band', arrow, target, first, entry);
          }
          const next = ensureBinding(first, target, endpoint);
          const final = ensureBinding(next, target, endpoint);
          const nextBinding = endpointBinding(next, endpoint);
          const finalBinding = endpointBinding(final, endpoint);
          const nextPoint = endpointPoint(next, endpoint);
          const finalPoint = endpointPoint(final, endpoint);
          if (
            !nextBinding
            || !finalBinding
            || nextBinding.elementId !== binding.elementId
            || finalBinding.elementId !== binding.elementId
            || Math.abs(nextBinding.focus - binding.focus) > 0.0001
            || Math.abs(finalBinding.focus - binding.focus) > 0.0001
            || Math.abs(nextBinding.gap - binding.gap) > 0.0001
            || Math.abs(finalBinding.gap - binding.gap) > 0.0001
            || !nextPoint
            || !finalPoint
            || distance(nextPoint, firstPoint) > 0.01
            || distance(finalPoint, nextPoint) > 0.01
            || next.points?.length !== first.points?.length
            || final.points?.length !== first.points?.length
          ) {
            stats.idempotence += 1;
            recordFailure(stats, 'idempotence', arrow, target, final, entry);
          }
          const entryNormal = normalAtEntry(target, entry);
          const cosine = Math.max(0.05, -dot(direction, entryNormal));
          // 2.5 px is the implementation's own MAX_BINDING_TARGET_DISTANCE allowance from the gap-band crossing.
          let entryLimit = Math.max(3.5, (binding.gap + 0.5) / cosine + 2.5);
          if (shape !== 'ellipse') {
            const vertex = nearestVertex(target, entry);
            if (vertex.vertexDistance <= 6) {
              entryLimit += binding.gap / Math.max(0.05, Math.sin(vertex.interiorAngle / 2));
            }
          }
          const entryDistance = distance(firstPoint, entry);
          stats.entryDistances.push(entryDistance);
          if (entryDistance > entryLimit) {
            stats.entryFailures += 1;
            recordFailure(
              stats,
              `entry d=${entryDistance.toFixed(3)} limit=${entryLimit.toFixed(3)} `
                + `cos=${cosine.toFixed(3)} vertex=${shape === 'ellipse' ? 'ellipse' : nearestVertex(target, entry).vertexDistance.toFixed(3)}`,
              arrow,
              target,
              first,
              entry,
            );
          }
          if (shape !== 'ellipse') {
            const expectedSide = nearestSide(target, entry);
            const actualSide = nearestSide(target, firstPoint);
            if (
              expectedSide.index !== actualSide.index
              && expectedSide.vertexDistance > 3
              && actualSide.vertexDistance > 3
            ) {
              stats.wrongSide += 1;
              recordFailure(stats, 'wrong-side', arrow, target, first, entry);
            }
          }
        }
      }
      return stats;
    };
    const summarize = (family: Family, stats: FamilyStats) => {
      const shapeSummary = Object.entries(stats.byShape)
        .map(([shape, value]) => `${shape}=${value.unbound}/${value.total}`)
        .join(',');
      const modeSummary = Object.entries(stats.byMode)
        .map(([mode, value]) => `${mode}=${value.unbound}/${value.total}`)
        .join(',');
      console.log(
        `R9_SEEDED ${family} total=${stats.total} skipped=${stats.skipped} `
        + `bound=${stats.bound} unbound=${stats.unbound} agreement=${stats.agreementFailures} `
        + `wrongSide=${stats.wrongSide} offBand=${stats.offBand} idempotence=${stats.idempotence} `
        + `entryFailures=${stats.entryFailures} interiorMoved=${stats.interiorMoved} `
        + `exceptions=${stats.interiorExceptions} interiorMax=${stats.interiorMax.toFixed(2)} `
        + `entryMax=${(stats.entryDistances.length ? Math.max(...stats.entryDistances) : 0).toFixed(2)} `
        + `p50/p95=${percentile(stats.durations, 0.5).toFixed(3)}/`
        + `${percentile(stats.durations, 0.95).toFixed(3)}ms `
        + `byShape=${shapeSummary} byMode=${modeSummary}`,
      );
    };
    const results = (['realistic', 'variety', 'harsh'] as const).map((family) => ({
      family,
      stats: runFamily(family),
    }));
    const failures: string[] = [];
    for (const { family, stats } of results) {
      summarize(family, stats);
      const failureDetails = stats.examples.join('\n');
      if (stats.agreementFailures !== 0) {
        failures.push(`${family} R9-4 agreement=${stats.agreementFailures}\n${failureDetails}`);
      }
      if (stats.skipped > Math.ceil(stats.total * 0.01)) {
        failures.push(`${family} skipped=${stats.skipped}`);
      }
      if (stats.wrongSide !== 0) {
        failures.push(`${family} wrong-side=${stats.wrongSide}\n${failureDetails}`);
      }
      if (stats.offBand !== 0) {
        failures.push(`${family} off-band=${stats.offBand}\n${failureDetails}`);
      }
      if (stats.idempotence !== 0) {
        failures.push(`${family} idempotence=${stats.idempotence}\n${failureDetails}`);
      }
      if (stats.entryFailures !== 0) {
        failures.push(`${family} entry=${stats.entryFailures}\n${failureDetails}`);
      }
      if (stats.interiorMoved !== 0) {
        failures.push(`${family} interior-movement=${stats.interiorMoved}\n${failureDetails}`);
      }
      if (family !== 'harsh') {
        if (stats.unbound !== 0) {
          failures.push(`${family} unbound=${stats.unbound}`);
        }
      }
      if (family === 'harsh') {
        for (const [shape, value] of Object.entries(stats.byShape)) {
          if (value.unbound > Math.ceil(value.total * 0.01)) {
            failures.push(`${family} ${shape} unbound=${value.unbound}/${value.total}`);
          }
        }
      }
    }
    expect(results).toHaveLength(3);
    expect(failures).toEqual([]);
  }, 180_000);

  it('keeps the reviewer vertex strokes bound through CanvasAdapter conversion', () => {
    const plan = recognizeDiagram({
      strokes: [
        {
          id: 'source',
          points: [
            { x: 470, y: 215 },
            { x: 625, y: 215 },
            { x: 625, y: 285 },
            { x: 470, y: 285 },
            { x: 470, y: 215 },
          ],
        },
        {
          id: 'decision',
          points: [
            { x: 790, y: 193 },
            { x: 867, y: 250 },
            { x: 790, y: 307 },
            { x: 713, y: 250 },
            { x: 790, y: 193 },
          ],
        },
        {
          id: 'destination',
          points: [
            { x: 739, y: 428 },
            { x: 901, y: 428 },
            { x: 901, y: 513 },
            { x: 739, y: 513 },
            { x: 739, y: 428 },
          ],
        },
        {
          id: 'hook-a',
          points: [
            { x: 624.3, y: 250.3 },
            { x: 628.3, y: 249.7 },
            { x: 631.9, y: 249.8 },
            { x: 640, y: 250.7 },
            { x: 656.7, y: 250.9 },
            { x: 672, y: 250.5 },
            { x: 688.4, y: 250.2 },
            { x: 704.6, y: 250.1 },
            { x: 709.6, y: 249.6 },
            { x: 704.6, y: 246.9 },
            { x: 700.8, y: 243.7 },
            { x: 697.2, y: 241 },
          ],
        },
        {
          id: 'v-b',
          points: [
            { x: 790.9, y: 310.1 },
            { x: 791.6, y: 315.5 },
            { x: 791.8, y: 320.6 },
            { x: 791.9, y: 325.6 },
            { x: 791.9, y: 331.1 },
            { x: 791.7, y: 336.3 },
            { x: 791.5, y: 341.4 },
            { x: 790.3, y: 347 },
            { x: 790.9, y: 352.1 },
            { x: 789.6, y: 357.5 },
            { x: 789.5, y: 362.2 },
            { x: 789.6, y: 367.2 },
            { x: 789.1, y: 372.4 },
            { x: 788.8, y: 377.8 },
            { x: 788.9, y: 383.3 },
            { x: 788.7, y: 388.4 },
            { x: 788, y: 393.5 },
            { x: 788.4, y: 398.2 },
            { x: 788.5, y: 403.3 },
            { x: 789.2, y: 409.3 },
            { x: 790, y: 414 },
            { x: 789.6, y: 419.7 },
            { x: 790.6, y: 424.4 },
            { x: 790.4, y: 430.3 },
            { x: 787.9, y: 427.3 },
            { x: 785.7, y: 425.7 },
            { x: 783.5, y: 423.1 },
            { x: 782.3, y: 420.6 },
            { x: 780.4, y: 417.8 },
            { x: 785.6, y: 420.5 },
            { x: 787.6, y: 425.8 },
            { x: 790.7, y: 429.9 },
            { x: 790.7, y: 427.6 },
            { x: 792.9, y: 425.2 },
            { x: 795.4, y: 423.1 },
            { x: 797.6, y: 420.3 },
            { x: 795.4, y: 423.1 },
            { x: 799.1, y: 417.7 },
          ],
        },
      ],
      texts: [],
    });
    const connectors = plan.items.filter((item) => item.kind === 'connector');
    expect(connectors).toHaveLength(2);

    let scene: readonly AdapterTestElement[] = [];
    const api = {
      setActiveTool: () => undefined,
      getSceneElementsIncludingDeleted: () => scene,
      getAppState: () => ({ selectedElementIds: {} }),
      getFiles: () => ({}),
      updateScene: ({ elements }: { elements: readonly AdapterTestElement[] }) => {
        scene = elements;
      },
    } as never;
    const adapter = new CanvasAdapter(api);
    const adapterInternals = adapter as unknown as {
      showPlan: (
        nextPlan: SuggestionPlan,
        currentElements: readonly never[],
      ) => void;
    };
    adapterInternals.showPlan(plan, []);

    const live = scene.filter((element) => element.isDeleted !== true);
    const byPlanId = new Map<string, AdapterTestElement>(
      live.flatMap((element): [string, AdapterTestElement][] => {
        const planItemId = element.customData?.planItemId;
        return typeof planItemId === 'string' ? [[planItemId, element]] : [];
      }),
    );
    const arrows = live.filter((element) => element.type === 'arrow');
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) {
      const points = arrow.points as readonly [number, number][];
      for (const endpoint of ['start', 'end'] as const) {
        const binding = arrow[`${endpoint}Binding`] as {
          elementId: string;
          focus: number;
          gap: number;
        } | null | undefined;
        if (!binding) {
          continue;
        }
        expect(binding.gap).toBeGreaterThanOrEqual(1);
        expect(Math.abs(binding.focus)).toBeLessThanOrEqual(1);
        const target = live.find((element) => element.id === binding.elementId)!;
        expect(target.boundElements).toContainEqual({ id: arrow.id, type: 'arrow' });
        const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
        const edge = points[edgeIndex]!;
        const adjacent = endpoint === 'start'
          ? points[1]!
          : points[points.length - 2]!;
        const recomputed = updateBoundPoint(
          {
            ...arrow,
            points,
            x: arrow.x as number,
            y: arrow.y as number,
          },
          target as unknown as BindingGeometry,
          endpoint,
        );
        expect(distance(
          { x: (arrow.x as number) + edge[0], y: (arrow.y as number) + edge[1] },
          recomputed,
        )).toBeLessThanOrEqual(0.5);
        expect(distance(
          { x: (arrow.x as number) + adjacent[0], y: (arrow.y as number) + adjacent[1] },
          recomputed,
        )).toBeGreaterThanOrEqual(10);
      }
    }

    for (const connector of connectors) {
      const converted = byPlanId.get(connector.id);
      expect(converted).toBeDefined();
      if (!converted || converted.type !== 'arrow') {
        continue;
      }
      for (const endpoint of ['start', 'end'] as const) {
        const ref = connector[endpoint];
        if (!ref || !('itemId' in ref)) {
          continue;
        }
        const target = byPlanId.get(ref.itemId);
        const binding = converted[`${endpoint}Binding`] as { elementId?: string } | null | undefined;
        if (binding) {
          expect(binding.elementId).toBe(target?.id);
        }
      }
    }
    const hook = connectors.find((item) => item.sourceIds.includes('hook-a'));
    const vertexExit = connectors.find((item) => item.sourceIds.includes('v-b'));
    expect(hook).toBeDefined();
    expect(vertexExit).toBeDefined();
    if (hook?.end && 'itemId' in hook.end && vertexExit?.start && 'itemId' in vertexExit.start) {
      const decision = byPlanId.get(hook.end.itemId);
      const hookElement = byPlanId.get(hook.id);
      const exitElement = byPlanId.get(vertexExit.id);
      expect((hookElement?.endBinding as { elementId?: string } | undefined)?.elementId)
        .toBe(decision?.id);
      expect((exitElement?.startBinding as { elementId?: string } | undefined)?.elementId)
        .toBe(decision?.id);
    }
  });

  it('keeps a hand-drawn rectangle touch point through recognition and adapter conversion', () => {
    const sampleLine = (
      first: { x: number; y: number },
      second: { x: number; y: number },
      step = 3,
    ) => {
      const length = Math.hypot(second.x - first.x, second.y - first.y);
      const count = Math.ceil(length / step);
      return Array.from({ length: count + 1 }, (_unused, index) => {
        const ratio = index / count;
        return {
          x: first.x + (second.x - first.x) * ratio,
          y: first.y + (second.y - first.y) * ratio,
        };
      });
    };
    const rectangle = [
      ...sampleLine({ x: 745, y: 435 }, { x: 895, y: 435 }),
      ...sampleLine({ x: 895, y: 435 }, { x: 895, y: 505 }).slice(1),
      ...sampleLine({ x: 895, y: 505 }, { x: 745, y: 505 }).slice(1),
      ...sampleLine({ x: 745, y: 505 }, { x: 745, y: 435 }).slice(1),
    ];
    const connector = [
      ...sampleLine({ x: 790, y: 350 }, { x: 790, y: 433 }),
      { x: 782, y: 423 },
      { x: 790, y: 433 },
      { x: 798, y: 423 },
    ];
    const plan = recognizeDiagram({
      strokes: [
        { id: 'hand-drawn-rectangle', points: rectangle },
        { id: 'hand-drawn-connector', points: connector },
      ],
      texts: [],
    });
    const shape = plan.items.find((item) => item.kind === 'shape');
    const edge = plan.items.find((item) => item.kind === 'connector');
    expect(shape).toBeDefined();
    expect(edge).toBeDefined();
    if (!shape || shape.kind !== 'shape' || !edge || edge.kind !== 'connector') {
      return;
    }
    expect(Math.abs(shape.x - 745)).toBeLessThanOrEqual(4);
    expect(Math.abs(shape.x + shape.width - 895)).toBeLessThanOrEqual(4);
    expect(Math.abs(shape.y - 435)).toBeLessThanOrEqual(4);
    expect(Math.abs(shape.y + shape.height - 505)).toBeLessThanOrEqual(4);
    expect(edge.end && 'itemId' in edge.end ? edge.end.itemId : undefined)
      .toBe(shape.id);

    let scene: AdapterTestElement[] = [
      {
        id: 'hand-drawn-rectangle',
        type: 'freedraw',
        x: 0,
        y: 0,
        points: rectangle.map(({ x, y }) => [x, y] as [number, number]),
      },
      {
        id: 'hand-drawn-connector',
        type: 'freedraw',
        x: 0,
        y: 0,
        points: connector.map(({ x, y }) => [x, y] as [number, number]),
      },
    ];
    const api = {
      setActiveTool: () => undefined,
      getSceneElementsIncludingDeleted: () => scene,
      getAppState: () => ({ selectedElementIds: {} }),
      getFiles: () => ({}),
      updateScene: ({ elements }: { elements: readonly AdapterTestElement[] }) => {
        scene = [...elements];
      },
    } as never;
    const adapter = new CanvasAdapter(api);
    const internals = adapter as unknown as {
      showPlan: (
        nextPlan: SuggestionPlan,
        currentElements: readonly never[],
      ) => void;
    };
    internals.showPlan(plan, scene as never[]);

    const convertedShape = scene.find((element) => (
      element.customData?.planItemId === shape.id && element.type === 'rectangle'
    ));
    const convertedArrow = scene.find((element) => (
      element.customData?.planItemId === edge.id && element.type === 'arrow'
    ));
    expect(convertedShape).toBeDefined();
    expect(convertedArrow).toBeDefined();
    if (!convertedShape || !convertedArrow) {
      return;
    }
    const binding = convertedArrow.endBinding;
    expect(binding?.elementId).toBe(convertedShape.id);
    expect(binding?.gap).toBeGreaterThan(0);
    expect(convertedShape.boundElements).toContainEqual({
      id: convertedArrow.id,
      type: 'arrow',
    });
    const points = convertedArrow.points ?? [];
    const end = points[points.length - 1];
    expect(end).toBeDefined();
    if (!end) {
      return;
    }
    const absoluteEnd = {
      x: (convertedArrow.x ?? 0) + end[0],
      y: (convertedArrow.y ?? 0) + end[1],
    };
    expect(Math.hypot(absoluteEnd.x - 790, absoluteEnd.y - 435)).toBeLessThanOrEqual(4);
    const recomputed = updateBoundPoint(
      convertedArrow as unknown as BindingElement,
      convertedShape as unknown as BindingGeometry,
      'end',
    );
    expect(Math.hypot(absoluteEnd.x - recomputed.x, absoluteEnd.y - recomputed.y))
      .toBeLessThanOrEqual(0.5);
  });

  it('removes one-sided arrow references while preserving mutual bindings', () => {
    const target: BindingGeometry = {
      id: 'target',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 120,
      height: 80,
    };
    const arrow = {
      id: 'arrow',
      type: 'arrow',
      x: 0,
      y: 140,
      points: [[0, 0], [100, 0]] as readonly [number, number][],
      boundElements: null,
    };
    const bound = bindArrowEndpoint(arrow, target, 'end');
    const elements = synchronizeBindingMutuality([
      {
        ...targetElement(target),
        boundElements: [
          { id: 'arrow', type: 'arrow' },
          { id: 'stale', type: 'arrow' },
          { id: 'label', type: 'text' },
        ],
      },
      { ...bound, endBinding: null },
    ]);
    const liveTarget = elements.find((element) => element.id === target.id)!;
    expect(liveTarget.boundElements).toEqual([{ id: 'label', type: 'text' }]);
  });

  it('converges preview and applied arrow endpoints to the same geometry', () => {
    const plan: SuggestionPlan = {
      version: 1,
      lens: 'diagram',
      tier: 't0',
      items: [
        {
          id: 'source-node',
          kind: 'shape',
          shape: 'rectangle',
          x: 100,
          y: 100,
          width: 120,
          height: 80,
          sourceIds: ['source-stroke'],
          label: 'Source',
        },
        {
          id: 'target-node',
          kind: 'shape',
          shape: 'ellipse',
          x: 360,
          y: 100,
          width: 120,
          height: 80,
          sourceIds: ['target-stroke'],
          label: 'Target',
        },
        {
          id: 'connector',
          kind: 'connector',
          points: [[220, 140], [360, 140]],
          start: { itemId: 'source-node' },
          end: { itemId: 'target-node' },
          startArrowhead: null,
          endArrowhead: 'arrow',
          sourceIds: ['connector-stroke'],
        },
      ],
      unresolved: [],
    };
    let scene: AdapterTestElement[] = [];
    const api = {
      setActiveTool: () => undefined,
      getSceneElementsIncludingDeleted: () => scene,
      getAppState: () => ({ selectedElementIds: {} }),
      getFiles: () => ({}),
      updateScene: ({ elements }: { elements: readonly AdapterTestElement[] }) => {
        scene = [...elements];
      },
    } as never;
    const adapter = new CanvasAdapter(api);
    const internals = adapter as unknown as {
      showPlan: (
        nextPlan: SuggestionPlan,
        currentElements: readonly never[],
      ) => void;
      apply: () => void;
    };

    const sourceElements: AdapterTestElement[] = [
      { id: 'source-stroke', type: 'freedraw', x: 0, y: 0, points: [[0, 0], [1, 1]] },
      { id: 'target-stroke', type: 'freedraw', x: 0, y: 0, points: [[0, 0], [1, 1]] },
      { id: 'connector-stroke', type: 'freedraw', x: 0, y: 0, points: [[0, 0], [1, 1]] },
    ];
    scene = sourceElements;
    internals.showPlan(plan, sourceElements as never[]);
    const previewArrow = scene.find((element) => (
      element.type === 'arrow'
      && element.customData?.planItemId === 'connector'
    ));
    expect(previewArrow).toBeDefined();
    if (!previewArrow) {
      return;
    }
    const previewPoints = (previewArrow.points ?? []).map(([x, y]) => [
      (previewArrow.x ?? 0) + x,
      (previewArrow.y ?? 0) + y,
    ]);
    expect(previewArrow.startBinding?.gap).toBeGreaterThanOrEqual(1);
    expect(previewArrow.endBinding?.gap).toBeGreaterThanOrEqual(1);

    internals.apply();
    const appliedArrow = scene.find((element) => (
      element.type === 'arrow'
      && element.customData?.planItemId === 'connector'
    ));
    expect(appliedArrow).toBeDefined();
    if (!appliedArrow) {
      return;
    }
    const appliedPoints = (appliedArrow.points ?? []).map(([x, y]) => [
      (appliedArrow.x ?? 0) + x,
      (appliedArrow.y ?? 0) + y,
    ]);
    expect(appliedPoints).toHaveLength(previewPoints.length);
    appliedPoints.forEach((point, index) => {
      const previewPoint = previewPoints[index]!;
      expect(Math.hypot(point[0] - previewPoint[0], point[1] - previewPoint[1]))
        .toBeLessThanOrEqual(0.5);
    });
  });
});

const targetElement = (target: BindingGeometry) => ({
  ...target,
  x: target.x,
  y: target.y,
  isDeleted: false,
  boundElements: null,
});
