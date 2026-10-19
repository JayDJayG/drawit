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

export type BindingInvariantResult = {
  valid: boolean;
  outlineDistance: number;
  targetDistance: number;
  stableMovement: number;
  segmentLength: number;
  directionCosine: number;
  otherEndpointMovement: number;
  interiorPointMovement: number;
  interiorPointException: boolean;
};

const findStableBindingAlongShaft = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
  shaftDirection: BindingPoint,
  targetPoint: BindingPoint = endpointPoint(arrow, endpoint) ?? { x: arrow.x, y: arrow.y },
  bandTargetFor?: (gap: number) => BindingPoint | undefined,
  adjacentMayMove = true,
): StabilizedBinding | undefined => {
  const originalPoints = arrow.points ?? [];
  const edgeIndex = endpoint === 'start' ? 0 : originalPoints.length - 1;
  const adjacentIndex = endpoint === 'start' ? 1 : originalPoints.length - 2;
  const edge = originalPoints[edgeIndex];
  const adjacent = originalPoints[adjacentIndex];
  if (!edge || !adjacent) {
    return undefined;
  }
  const focusStep = target.type === 'diamond' ? 0.01 : 0.02;
  const secondaryFocusStep = 0.02;
  const fineFocusStep = 0.001;
  const preferredGap = Math.max(
    1,
    Math.min(6, distanceToBindingOutline(target, targetPoint)),
  );
  const gapCandidates = [...new Set([
    1,
    preferredGap,
    preferredGap - 1,
    preferredGap + 1,
    3,
    5,
    6,
  ].filter((gap) => gap >= 1 && gap <= 6))].sort((one, two) => one - two);
  const ensureMinimumOutlineGap = (point: BindingPoint): BindingPoint => (
    distanceToBindingOutline(target, point) < MIN_BINDING_OUTLINE_DISTANCE
      ? pointOnExpandedOutlineAlongRadial(target, point, 0.75)
      : point
  );

  type SearchCandidate = StabilizedBinding & {
    targetDistance: number;
    gap: number;
  };
  let best: SearchCandidate | undefined;
  const consider = (focus: number, gap: number): SearchCandidate | undefined => {
    const binding: BindingValue = {
      elementId: target.id,
      focus,
      gap,
    };
    const probe = setEndpointBinding(arrow, endpoint, binding);
    let updated = ensureMinimumOutlineGap(updateBoundPoint(probe, target, endpoint));
    let nextPoints = originalPoints.map((point, index) => (
      index === edgeIndex
        ? [updated.x - arrow.x, updated.y - arrow.y] as [number, number]
        : [point[0], point[1]] as [number, number]
    ));
    let candidate = setEndpointBinding(
      { ...arrow, points: nextPoints },
      endpoint,
      binding,
    );
    let candidateEdge = endpointPoint(candidate, endpoint);
    let candidateAdjacent = adjacentPoint(candidate, endpoint);
    if (!candidateEdge || !candidateAdjacent) {
      return undefined;
    }
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const segmentLength = distance(candidateEdge, candidateAdjacent);
      if (
        segmentLength + BINDING_GEOMETRY_EPSILON >= MIN_BINDING_SEGMENT_LENGTH
        || originalPoints.length <= 2
      ) {
        break;
      }
      if (!adjacentMayMove) {
        return undefined;
      }
      const correction = MIN_BINDING_SEGMENT_LENGTH - segmentLength;
      const correctedAdjacent = {
        x: candidateAdjacent.x - shaftDirection.x * correction,
        y: candidateAdjacent.y - shaftDirection.y * correction,
      };
      nextPoints = nextPoints.map((point, index) => (
        index === adjacentIndex
          ? [correctedAdjacent.x - arrow.x, correctedAdjacent.y - arrow.y] as [number, number]
          : [point[0], point[1]] as [number, number]
      ));
      candidate = setEndpointBinding(
        { ...arrow, points: nextPoints },
        endpoint,
        binding,
      );
      updated = ensureMinimumOutlineGap(updateBoundPoint(candidate, target, endpoint));
      nextPoints = nextPoints.map((point, index) => (
        index === edgeIndex
          ? [updated.x - arrow.x, updated.y - arrow.y] as [number, number]
          : [point[0], point[1]] as [number, number]
      ));
      candidate = setEndpointBinding(
        { ...arrow, points: nextPoints },
        endpoint,
        binding,
      );
      candidateEdge = endpointPoint(candidate, endpoint);
      candidateAdjacent = adjacentPoint(candidate, endpoint);
      if (!candidateEdge || !candidateAdjacent) {
        return undefined;
      }
    }
    const direction = normalizeVector(vectorFrom(candidateAdjacent, candidateEdge));
    const directionCosine = direction.x * shaftDirection.x
      + direction.y * shaftDirection.y;
    if (directionCosine < MIN_BINDING_DIRECTION_COSINE) {
      return undefined;
    }
    const stablePoint = updateBoundPoint(candidate, target, endpoint);
    const movement = distance(candidateEdge, stablePoint);
    const outlineDistance = distanceToBindingOutline(target, candidateEdge);
    if (movement > 0.5 || !boundPointOnBand(candidate, target, endpoint)) {
      return undefined;
    }
    if (pointInsideExpandedShape(candidateEdge, target, 0.0001)) {
      return undefined;
    }
    if (
      outlineDistance < MIN_BINDING_OUTLINE_DISTANCE
      || outlineDistance > MAX_BINDING_OUTLINE_DISTANCE
    ) {
      return undefined;
    }
    if (distance(candidateEdge, candidateAdjacent) < MIN_BINDING_SEGMENT_LENGTH) {
      return undefined;
    }
    const bandTarget = bandTargetFor?.(gap);
    const targetDistance = Math.min(
      distance(candidateEdge, targetPoint),
      bandTarget ? distance(candidateEdge, bandTarget) : Number.POSITIVE_INFINITY,
    );
    const sameSide = isSameBindingSide(target, targetPoint, candidateEdge);
    if (targetDistance > MAX_BINDING_TARGET_DISTANCE) {
      return undefined;
    }
    if (!sameSide) {
      return undefined;
    }
    return {
      points: nextPoints,
      binding,
      movement,
      targetDistance,
      gap,
    };
  };

  const isBetter = (candidate: SearchCandidate): boolean => {
    if (!best) {
      return true;
    }
    if (Math.abs(candidate.gap - best.gap) > 0.0001) {
      return candidate.gap < best.gap;
    }
    if (candidate.targetDistance < best.targetDistance - 0.0001) {
      return true;
    }
    return Math.abs(candidate.targetDistance - best.targetDistance) <= 0.0001
      && candidate.gap < best.gap;
  };

  for (const gap of gapCandidates) {
    const coarseStep = gap === 1 ? focusStep : secondaryFocusStep;
    let coarseBest: SearchCandidate | undefined;
    for (let index = 0; index <= Math.round(2 / coarseStep); index += 1) {
      const candidate = consider(-1 + index * coarseStep, gap);
      if (candidate && (!coarseBest || isBetterForTarget(candidate, coarseBest))) {
        coarseBest = candidate;
      }
      if (candidate && isBetter(candidate)) {
        best = candidate;
      }
    }

    if (coarseBest) {
      const coarseFocus = coarseBest.binding?.focus;
      if (coarseFocus === undefined) {
        continue;
      }
      const minimum = Math.max(-1, coarseFocus - coarseStep);
      const maximum = Math.min(1, coarseFocus + coarseStep);
      for (
        let focus = minimum;
        focus <= maximum + fineFocusStep / 2;
        focus += fineFocusStep
      ) {
        const candidate = consider(Math.min(maximum, focus), gap);
        if (candidate && isBetter(candidate)) {
          best = candidate;
        }
      }
      continue;
    }

    const fallbackStep = target.type === 'diamond' ? 0.005 : 0.01;
    for (let index = 0; index <= Math.round(2 / fallbackStep); index += 1) {
      const candidate = consider(-1 + index * fallbackStep, gap);
      if (candidate && isBetter(candidate)) {
        best = candidate;
      }
    }
  }

  return best;
};

