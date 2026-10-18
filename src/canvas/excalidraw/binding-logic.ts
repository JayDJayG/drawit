export type BindingPoint = {
  x: number;
  y: number;
};

export type BindingGeometry = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  roundness?: unknown;
};

export type BindingValue = {
  elementId: string;
  focus: number;
  gap: number;
};

type BindingArrow = {
  x: number;
  y: number;
  points?: readonly [number, number][];
  startBinding?: BindingValue | null;
  endBinding?: BindingValue | null;
};

export type BindingElement = BindingArrow & {
  id: string;
  type: string;
  isDeleted?: boolean;
  boundElements?: { id: string; type: string }[] | null;
  [key: string]: unknown;
};

export type StabilizedBinding = {
  points: readonly [number, number][];
  binding: BindingValue | null;
  movement: number;
};

const MAX_ENDPOINT_REPAIR_DISTANCE = 12;

export const calculateBinding = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): BindingValue => {
  const points = arrow.points ?? [];
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const adjacentIndex = endpoint === 'start' ? 1 : points.length - 2;
  const edge = points[edgeIndex];
  const adjacent = points[adjacentIndex];
  const edgePoint = {
    x: arrow.x + (edge?.[0] ?? 0),
    y: arrow.y + (edge?.[1] ?? 0),
  };
  const adjacentPoint = {
    x: arrow.x + (adjacent?.[0] ?? edge?.[0] ?? 0),
    y: arrow.y + (adjacent?.[1] ?? edge?.[1] ?? 0),
  };
  return {
    elementId: target.id,
    focus: determineFocusDistance(target, adjacentPoint, edgePoint),
    gap: Math.max(1, distanceToBindingOutline(target, edgePoint)),
  };
};

/**
 * Remove an interior point when Excalidraw cannot see both sides of the
 * target outline from the binding's adjacent point. This keeps the converted
 * arrow at a stable point of updateBoundPoint instead of letting Excalidraw
 * fall back to the focus point.
 */
export const stabilizeBinding = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): StabilizedBinding => {
  const originalPoints = arrow.points ?? [];
  let points = originalPoints.map(([x, y]) => [x, y] as [number, number]);
  let best = {
    points,
    binding: null as BindingValue | null,
    movement: Number.POSITIVE_INFINITY,
  };

  for (let simplify = 0; simplify <= Math.max(0, points.length - 2); simplify += 1) {
    if (points.length < 2) {
      break;
    }

    points = clampEndpointGap(points, arrow, target, endpoint);
    let candidate = { ...arrow, points };
    let binding = calculateBinding(candidate, target, endpoint);
    const aligned = alignDiamondVertexEndpoint(points, candidate, target, endpoint);
    if (aligned) {
      points = clampEndpointGap(aligned, arrow, target, endpoint);
      candidate = { ...arrow, points };
      binding = calculateBinding(candidate, target, endpoint);
    }

    if (Math.abs(binding.focus) <= 1) {
      for (let iteration = 0; iteration < 12; iteration += 1) {
        const withBinding = endpoint === 'start'
          ? { ...candidate, points, startBinding: binding }
          : { ...candidate, points, endBinding: binding };
        const updated = updateBoundPoint(withBinding, target, endpoint);
        const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
        const edge = points[edgeIndex];
        if (!edge) {
          break;
        }
        const edgePoint = {
          x: candidate.x + edge[0],
          y: candidate.y + edge[1],
        };
        const movement = distance(edgePoint, updated);
        if (movement < best.movement) {
          best = { points, binding, movement };
        }
        if (movement <= 0.5) {
          return { points, binding, movement };
        }
        if (movement > MAX_ENDPOINT_REPAIR_DISTANCE) {
          break;
        }

        const nextPoint: [number, number] = [
          updated.x - candidate.x,
          updated.y - candidate.y,
        ];
        points = points.map((point, index) => (
          index === edgeIndex ? nextPoint : point
        ));
      }
    }

    if (points.length <= 2) {
      break;
    }
    const adjacentIndex = endpoint === 'start' ? 1 : points.length - 2;
    points = points.filter((_point, index) => index !== adjacentIndex);
  }

  return {
    points: originalPoints,
    binding: null,
    movement: best.movement,
  };
};

export const bindArrowEndpoint = <T extends BindingArrow>(
  arrow: T,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): T => {
  const stabilized = stabilizeBinding(arrow, target, endpoint);
  return {
    ...arrow,
    ...(stabilized.binding
      ? {
          points: stabilized.points,
          [`${endpoint}Binding`]: stabilized.binding,
        }
      : {
          [`${endpoint}Binding`]: null,
        }),
  } as T;
};

