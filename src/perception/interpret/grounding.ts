import type {
  ConnectorSuggestionItem,
  SuggestionPlan,
  SuggestionPoint,
} from '../../core/suggestions';
import type { InterpretRequest, InterpretStroke } from './types';

type Shaft = {
  tail: SuggestionPoint;
  tip: SuggestionPoint;
  diameter: number;
  pathLength: number;
};

export const groundConnectorEndpoints = (
  plan: SuggestionPlan,
  request: InterpretRequest,
): SuggestionPlan => {
  const strokesById = new Map(request.strokes.map((stroke) => [stroke.id, stroke]));
  let changed = false;
  const items = plan.items.map((item) => {
    if (item.kind !== 'connector') {
      return item;
    }
    const grounded = groundConnector(item, strokesById);
    if (grounded === item) {
      return item;
    }
    changed = true;
    return grounded;
  });
  return changed ? { ...plan, items } : plan;
};

const groundConnector = (
  connector: ConnectorSuggestionItem,
  strokesById: ReadonlyMap<string, InterpretStroke>,
): ConnectorSuggestionItem => {
  if (connector.points.length < 2) {
    return connector;
  }
  const shafts = connector.sourceIds
    .map((sourceId) => strokesById.get(sourceId))
    .filter((stroke): stroke is InterpretStroke => Boolean(stroke))
    .map((stroke) => {
      const pair = farthestPair(stroke.points);
      if (!pair) {
        return undefined;
      }
      return {
        tail: pair.first,
        tip: pair.second,
        diameter: Math.sqrt(pair.distanceSquared),
        pathLength: strokePathLength(stroke.points),
      };
    })
    .filter((shaft): shaft is Shaft => Boolean(shaft));
  const shaft = shafts[0] ? shafts.reduce((largest, candidate) => {
    return candidate.diameter > largest.diameter ? candidate : largest;
  }) : undefined;
  if (!shaft || shaft.diameter < 20) {
    return connector;
  }
  const nextLargest = shafts
    .filter((candidate) => candidate !== shaft)
    .reduce<number | undefined>((largest, candidate) => {
      return largest === undefined
        ? candidate.diameter
        : Math.max(largest, candidate.diameter);
    }, undefined);
  if (nextLargest !== undefined && shaft.diameter < 1.5 * nextLargest) {
    return connector;
  }
  if (shaft.pathLength > 1.5 * shaft.diameter) {
    return connector;
  }

  const [modelFirst, modelLast] = [
    connector.points[0],
    connector.points[connector.points.length - 1],
  ];
  if (!modelFirst || !modelLast) {
    return connector;
  }
  let tail = shaft.tail;
  let tip = shaft.tip;
  const forwardDistance = pointDistance(modelFirst, tail)
    + pointDistance(modelLast, tip);
  const reverseDistance = pointDistance(modelFirst, tip)
    + pointDistance(modelLast, tail);
  if (reverseDistance < forwardDistance) {
    tail = shaft.tip;
    tip = shaft.tail;
  }

  const threshold = Math.max(8, 0.1 * shaft.diameter);
  let endpointChanged = false;
  const points = connector.points.map((point, index) => {
    if (index === 0 && distanceToLine(point, tail, tip) > threshold) {
      endpointChanged = true;
      return [tail.x, tail.y] as [number, number];
    }
    if (
      index === connector.points.length - 1
      && distanceToLine(point, tail, tip) > threshold
    ) {
      endpointChanged = true;
      return [tip.x, tip.y] as [number, number];
    }
    return point;
  });
  return endpointChanged ? { ...connector, points } : connector;
};

const farthestPair = (
  points: readonly SuggestionPoint[],
): { first: SuggestionPoint; second: SuggestionPoint; distanceSquared: number } | undefined => {
  if (points.length < 2) {
    return undefined;
  }
  let first = points[0]!;
  let second = points[1]!;
  let distanceSquared = squaredDistance(first, second);
  for (let firstIndex = 0; firstIndex < points.length - 1; firstIndex += 1) {
    const firstPoint = points[firstIndex];
    if (!firstPoint) {
      continue;
    }
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < points.length;
      secondIndex += 1
    ) {
      const secondPoint = points[secondIndex];
      if (!secondPoint) {
        continue;
      }
      const candidateDistanceSquared = squaredDistance(firstPoint, secondPoint);
      if (candidateDistanceSquared > distanceSquared) {
        first = firstPoint;
        second = secondPoint;
        distanceSquared = candidateDistanceSquared;
      }
    }
  }
  return { first, second, distanceSquared };
};

const squaredDistance = (
  first: SuggestionPoint | readonly [number, number],
  second: SuggestionPoint | readonly [number, number],
): number => {
  const firstX = 'x' in first ? first.x : first[0];
  const firstY = 'y' in first ? first.y : first[1];
  const secondX = 'x' in second ? second.x : second[0];
  const secondY = 'y' in second ? second.y : second[1];
  return (firstX - secondX) ** 2 + (firstY - secondY) ** 2;
};

const strokePathLength = (points: readonly SuggestionPoint[]): number => {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) {
      length += Math.sqrt(squaredDistance(previous, current));
    }
  }
  return length;
};

const pointDistance = (
  first: readonly [number, number],
  second: SuggestionPoint,
): number => Math.hypot(first[0] - second.x, first[1] - second.y);

const distanceToLine = (
  point: readonly [number, number],
  lineStart: SuggestionPoint,
  lineEnd: SuggestionPoint,
): number => {
  const deltaX = lineEnd.x - lineStart.x;
  const deltaY = lineEnd.y - lineStart.y;
  return Math.abs(
    deltaX * (lineStart.y - point[1])
      - (lineStart.x - point[0]) * deltaY,
  ) / Math.hypot(deltaX, deltaY);
};