const isBetterForTarget = (
  candidate: { targetDistance: number; gap: number },
  current: { targetDistance: number; gap: number },
): boolean => {
  if (candidate.targetDistance < current.targetDistance - 0.0001) {
    return true;
  }
  return Math.abs(candidate.targetDistance - current.targetDistance) <= 0.0001
    && candidate.gap < current.gap;
};

const MIN_BINDING_SEGMENT_LENGTH = 10.05;
const BINDING_GEOMETRY_EPSILON = 0.001;
const MAX_BINDING_OUTLINE_DISTANCE = 6.01;
const MIN_BINDING_OUTLINE_DISTANCE = 0.5;
const MIN_BINDING_DIRECTION_COSINE = Math.cos(20 * Math.PI / 180);
const MAX_BINDING_TARGET_DISTANCE = 2.5;

const bindingOutlineVertices = (
  target: BindingGeometry,
): BindingPoint[] => {
  if (target.type === 'diamond') {
    return [
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y },
      { x: target.x + target.width, y: target.y + Math.floor(target.height / 2) + 1 },
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y + target.height },
      { x: target.x, y: target.y + Math.floor(target.height / 2) + 1 },
    ].map((point) => rotatePoint(
      point,
      {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      },
      target.angle ?? 0,
    ));
  }
  return [
    { x: target.x, y: target.y },
    { x: target.x + target.width, y: target.y },
    { x: target.x + target.width, y: target.y + target.height },
    { x: target.x, y: target.y + target.height },
  ].map((point) => rotatePoint(
    point,
    {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    },
    target.angle ?? 0,
  ));
};