export const synchronizeBindingMutuality = <T extends BindingElement>(
  elements: readonly T[],
): T[] => {
  const next = elements.map((element) => ({ ...element })) as T[];
  const byId = new Map(next.map((element) => [element.id, element]));

  for (const arrow of next) {
    if (arrow.type !== 'arrow' || arrow.isDeleted) {
      continue;
    }
    for (const endpoint of ['start', 'end'] as const) {
      const binding = arrow[`${endpoint}Binding`] as {
        elementId?: unknown;
      } | null | undefined;
      if (!binding || typeof binding.elementId !== 'string') {
        continue;
      }
      const target = byId.get(binding.elementId);
      if (!target || target.isDeleted) {
        arrow[`${endpoint}Binding`] = null;
      }
    }
  }

  for (const element of next) {
    if (!Array.isArray(element.boundElements)) {
      continue;
    }
    const boundElements = element.boundElements.filter((bound) => {
      if (bound.type !== 'arrow') {
        return true;
      }
      const arrow = byId.get(bound.id);
      if (!arrow || arrow.isDeleted || arrow.type !== 'arrow') {
        return false;
      }
      return (['start', 'end'] as const).some((endpoint) => {
        const binding = arrow[`${endpoint}Binding`] as {
          elementId?: unknown;
        } | null | undefined;
        return binding?.elementId === element.id;
      });
    });
    element.boundElements = boundElements.length > 0 ? boundElements : null;
  }

  for (const arrow of next) {
    if (arrow.type !== 'arrow' || arrow.isDeleted) {
      continue;
    }
    for (const endpoint of ['start', 'end'] as const) {
      const binding = arrow[`${endpoint}Binding`] as {
        elementId?: unknown;
      } | null | undefined;
      if (!binding || typeof binding.elementId !== 'string') {
        continue;
      }
      const target = byId.get(binding.elementId);
      if (!target || target.isDeleted) {
        continue;
      }
      const boundElements = target.boundElements ? [...target.boundElements] : [];
      if (!boundElements.some((bound) => bound.id === arrow.id && bound.type === 'arrow')) {
        boundElements.push({ id: arrow.id, type: 'arrow' });
      }
      target.boundElements = boundElements;
    }
  }

  return next;
};

const clampEndpointGap = (
  points: readonly [number, number][],
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): [number, number][] => {
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const edge = points[edgeIndex];
  if (!edge) {
    return points.map(([x, y]) => [x, y]);
  }
  const edgePoint = {
    x: arrow.x + edge[0],
    y: arrow.y + edge[1],
  };
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const angle = target.angle ?? 0;
  const localEdge = rotatePoint(edgePoint, center, -angle);
  const localDirection = normalizeVector({
    x: localEdge.x - center.x,
    y: localEdge.y - center.y,
  });
  const outlineRadius = outlineRadiusAlongDirection(target, localDirection);
  const radialDistance = distance(localEdge, center);
  const minimumRadius = outlineRadius + 1;
  const maximumRadius = outlineRadius + 6;
  if (radialDistance >= minimumRadius && radialDistance <= maximumRadius) {
    return points.map(([x, y]) => [x, y]);
  }
  const clampedLocal = {
    x: center.x + localDirection.x * (
      radialDistance < minimumRadius ? minimumRadius : maximumRadius
    ),
    y: center.y + localDirection.y * (
      radialDistance < minimumRadius ? minimumRadius : maximumRadius
    ),
  };
  const clamped = rotatePoint(clampedLocal, center, angle);
  return points.map(([x, y], index) => (
    index === edgeIndex
      ? [clamped.x - arrow.x, clamped.y - arrow.y]
      : [x, y]
  ));
};

const outlineRadiusAlongDirection = (
  element: BindingGeometry,
  direction: BindingPoint,
): number => {
  const halfWidth = element.width / 2;
  const halfHeight = element.height / 2;
  if (element.type === 'ellipse') {
    return 1 / Math.sqrt(
      (direction.x / halfWidth) ** 2
      + (direction.y / halfHeight) ** 2,
    );
  }
  if (element.type === 'diamond') {
    return 1 / (
      Math.abs(direction.x) / halfWidth
      + Math.abs(direction.y) / halfHeight
    );
  }
  return Math.min(
    Math.abs(direction.x) > 0
      ? halfWidth / Math.abs(direction.x)
      : Number.POSITIVE_INFINITY,
    Math.abs(direction.y) > 0
      ? halfHeight / Math.abs(direction.y)
      : Number.POSITIVE_INFINITY,
  );
};