const nearestBindingSide = (
  target: BindingGeometry,
  point: BindingPoint,
): { index: number; vertexDistance: number } => {
  const vertices = bindingOutlineVertices(target);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let vertexDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const next = vertices[(index + 1) % vertices.length]!;
    const sideDistance = distanceToSegment(point, vertices[index]!, next);
    if (sideDistance < bestDistance) {
      bestDistance = sideDistance;
      bestIndex = index;
      vertexDistance = Math.min(
        distance(point, vertices[index]!),
        distance(point, next),
      );
    }
  }
  return { index: bestIndex, vertexDistance };
};

const isSameBindingSide = (
  target: BindingGeometry,
  reference: BindingPoint,
  candidate: BindingPoint,
): boolean => {
  if (target.type !== 'rectangle' && target.type !== 'diamond') {
    return true;
  }
  const referenceSide = nearestBindingSide(target, reference);
  const candidateSide = nearestBindingSide(target, candidate);
  return referenceSide.index === candidateSide.index
    || referenceSide.vertexDistance <= 3
    || candidateSide.vertexDistance <= 3;
};

const determineBindingTargetPoint = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
  band = 0,
): BindingPoint | undefined => {
  const points = arrow.points ?? [];
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const step = endpoint === 'start' ? 1 : -1;
  const edge = endpointPoint(arrow, endpoint);
  if (!edge || points.length < 2) {
    return edge;
  }
  const absolutePoints = points.map(([x, y]) => ({
    x: arrow.x + x,
    y: arrow.y + y,
  }));
  const edgeInside = pointInsideExpandedShape(edge, target, band + 0.0001);
  const nearestIntersection = (
    first: BindingPoint,
    second: BindingPoint,
  ): BindingPoint | undefined => {
    const intersections = intersectElementWithLineSegment(target, first, second, band)
      .filter((point) => (
        distanceSquared(point, first) <= distanceSquared(second, first) + 0.01
        && distanceSquared(point, second) <= distanceSquared(first, second) + 0.01
      ));
    return intersections.sort(
      (one, two) => distanceSquared(one, second) - distanceSquared(two, second),
    )[0];
  };
  if (edgeInside) {
    let inside = edge;
    const edgeOnOutline = !pointInsideExpandedShape(edge, target, band - 0.001);
    for (
      let index = edgeIndex + step;
      index >= 0 && index < absolutePoints.length;
      index += step
    ) {
      const previous = absolutePoints[index]!;
      if (pointInsideExpandedShape(previous, target, band + 0.0001)) {
        inside = previous;
        continue;
      }
      const intersection = nearestIntersection(previous, inside);
      if (intersection) {
        if (edgeOnOutline) {
          const crossings = intersectElementWithLineSegment(
            target,
            previous,
            inside,
            0,
          ).filter((point) => (
            distanceSquared(point, previous) <= distanceSquared(inside, previous) + 0.01
              && distanceSquared(point, inside) <= distanceSquared(previous, inside) + 0.01
          ));
          return crossings.sort(
            (one, two) => distanceSquared(one, previous) - distanceSquared(two, previous),
          )[0] ?? intersection;
        }
        return intersection;
      }
      let outside = previous;
      for (let iteration = 0; iteration < 48; iteration += 1) {
        const midpoint = {
          x: (outside.x + inside.x) / 2,
          y: (outside.y + inside.y) / 2,
        };
        if (pointInsideExpandedShape(midpoint, target, band + 0.0001)) {
          inside = midpoint;
        } else {
          outside = midpoint;
        }
      }
      return {
        x: (outside.x + inside.x) / 2,
        y: (outside.y + inside.y) / 2,
      };
    }
    return pointOnExpandedOutlineAlongRadial(target, edge, band);
  }

  const adjacentIndex = edgeIndex + step;
  const adjacent = absolutePoints[adjacentIndex];
  if (!adjacent) {
    return pointOnExpandedOutlineAlongRadial(target, edge, band);
  }
  const segmentIntersections = intersectElementWithLineSegment(
    target,
    adjacent,
    edge,
    band,
  ).filter((point) => (
    distanceSquared(point, adjacent) <= distanceSquared(edge, adjacent) + 0.01
      && distanceSquared(point, edge) <= distanceSquared(adjacent, edge) + 0.01
  ));
  if (segmentIntersections.length > 0) {
    return segmentIntersections.sort(
      (one, two) => distanceSquared(one, adjacent) - distanceSquared(two, adjacent),
    )[0]!;
  }
  const direction = normalizeVector(vectorFrom(adjacent, edge));
  let previousRayPoint = edge;
  const rayStepCount = Math.ceil(Math.max(target.width, target.height) * 8);
  for (let step = 1; step <= rayStepCount; step += 1) {
    const currentRayPoint = {
      x: edge.x + direction.x * step,
      y: edge.y + direction.y * step,
    };
    if (pointInsideExpandedShape(currentRayPoint, target, band + 0.0001)) {
      let outside = previousRayPoint;
      let inside = currentRayPoint;
      for (let iteration = 0; iteration < 48; iteration += 1) {
        const middle = {
          x: (outside.x + inside.x) / 2,
          y: (outside.y + inside.y) / 2,
        };
        if (pointInsideExpandedShape(middle, target, band + 0.0001)) {
          inside = middle;
        } else {
          outside = middle;
        }
      }
      return {
        x: (outside.x + inside.x) / 2,
        y: (outside.y + inside.y) / 2,
      };
    }
    previousRayPoint = currentRayPoint;
  }
  const farPoint = {
    x: edge.x + direction.x * Math.max(target.width, target.height) * 4,
    y: edge.y + direction.y * Math.max(target.width, target.height) * 4,
  };
  const forwardIntersection = nearestIntersection(edge, farPoint);
  const rayIntersections = intersectElementWithLineSegment(target, edge, farPoint, band)
    .filter((point) => (
      distanceSquared(point, edge) <= distanceSquared(farPoint, edge) + 0.01
      && distanceSquared(point, farPoint) <= distanceSquared(edge, farPoint) + 0.01
    ))
    .sort(
      (one, two) => distanceSquared(one, edge) - distanceSquared(two, edge),
    )[0];
  const nearestOutline = nearestPointOnBindingOutline(target, edge);
  if (rayIntersections) {
    const rayDirection = normalizeVector(vectorFrom(edge, farPoint));
    const afterIntersection = {
      x: rayIntersections.x + rayDirection.x * 0.1,
      y: rayIntersections.y + rayDirection.y * 0.1,
    };
    if (pointInsideExpandedShape(afterIntersection, target, band + 0.0001)) {
      return rayIntersections;
    }
  }
  return nearestOutline
    ?? forwardIntersection
    ?? rayIntersections;
};

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
    focus: clampFocus(determineFocusDistance(target, adjacentPoint, edgePoint)),
    gap: Math.max(1, distanceToBindingOutline(target, edgePoint)),
  };
};

export const stabilizeBinding = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): StabilizedBinding => {
  const originalPoints = arrow.points ?? [];
  const originalTargetPoint = determineBindingTargetPoint(arrow, target, endpoint)
    ?? endpointPoint(arrow, endpoint)
    ?? { x: arrow.x, y: arrow.y };
  const originalEdge = endpointPoint(arrow, endpoint);
  const originalAdjacent = adjacentPoint(arrow, endpoint);
  const bandTargets = new Map<number, BindingPoint | undefined>();
  if (originalEdge && originalAdjacent) {
    const shaftDirection = normalizeVector(vectorFrom(originalAdjacent, originalEdge));
    const preparedPoints = ensureAdjacentOutside(
      originalPoints,
      arrow,
      target,
      endpoint,
      shaftDirection,
      MIN_BINDING_SEGMENT_LENGTH,
    );
    const searched = findStableBindingAlongShaft(
      { ...arrow, points: preparedPoints },
      target,
      endpoint,
      shaftDirection,
      originalTargetPoint,
      (gap) => {
        if (!bandTargets.has(gap)) {
          bandTargets.set(gap, determineBindingTargetPoint(arrow, target, endpoint, gap));
        }
        return bandTargets.get(gap);
      },
      pointInsideExpandedShape(originalAdjacent, target, 1)
        || distance(originalEdge, originalAdjacent) < MIN_BINDING_SEGMENT_LENGTH,
    );
    if (searched) {
      return searched;
    }
  }
  return {
    points: originalPoints,
    binding: null,
    movement: Number.POSITIVE_INFINITY,
  };
};