const alignDiamondVertexEndpoint = (
  points: readonly [number, number][],
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): [number, number][] | undefined => {
  if (target.type !== 'diamond') {
    return undefined;
  }
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const edge = points[edgeIndex];
  if (!edge) {
    return undefined;
  }
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const localEdge = rotatePoint({
    x: arrow.x + edge[0],
    y: arrow.y + edge[1],
  }, center, -(target.angle ?? 0));
  const vertices = [
    { x: center.x, y: target.y },
    { x: target.x + target.width, y: center.y },
    { x: center.x, y: target.y + target.height },
    { x: target.x, y: center.y },
  ];
  const nearest = vertices
    .map((vertex) => ({ vertex, distance: distance(localEdge, vertex) }))
    .sort((first, second) => first.distance - second.distance)[0];
  if (!nearest || nearest.distance > Math.max(8, Math.min(target.width, target.height) * 0.2)) {
    return undefined;
  }
  const correctedLocal = { ...localEdge };
  if (Math.abs(nearest.vertex.x - center.x) < 0.001) {
    correctedLocal.x = center.x;
  } else {
    correctedLocal.y = center.y;
  }
  const corrected = rotatePoint(correctedLocal, center, target.angle ?? 0);
  if (distance(corrected, {
    x: arrow.x + edge[0],
    y: arrow.y + edge[1],
  }) < 0.001) {
    return undefined;
  }
  return points.map(([x, y], index) => (
    index === edgeIndex
      ? [corrected.x - arrow.x, corrected.y - arrow.y]
      : [x, y]
  ));
};

/**
 * This is Excalidraw 0.18.1's determineFocusDistance port. In particular,
 * the interceptor starts at the edge point and travels in the B - A direction.
 */