const endpointBinding = (
  arrow: BindingArrow,
  endpoint: 'start' | 'end',
): BindingValue | null | undefined => (
  endpoint === 'start' ? arrow.startBinding : arrow.endBinding
);

const endpointPoint = (
  arrow: BindingArrow,
  endpoint: 'start' | 'end',
): BindingPoint | undefined => {
  const points = arrow.points ?? [];
  const point = points[endpoint === 'start' ? 0 : points.length - 1];
  return point
    ? { x: arrow.x + point[0], y: arrow.y + point[1] }
    : undefined;
};

const adjacentPoint = (
  arrow: BindingArrow,
  endpoint: 'start' | 'end',
): BindingPoint | undefined => {
  const points = arrow.points ?? [];
  const point = points[endpoint === 'start' ? 1 : points.length - 2];
  return point
    ? { x: arrow.x + point[0], y: arrow.y + point[1] }
    : undefined;
};

const setEndpointBinding = <T extends BindingArrow>(
  arrow: T,
  endpoint: 'start' | 'end',
  binding: BindingValue | null,
): T => ({
  ...arrow,
  [`${endpoint}Binding`]: binding,
} as T);

export const inspectBindingInvariants = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
  referenceArrow: BindingArrow = arrow,
): BindingInvariantResult => {
  const binding = endpointBinding(arrow, endpoint);
  const edge = endpointPoint(arrow, endpoint);
  const adjacent = adjacentPoint(arrow, endpoint);
  const referenceEdge = endpointPoint(referenceArrow, endpoint);
  const referenceAdjacent = adjacentPoint(referenceArrow, endpoint);
  if (
    !binding
    || binding.elementId !== target.id
    || !edge
    || !adjacent
    || !referenceEdge
    || !referenceAdjacent
  ) {
    return {
      valid: false,
      outlineDistance: Number.POSITIVE_INFINITY,
      targetDistance: Number.POSITIVE_INFINITY,
      stableMovement: Number.POSITIVE_INFINITY,
      segmentLength: 0,
      directionCosine: -1,
      otherEndpointMovement: Number.POSITIVE_INFINITY,
      interiorPointMovement: Number.POSITIVE_INFINITY,
      interiorPointException: false,
    };
  }

  const stablePoint = updateBoundPoint(arrow, target, endpoint);
  const stableMovement = distance(edge, stablePoint);
  const segment = vectorFrom(adjacent, edge);
  const referenceSegment = vectorFrom(referenceAdjacent, referenceEdge);
  const segmentLength = distance(adjacent, edge);
  const direction = normalizeVector(segment);
  const referenceDirection = normalizeVector(referenceSegment);
  const directionCosine = direction.x * referenceDirection.x
    + direction.y * referenceDirection.y;
  const otherEndpoint = endpointPoint(arrow, endpoint === 'start' ? 'end' : 'start');
  const referenceOtherEndpoint = endpointPoint(
    referenceArrow,
    endpoint === 'start' ? 'end' : 'start',
  );
  const otherEndpointMovement = otherEndpoint && referenceOtherEndpoint
    ? distance(otherEndpoint, referenceOtherEndpoint)
    : Number.POSITIVE_INFINITY;
  const targetPoint = determineBindingTargetPoint(referenceArrow, target, endpoint);
  const bandTargetPoint = determineBindingTargetPoint(referenceArrow, target, endpoint, binding.gap);
  const targetDistance = Math.min(
    targetPoint ? distance(edge, targetPoint) : Number.POSITIVE_INFINITY,
    bandTargetPoint ? distance(edge, bandTargetPoint) : Number.POSITIVE_INFINITY,
  );
  const targetSideValid = targetPoint
    ? isSameBindingSide(target, targetPoint, edge)
    : false;
  const points = arrow.points ?? [];
  const referencePoints = referenceArrow.points ?? [];
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const adjacentIndex = endpoint === 'start' ? 1 : points.length - 2;
  let interiorPointMovement = 0;
  let interiorPointException = false;
  let interiorPointsValid = points.length === referencePoints.length;
  for (let index = 0; index < points.length && index < referencePoints.length; index += 1) {
    if (index === edgeIndex) {
      continue;
    }
    const movement = distance(
      { x: arrow.x + points[index]![0], y: arrow.y + points[index]![1] },
      { x: referenceArrow.x + referencePoints[index]![0], y: referenceArrow.y + referencePoints[index]![1] },
    );
    interiorPointMovement = Math.max(interiorPointMovement, movement);
    const allowed = index === adjacentIndex && (
      pointInsideExpandedShape(referenceAdjacent, target, 1)
      || distance(referenceEdge, referenceAdjacent) < MIN_BINDING_SEGMENT_LENGTH
    );
    if (allowed) {
      interiorPointException = true;
    } else if (movement > 0.5) {
      interiorPointsValid = false;
    }
  }
  const outlineDistance = distanceToBindingOutline(target, edge);
  const outside = !pointInsideExpandedShape(edge, target, 0.0001);
  const valid = (
    Number.isFinite(binding.focus)
    && Math.abs(binding.focus) <= 1
    && Number.isFinite(binding.gap)
    && binding.gap >= 1
    && binding.gap <= MAX_BINDING_OUTLINE_DISTANCE
    && outside
    && outlineDistance >= MIN_BINDING_OUTLINE_DISTANCE
    && outlineDistance <= MAX_BINDING_OUTLINE_DISTANCE
    && targetDistance <= MAX_BINDING_TARGET_DISTANCE
    && targetSideValid
    && stableMovement <= 0.5
    && boundPointOnBand(arrow, target, endpoint)
    && segmentLength + BINDING_GEOMETRY_EPSILON >= MIN_BINDING_SEGMENT_LENGTH
    && directionCosine >= MIN_BINDING_DIRECTION_COSINE
    && otherEndpointMovement <= 0.5
    && interiorPointsValid
  );
  return {
    valid,
    outlineDistance,
    targetDistance,
    stableMovement,
    segmentLength,
    directionCosine,
    otherEndpointMovement,
    interiorPointMovement,
    interiorPointException,
  };
};

/**
 * Validate and, when necessary, repair a binding regardless of whether
 * Excalidraw already supplied one. The adapter uses this single writer for
 * newly converted and existing-native bindings.
 */
export const ensureBinding = <T extends BindingElement>(
  arrow: T,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): T => {
  const existing = endpointBinding(arrow, endpoint);
  if (
    existing
    && existing.elementId === target.id
    && inspectBindingInvariants(arrow, target, endpoint).valid
  ) {
    return arrow;
  }

  const stabilized = stabilizeBinding(arrow, target, endpoint);
  if (!stabilized.binding) {
    return setEndpointBinding(arrow, endpoint, null);
  }
  const corrected = setEndpointBinding(
    {
      ...arrow,
      points: stabilized.points,
    },
    endpoint,
    stabilized.binding,
  );
  if (inspectBindingInvariants(corrected, target, endpoint, arrow).valid) {
    return corrected;
  }

  return setEndpointBinding(arrow, endpoint, null);
};

export const bindArrowEndpoint = <T extends BindingArrow>(
  arrow: T,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): T => {
  return ensureBinding(
    arrow as T & BindingElement,
    target,
    endpoint,
  );
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

const ensureAdjacentOutside = (
  points: readonly [number, number][],
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
  shaftDirection?: BindingPoint,
  minimumLength = MIN_BINDING_SEGMENT_LENGTH,
): [number, number][] => {
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const adjacentIndex = endpoint === 'start' ? 1 : points.length - 2;
  const edge = points[edgeIndex];
  const adjacent = points[adjacentIndex];
  if (!edge || !adjacent) {
    return points.map(([x, y]) => [x, y]);
  }
  const edgeAbsolute = {
    x: arrow.x + edge[0],
    y: arrow.y + edge[1],
  };
  const adjacentAbsolute = {
    x: arrow.x + adjacent[0],
    y: arrow.y + adjacent[1],
  };
  const direction = shaftDirection
    ? normalizeVector(shaftDirection)
    : normalizeVector(vectorFrom(adjacentAbsolute, edgeAbsolute));
  const currentDistance = distance(edgeAbsolute, adjacentAbsolute);
  const adjacentInside = pointInsideExpandedShape(adjacentAbsolute, target, 1);
  if (
    currentDistance + BINDING_GEOMETRY_EPSILON >= minimumLength
    && !adjacentInside
  ) {
    return points.map(([x, y]) => [x, y]);
  }
  if (points.length <= 2) {
    return points.map(([x, y]) => [x, y]);
  }
  const initialDistance = Math.max(minimumLength, currentDistance);
  const maximumDistance = Math.hypot(target.width, target.height) * 2;
  for (
    let length = initialDistance;
    length <= maximumDistance;
    length += 1
  ) {
    const candidate = {
      x: edgeAbsolute.x - direction.x * length,
      y: edgeAbsolute.y - direction.y * length,
    };
    if (!pointInsideExpandedShape(candidate, target, 1)) {
      return points.map(([x, y], index) => (
        index === adjacentIndex
          ? [candidate.x - arrow.x, candidate.y - arrow.y]
          : [x, y]
      ));
    }
  }
  return points.map(([x, y]) => [x, y]);
};

const pointInsideExpandedShape = (
  point: BindingPoint,
  target: BindingGeometry,
  margin: number,
): boolean => {
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const local = rotatePoint(point, center, -(target.angle ?? 0));
  const halfWidth = target.width / 2;
  const halfHeight = target.height / 2;
  if (target.type === 'ellipse') {
    return (
      ((local.x - center.x) / (halfWidth + margin)) ** 2
      + ((local.y - center.y) / (halfHeight + margin)) ** 2
    ) <= 1;
  }
  if (target.type === 'diamond') {
    const vertices = [
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y - margin },
      { x: target.x + target.width + margin, y: target.y + Math.floor(target.height / 2) + 1 },
      { x: target.x + Math.floor(target.width / 2) + 1, y: target.y + target.height + margin },
      { x: target.x - margin, y: target.y + Math.floor(target.height / 2) + 1 },
    ];
    let hasPositive = false;
    let hasNegative = false;
    for (let index = 0; index < vertices.length; index += 1) {
      const first = vertices[index]!;
      const second = vertices[(index + 1) % vertices.length]!;
      const side = cross(
        { x: second.x - first.x, y: second.y - first.y },
        { x: local.x - first.x, y: local.y - first.y },
      );
      hasPositive ||= side > 0.000001;
      hasNegative ||= side < -0.000001;
      if (hasPositive && hasNegative) {
        return false;
      }
    }
    return true;
  }
  return local.x >= target.x - margin
    && local.x <= target.x + target.width + margin
    && local.y >= target.y - margin
    && local.y <= target.y + target.height + margin;
};