export const determineFocusDistance = (
  element: BindingGeometry,
  adjacent: BindingPoint,
  edge: BindingPoint,
): number => {
  const center = {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
  if (samePoint(adjacent, edge)) {
    return 0;
  }
  const angle = element.angle ?? 0;
  const rotatedAdjacent = rotatePoint(adjacent, center, -angle);
  const rotatedEdge = rotatePoint(edge, center, -angle);
  const sign = Math.sign(
    cross(
      {
        x: rotatedAdjacent.x - rotatedEdge.x,
        y: rotatedAdjacent.y - rotatedEdge.y,
      },
      {
        x: center.x - rotatedEdge.x,
        y: center.y - rotatedEdge.y,
      },
    ),
  ) * -1;
  const direction = normalizeVector({
    x: rotatedEdge.x - rotatedAdjacent.x,
    y: rotatedEdge.y - rotatedAdjacent.y,
  });
  const rayEnd = {
    x: rotatedEdge.x + direction.x * Math.max(element.width * 2, element.height * 2),
    y: rotatedEdge.y + direction.y * Math.max(element.width * 2, element.height * 2),
  };
  const axes = element.type === 'diamond'
    ? [
        [
          { x: element.x + element.width / 2, y: element.y },
          { x: element.x + element.width / 2, y: element.y + element.height },
        ],
        [
          { x: element.x, y: element.y + element.height / 2 },
          { x: element.x + element.width, y: element.y + element.height / 2 },
        ],
      ]
    : [
        [
          { x: element.x, y: element.y },
          { x: element.x + element.width, y: element.y + element.height },
        ],
        [
          { x: element.x + element.width, y: element.y },
          { x: element.x, y: element.y + element.height },
        ],
      ];
  const interceptees = element.type === 'diamond'
    ? [
        [
          { x: element.x + element.width / 2, y: element.y - element.height },
          { x: element.x + element.width / 2, y: element.y + element.height * 2 },
        ],
        [
          { x: element.x - element.width, y: element.y + element.height / 2 },
          { x: element.x + element.width * 2, y: element.y + element.height / 2 },
        ],
      ]
    : [
        [
          { x: element.x - element.width, y: element.y - element.height },
          { x: element.x + element.width * 2, y: element.y + element.height * 2 },
        ],
        [
          { x: element.x + element.width * 2, y: element.y - element.height },
          { x: element.x - element.width, y: element.y + element.height * 2 },
        ],
      ];
  const ordered = interceptees
    .map(([first, second]) => lineIntersection(rotatedEdge, rayEnd, first, second))
    .filter((point): point is BindingPoint => point !== undefined)
    .sort((first, second) => distanceSquared(first, rotatedEdge) - distanceSquared(second, rotatedEdge))
    .map((point, index) => (
      sign * distance(center, point) / (
        element.type === 'diamond'
          ? distance(axes[index]?.[0] ?? center, axes[index]?.[1] ?? center) / 2
          : Math.hypot(element.width, element.height) / 2
      )
    ))
    .sort((first, second) => Math.abs(first) - Math.abs(second));
  return ordered[0] ?? 0;
};

export const determineFocusPoint = (
  element: BindingGeometry,
  focus: number,
  adjacentPoint: BindingPoint,
): BindingPoint => {
  const center = {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
  if (focus === 0) {
    return center;
  }
  const candidates = (
    element.type === 'diamond'
      ? [
          { x: element.x, y: element.y + element.height / 2 },
          { x: element.x + element.width / 2, y: element.y },
          { x: element.x + element.width, y: element.y + element.height / 2 },
          { x: element.x + element.width / 2, y: element.y + element.height },
        ]
      : [
          { x: element.x, y: element.y },
          { x: element.x + element.width, y: element.y },
          { x: element.x + element.width, y: element.y + element.height },
          { x: element.x, y: element.y + element.height },
        ]
  )
    .map((point) => ({
      x: center.x + (point.x - center.x) * Math.abs(focus),
      y: center.y + (point.y - center.y) * Math.abs(focus),
    }))
    .map((point) => rotatePoint(point, center, element.angle ?? 0));
  const selected = [
    cross(vectorFrom(adjacentPoint, candidates[0]!), vectorFrom(candidates[1]!, candidates[0]!)) > 0
      && (focus > 0
        ? cross(vectorFrom(adjacentPoint, candidates[1]!), vectorFrom(candidates[2]!, candidates[1]!)) < 0
        : cross(vectorFrom(adjacentPoint, candidates[3]!), vectorFrom(candidates[0]!, candidates[3]!)) < 0),
    cross(vectorFrom(adjacentPoint, candidates[1]!), vectorFrom(candidates[2]!, candidates[1]!)) > 0
      && (focus > 0
        ? cross(vectorFrom(adjacentPoint, candidates[2]!), vectorFrom(candidates[3]!, candidates[2]!)) < 0
        : cross(vectorFrom(adjacentPoint, candidates[0]!), vectorFrom(candidates[1]!, candidates[0]!)) < 0),
    cross(vectorFrom(adjacentPoint, candidates[2]!), vectorFrom(candidates[3]!, candidates[2]!)) > 0
      && (focus > 0
        ? cross(vectorFrom(adjacentPoint, candidates[3]!), vectorFrom(candidates[0]!, candidates[3]!)) < 0
        : cross(vectorFrom(adjacentPoint, candidates[1]!), vectorFrom(candidates[2]!, candidates[1]!)) < 0),
    cross(vectorFrom(adjacentPoint, candidates[3]!), vectorFrom(candidates[0]!, candidates[3]!)) > 0
      && (focus > 0
        ? cross(vectorFrom(adjacentPoint, candidates[0]!), vectorFrom(candidates[1]!, candidates[0]!)) < 0
        : cross(vectorFrom(adjacentPoint, candidates[2]!), vectorFrom(candidates[3]!, candidates[2]!)) < 0),
  ];
  if (selected[0]) {
    return focus > 0 ? candidates[1]! : candidates[0]!;
  }
  if (selected[1]) {
    return focus > 0 ? candidates[2]! : candidates[1]!;
  }
  if (selected[2]) {
    return focus > 0 ? candidates[3]! : candidates[2]!;
  }
  return focus > 0 ? candidates[0]! : candidates[3]!;
};

export const updateBoundPoint = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): BindingPoint => {
  const binding = endpoint === 'start' ? arrow.startBinding : arrow.endBinding;
  const points = arrow.points ?? [];
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const adjacentIndex = edgeIndex - (endpoint === 'start' ? -1 : 1);
  const edge = points[edgeIndex] ?? [0, 0];
  const adjacent = points[adjacentIndex] ?? edge;
  const edgePoint = { x: arrow.x + edge[0], y: arrow.y + edge[1] };
  const adjacentPoint = { x: arrow.x + adjacent[0], y: arrow.y + adjacent[1] };
  if (!binding || binding.gap === 0) {
    return determineFocusPoint(target, binding?.focus ?? 0, adjacentPoint);
  }
  const focusPointAbsolute = determineFocusPoint(target, binding.focus, adjacentPoint);
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const interceptorLength = distance(adjacentPoint, edgePoint)
    + distance(adjacentPoint, center)
    + Math.max(target.width, target.height) * 2;
  const direction = normalizeVector(vectorFrom(adjacentPoint, focusPointAbsolute));
  const farPoint = {
    x: adjacentPoint.x + direction.x * interceptorLength,
    y: adjacentPoint.y + direction.y * interceptorLength,
  };
  const intersections = intersectElementWithLineSegment(
    target,
    adjacentPoint,
    farPoint,
    binding.gap,
  ).sort(
    (first, second) => distanceSquared(first, adjacentPoint) - distanceSquared(second, adjacentPoint),
  );
  if (intersections.length > 1) {
    return intersections[0]!;
  }
  if (intersections.length === 1) {
    return focusPointAbsolute;
  }
  return edgePoint;
};

const intersectElementWithLineSegment = (
  element: BindingGeometry,
  first: BindingPoint,
  second: BindingPoint,
  gap: number,
): BindingPoint[] => {
  if (element.type === 'ellipse') {
    return intersectEllipse(element, first, second, gap);
  }
  if (element.type === 'diamond') {
    const topX = Math.floor(element.width / 2) + 1;
    const rightY = Math.floor(element.height / 2) + 1;
    return intersectPolygon(first, second, [
      { x: element.x + topX, y: element.y - gap },
      { x: element.x + element.width + gap, y: element.y + rightY },
      { x: element.x + topX, y: element.y + element.height + gap },
      { x: element.x - gap, y: element.y + rightY },
    ]);
  }
  return intersectPolygon(first, second, [
    { x: element.x - gap, y: element.y - gap },
    { x: element.x + element.width + gap, y: element.y - gap },
    { x: element.x + element.width + gap, y: element.y + element.height + gap },
    { x: element.x - gap, y: element.y + element.height + gap },
  ]);
};

const intersectEllipse = (
  element: BindingGeometry,
  first: BindingPoint,
  second: BindingPoint,
  gap: number,
): BindingPoint[] => {
  const center = {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
  const localFirst = rotatePoint(first, center, -(element.angle ?? 0));
  const localSecond = rotatePoint(second, center, -(element.angle ?? 0));
  const dx = localSecond.x - localFirst.x;
  const dy = localSecond.y - localFirst.y;
  const rx = Math.max(0.5, element.width / 2 + gap);
  const ry = Math.max(0.5, element.height / 2 + gap);
  const a = (dx / rx) ** 2 + (dy / ry) ** 2;
  const b = 2 * (
    ((localFirst.x - center.x) * dx) / (rx * rx)
    + ((localFirst.y - center.y) * dy) / (ry * ry)
  );
  const c = ((localFirst.x - center.x) / rx) ** 2
    + ((localFirst.y - center.y) / ry) ** 2 - 1;
  const discriminant = b * b - 4 * a * c;
  if (a < 0.000001) {
    return [];
  }
  const root = Math.sqrt(discriminant);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter((t) => Number.isFinite(t))
    .map((t) => rotatePoint({
      x: localFirst.x + dx * t,
      y: localFirst.y + dy * t,
    }, center, element.angle ?? 0));
};

const intersectPolygon = (
  first: BindingPoint,
  second: BindingPoint,
  polygon: readonly BindingPoint[],
): BindingPoint[] => {
  const intersections: BindingPoint[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const next = polygon[(index + 1) % polygon.length]!;
    const point = lineIntersection(first, second, polygon[index]!, next);
    if (point) {
      intersections.push(point);
    }
  }
  return intersections;
};

const distanceToBindingOutline = (
  element: BindingGeometry,
  point: BindingPoint,
): number => {
  const center = {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
  const local = rotatePoint(point, center, -(element.angle ?? 0));
  const halfWidth = Math.max(0.5, element.width / 2);
  const halfHeight = Math.max(0.5, element.height / 2);
  if (element.type === 'ellipse') {
    return ellipseDistanceFromPoint(local, center, halfWidth, halfHeight);
  }
  if (element.type === 'diamond') {
    const vertices = [
      {
        x: element.x + Math.floor(element.width / 2) + 1,
        y: element.y,
      },
      {
        x: element.x + element.width,
        y: element.y + Math.floor(element.height / 2) + 1,
      },
      {
        x: element.x + Math.floor(element.width / 2) + 1,
        y: element.y + element.height,
      },
      {
        x: element.x,
        y: element.y + Math.floor(element.height / 2) + 1,
      },
    ];
    return Math.min(...vertices.map((vertex, index) => {
      const next = vertices[(index + 1) % vertices.length]!;
      return distanceToSegment(local, vertex, next);
    }));
  }
  const dx = Math.min(
    Math.abs(local.x - element.x),
    Math.abs(local.x - (element.x + element.width)),
  );
  const dy = Math.min(
    Math.abs(local.y - element.y),
    Math.abs(local.y - (element.y + element.height)),
  );
  return Math.min(dx, dy);
};

const ellipseDistanceFromPoint = (
  point: BindingPoint,
  center: BindingPoint,
  halfWidth: number,
  halfHeight: number,
): number => {
  const translatedX = point.x - center.x;
  const translatedY = point.y - center.y;
  const px = Math.abs(translatedX);
  const py = Math.abs(translatedY);
  const a = halfWidth;
  const b = halfHeight;
  let tx = 0.707;
  let ty = 0.707;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const x = a * tx;
    const y = b * ty;
    const ex = (a * a - b * b) * tx ** 3 / a;
    const ey = (b * b - a * a) * ty ** 3 / b;
    const rx = x - ex;
    const ry = y - ey;
    const qx = px - ex;
    const qy = py - ey;
    const r = Math.hypot(ry, rx);
    const q = Math.hypot(qy, qx);
    tx = Math.min(1, Math.max(0, (qx * r / q + ex) / a));
    ty = Math.min(1, Math.max(0, (qy * r / q + ey) / b));
    const length = Math.hypot(ty, tx);
    tx /= length;
    ty /= length;
  }
  const nearestX = a * tx * Math.sign(translatedX);
  const nearestY = b * ty * Math.sign(translatedY);
  return Math.hypot(translatedX - nearestX, translatedY - nearestY);
};

const distanceToSegment = (
  point: BindingPoint,
  first: BindingPoint,
  second: BindingPoint,
): number => {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / denominator));
  return distance(point, {
    x: first.x + dx * t,
    y: first.y + dy * t,
  });
};