const pointOnExpandedOutlineAlongRadial = (
  target: BindingGeometry,
  point: BindingPoint,
  gap: number,
): BindingPoint => {
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const local = rotatePoint(point, center, -(target.angle ?? 0));
  const direction = normalizeVector({
    x: local.x - center.x,
    y: local.y - center.y,
  });
  const radius = outlineRadiusAlongDirection(target, direction);
  return rotatePoint({
    x: center.x + direction.x * (radius + gap),
    y: center.y + direction.y * (radius + gap),
  }, center, target.angle ?? 0);
};

const nearestPointOnBindingOutline = (
  target: BindingGeometry,
  point: BindingPoint,
): BindingPoint => {
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const localPoint = rotatePoint(point, center, -(target.angle ?? 0));
  if (target.type === 'ellipse') {
    const radiusX = Math.max(0.5, target.width / 2);
    const radiusY = Math.max(0.5, target.height / 2);
    let bestAngle = Math.atan2(
      (localPoint.y - center.y) / radiusY,
      (localPoint.x - center.x) / radiusX,
    );
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < 96; index += 1) {
      const angle = (index / 96) * Math.PI * 2;
      const candidate = {
        x: center.x + radiusX * Math.cos(angle),
        y: center.y + radiusY * Math.sin(angle),
      };
      const candidateDistance = distanceSquared(candidate, localPoint);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        bestAngle = angle;
      }
    }
    let step = Math.PI / 96;
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const candidates = [bestAngle - step, bestAngle, bestAngle + step];
      const bestCandidate = candidates
        .map((angle) => ({
          angle,
          distance: distanceSquared({
            x: center.x + radiusX * Math.cos(angle),
            y: center.y + radiusY * Math.sin(angle),
          }, localPoint),
        }))
        .sort((first, second) => first.distance - second.distance)[0]!;
      bestAngle = bestCandidate.angle;
      bestDistance = bestCandidate.distance;
      step /= 2;
    }
    return rotatePoint({
      x: center.x + radiusX * Math.cos(bestAngle),
      y: center.y + radiusY * Math.sin(bestAngle),
    }, center, target.angle ?? 0);
  }
  const vertices = target.type === 'diamond'
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
  let best = vertices[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const first = vertices[index]!;
    const second = vertices[(index + 1) % vertices.length]!;
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const denominator = dx * dx + dy * dy;
    const projection = denominator < 0.000001
      ? 0
      : Math.max(
        0,
        Math.min(
          1,
          ((localPoint.x - first.x) * dx + (localPoint.y - first.y) * dy) / denominator,
        ),
      );
    const candidate = {
      x: first.x + dx * projection,
      y: first.y + dy * projection,
    };
    const candidateDistance = distanceSquared(candidate, localPoint);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return rotatePoint(best, center, target.angle ?? 0);
};

const outlineRadiusAlongDirection = (
  target: BindingGeometry,
  direction: BindingPoint,
): number => {
  const halfWidth = target.width / 2;
  const halfHeight = target.height / 2;
  if (target.type === 'ellipse') {
    return 1 / Math.sqrt(
      (direction.x / halfWidth) ** 2
      + (direction.y / halfHeight) ** 2,
    );
  }
  if (target.type === 'diamond') {
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

const clampFocus = (focus: number): number => {
  return Math.max(-1, Math.min(1, focus));
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

const boundPointOnBand = (
  arrow: BindingArrow,
  target: BindingGeometry,
  endpoint: 'start' | 'end',
): boolean => {
  const binding = endpoint === 'start' ? arrow.startBinding : arrow.endBinding;
  if (!binding || binding.gap === 0) {
    return false;
  }
  const points = arrow.points ?? [];
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const adjacentIndex = edgeIndex - (endpoint === 'start' ? -1 : 1);
  const edge = points[edgeIndex] ?? [0, 0];
  const adjacent = points[adjacentIndex] ?? edge;
  const edgePoint = { x: arrow.x + edge[0], y: arrow.y + edge[1] };
  const adjacentPoint = { x: arrow.x + adjacent[0], y: arrow.y + adjacent[1] };
  const focusPointAbsolute = determineFocusPoint(target, binding.focus, adjacentPoint);
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const interceptorLength = distance(adjacentPoint, edgePoint)
    + distance(adjacentPoint, center)
    + Math.max(target.width, target.height) * 2;
  const direction = normalizeVector(vectorFrom(adjacentPoint, focusPointAbsolute));
  const farPoint = {
    x: adjacentPoint.x + direction.x * interceptorLength,
    y: adjacentPoint.y + direction.y * interceptorLength,
  };
  return intersectElementWithLineSegment(target, adjacentPoint, farPoint, binding.gap).length > 1;
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
  const center = {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
  const localFirst = rotatePoint(first, center, -(element.angle ?? 0));
  const localSecond = rotatePoint(second, center, -(element.angle ?? 0));
  const polygon = element.type === 'diamond'
    ? [
        { x: element.x + Math.floor(element.width / 2) + 1, y: element.y - gap },
        { x: element.x + element.width + gap, y: element.y + Math.floor(element.height / 2) + 1 },
        { x: element.x + Math.floor(element.width / 2) + 1, y: element.y + element.height + gap },
        { x: element.x - gap, y: element.y + Math.floor(element.height / 2) + 1 },
      ]
    : [
        { x: element.x - gap, y: element.y - gap },
        { x: element.x + element.width + gap, y: element.y - gap },
        { x: element.x + element.width + gap, y: element.y + element.height + gap },
        { x: element.x - gap, y: element.y + element.height + gap },
      ];
  return intersectPolygon(localFirst, localSecond, polygon)
    .map((point) => rotatePoint(point, center, element.angle ?? 0));
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
  const outsideX = Math.max(
    element.x - local.x,
    0,
    local.x - (element.x + element.width),
  );
  const outsideY = Math.max(
    element.y - local.y,
    0,
    local.y - (element.y + element.height),
  );
  if (outsideX > 0 || outsideY > 0) {
    return Math.hypot(outsideX, outsideY);
  }
  return Math.min(
    local.x - element.x,
    element.x + element.width - local.x,
    local.y - element.y,
    element.y + element.height - local.y,
  );
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
  if (px < 0.0001 && py < 0.0001) {
    return Math.min(a, b);
  }
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