const lineIntersection = (
  firstStart: BindingPoint,
  firstEnd: BindingPoint,
  secondStart: BindingPoint,
  secondEnd: BindingPoint,
): BindingPoint | undefined => {
  const firstVector = {
    x: firstEnd.x - firstStart.x,
    y: firstEnd.y - firstStart.y,
  };
  const secondVector = {
    x: secondEnd.x - secondStart.x,
    y: secondEnd.y - secondStart.y,
  };
  const denominator = cross(firstVector, secondVector);
  if (Math.abs(denominator) < 0.0001) {
    return undefined;
  }
  const offset = {
    x: secondStart.x - firstStart.x,
    y: secondStart.y - firstStart.y,
  };
  const t = cross(offset, secondVector) / denominator;
  const u = cross(offset, firstVector) / denominator;
  if (t < -0.001 || t > 1.001 || u < -0.001 || u > 1.001) {
    return undefined;
  }
  return {
    x: firstStart.x + firstVector.x * t,
    y: firstStart.y + firstVector.y * t,
  };
};

const vectorFrom = (first: BindingPoint, second: BindingPoint): BindingPoint => ({
  x: second.x - first.x,
  y: second.y - first.y,
});

const rotatePoint = (
  point: BindingPoint,
  center: BindingPoint,
  angle: number,
): BindingPoint => {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
};

const samePoint = (first: BindingPoint, second: BindingPoint): boolean => (
  Math.abs(first.x - second.x) < 0.001
  && Math.abs(first.y - second.y) < 0.001
);

const normalizeVector = (value: BindingPoint): BindingPoint => {
  const length = Math.hypot(value.x, value.y);
  return length < 0.001
    ? { x: 1, y: 0 }
    : { x: value.x / length, y: value.y / length };
};

const distanceSquared = (first: BindingPoint, second: BindingPoint): number => (
  (first.x - second.x) ** 2 + (first.y - second.y) ** 2
);

const distance = (first: BindingPoint, second: BindingPoint): number => Math.sqrt(
  distanceSquared(first, second),
);

const cross = (first: BindingPoint, second: BindingPoint): number => (
  first.x * second.y - first.y * second.x
);
