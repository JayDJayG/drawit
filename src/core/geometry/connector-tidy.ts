import {
  axisOutlineCrossing,
  distanceToShapeOutline,
  maxBindingGap,
  pointInsideShape,
  type ShapeGeometryKind,
} from './shape-geometry';
import type { SuggestionBounds, SuggestionPoint } from '../suggestions';

export type ConnectorBoundNode = {
  kind: ShapeGeometryKind;
  bounds: SuggestionBounds;
};

export type ConnectorAxisBounds = {
  start?: ConnectorBoundNode;
  end?: ConnectorBoundNode;
};

const AXIS_TOLERANCE = (8 * Math.PI) / 180;
const COLLINEAR_TOLERANCE = 15;
const SPIKE_TOLERANCE = 150;
const COLLINEAR_DISTANCE_TOLERANCE = 0.5;

export const tidyConnectorPath = (
  points: readonly SuggestionPoint[],
): SuggestionPoint[] => {
  const deduplicated = dedupePoints(points);
  if (deduplicated.length < 2) {
    return deduplicated;
  }
  const first = deduplicated[0]!;
  const last = deduplicated[deduplicated.length - 1]!;
  const chord = distance(first, last);
  if (chord < 12) {
    return deduplicated;
  }

  const band = Math.max(8, 0.07 * chord);
  if (pathLengthWithinBand(deduplicated, band) / pathLength(deduplicated) >= 0.85) {
    return [{ ...first }, { ...last }];
  }

  let tolerance = Math.max(4, 0.04 * chord);
  let simplified = simplifyAndClean(deduplicated, tolerance);
  while (simplified.length > 8) {
    tolerance *= 1.25;
    simplified = simplifyAndClean(deduplicated, tolerance);
  }
  return simplified;
};

export const tidyConnectorAxis = (
  points: readonly SuggestionPoint[],
  samples: readonly SuggestionPoint[] = points,
  boundNodes: ConnectorAxisBounds = {},
): SuggestionPoint[] => {
  const result = points.map((point) => ({ ...point }));
  if (result.length < 2) {
    return result;
  }
  if (result.length === 2) {
    const axis = segmentAxis(result[0]!, result[1]!);
    if (!axis) {
      return result;
    }
    const minor = median(samples.map((point) => axis === 'horizontal' ? point.y : point.x));
    const snapped = snapTwoPointAxis(result, axis, minor);
    if (!spanRulesAllow(snapped, axis, boundNodes)) {
      return result;
    }
    if (!hookRulesAllow(snapped, axis, axis, boundNodes)) {
      return result;
    }
    const output = fitBoundEndpoints(snapped, [axis, axis], boundNodes);
    return attachmentRulesAllow(output, result, boundNodes)
      ? output
      : result;
  }

  const segmentAxes: Array<'horizontal' | 'vertical' | undefined> = [];
  const xDemands = new Map<number, number[]>();
  const yDemands = new Map<number, number[]>();
  for (let index = 0; index < result.length - 1; index += 1) {
    const first = result[index]!;
    const second = result[index + 1]!;
    const axis = segmentAxis(first, second);
    segmentAxes.push(axis);
    if (axis === 'horizontal') {
      const value = (first.y + second.y) / 2;
      addDemand(yDemands, index, value);
      addDemand(yDemands, index + 1, value);
    } else if (axis === 'vertical') {
      const value = (first.x + second.x) / 2;
      addDemand(xDemands, index, value);
      addDemand(xDemands, index + 1, value);
    }
  }

  if (
    [...xDemands.values(), ...yDemands.values()]
      .some((values) => hasConflict(values))
  ) {
    return result;
  }
  const snapped = result.map((point, index) => ({
    x: xDemands.has(index) ? mean(xDemands.get(index)!) : point.x,
    y: yDemands.has(index) ? mean(yDemands.get(index)!) : point.y,
  }));
  const firstAxis = segmentAxes[0];
  const lastAxis = segmentAxes.at(-1);
  if (!spanRulesAllowMulti(snapped, firstAxis, lastAxis, boundNodes)) {
    return result;
  }
  if (!hookRulesAllow(snapped, firstAxis, lastAxis, boundNodes)) {
    return result;
  }
  const fitted = fitBoundEndpoints(
    snapped,
    [firstAxis, lastAxis],
    boundNodes,
  );
  const output = removeCollinear(fitted);
  return attachmentRulesAllow(output, result, boundNodes)
    ? output
    : result;
};

const dedupePoints = (
  points: readonly SuggestionPoint[],
): SuggestionPoint[] => {
  if (points.length <= 1) {
    return points.map((point) => ({ ...point }));
  }
  const first = points[0]!;
  const last = points.at(-1)!;
  const result: SuggestionPoint[] = [{ ...first }];
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const previous = result.at(-1);
    if (point && previous && distance(point, previous) >= 0.5) {
      result.push({ ...point });
    }
  }
  while (
    result.length > 1
    && distance(result.at(-1)!, last) < COLLINEAR_DISTANCE_TOLERANCE
  ) {
    result.pop();
  }
  result.push({ ...last });
  return result;
};

const simplifyAndClean = (
  points: readonly SuggestionPoint[],
  tolerance: number,
): SuggestionPoint[] => removeOffendingVertices(rdp(points, tolerance));

const removeOffendingVertices = (
  points: readonly SuggestionPoint[],
): SuggestionPoint[] => {
  const result = points.map((point) => ({ ...point }));
  while (result.length > 2) {
    let candidate = -1;
    let largestOffense = Number.NEGATIVE_INFINITY;
    for (let index = 1; index < result.length - 1; index += 1) {
      const previous = result[index - 1]!;
      const current = result[index]!;
      const next = result[index + 1]!;
      const turn = directionalTurn(previous, current, next);
      const offense = turn > SPIKE_TOLERANCE
        ? turn - SPIKE_TOLERANCE
        : turn < COLLINEAR_TOLERANCE
          ? COLLINEAR_TOLERANCE - turn
          : undefined;
      if (
        offense !== undefined
        && (offense > largestOffense
          || (offense === largestOffense && index < candidate))
      ) {
        candidate = index;
        largestOffense = offense;
      }
    }
    if (candidate < 0) {
      break;
    }
    result.splice(candidate, 1);
  }
  return result;
};

const pathReturnsToLine = (
  first: SuggestionPoint,
  second: SuggestionPoint,
  point: SuggestionPoint,
): number => {
  return Math.abs(
    (second.x - first.x) * (first.y - point.y)
      - (first.x - point.x) * (second.y - first.y),
  ) / Math.max(0.000001, distance(first, second));
};

const pathLengthWithinBand = (
  points: readonly SuggestionPoint[],
  band: number,
): number => {
  const first = points[0]!;
  const last = points.at(-1)!;
  let inside = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const segmentLength = distance(start, end);
    if (segmentLength === 0) {
      continue;
    }
    const startDistance = signedDistanceFromLine(start, first, last);
    const endDistance = signedDistanceFromLine(end, first, last);
    const crossings = [0, 1];
    const delta = endDistance - startDistance;
    if (delta !== 0) {
      for (const boundary of [-band, band]) {
        const ratio = (boundary - startDistance) / delta;
        if (ratio > 0 && ratio < 1) {
          crossings.push(ratio);
        }
      }
    }
    crossings.sort((a, b) => a - b);
    for (let crossing = 1; crossing < crossings.length; crossing += 1) {
      const lower = crossings[crossing - 1]!;
      const upper = crossings[crossing]!;
      const middle = (lower + upper) / 2;
      const value = startDistance + delta * middle;
      if (Math.abs(value) <= band) {
        inside += segmentLength * (upper - lower);
      }
    }
  }
  return inside;
};

const signedDistanceFromLine = (
  point: SuggestionPoint,
  first: SuggestionPoint,
  last: SuggestionPoint,
): number => {
  return (
    (last.x - first.x) * (first.y - point.y)
      - (first.x - point.x) * (last.y - first.y)
  ) / Math.max(0.000001, distance(first, last));
};

const rdp = (
  points: readonly SuggestionPoint[],
  epsilon: number,
): SuggestionPoint[] => {
  if (points.length <= 2) {
    return points.map((point) => ({ ...point }));
  }
  const first = points[0]!;
  const last = points.at(-1)!;
  let maximum = epsilon;
  let index = -1;
  for (let current = 1; current < points.length - 1; current += 1) {
    const point = points[current]!;
    const deviation = pathReturnsToLine(first, last, point);
    if (deviation > maximum) {
      maximum = deviation;
      index = current;
    }
  }
  if (index < 0) {
    return [{ ...first }, { ...last }];
  }
  const left = rdp(points.slice(0, index + 1), epsilon);
  const right = rdp(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
};

const directionalTurn = (
  previous: SuggestionPoint,
  current: SuggestionPoint,
  next: SuggestionPoint,
): number => {
  const incoming = { x: current.x - previous.x, y: current.y - previous.y };
  const outgoing = { x: next.x - current.x, y: next.y - current.y };
  const denominator = Math.hypot(incoming.x, incoming.y)
    * Math.hypot(outgoing.x, outgoing.y);
  if (denominator === 0) {
    return 0;
  }
  const cosine = (
    incoming.x * outgoing.x + incoming.y * outgoing.y
  ) / denominator;
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
};

const segmentAxis = (
  first: SuggestionPoint,
  second: SuggestionPoint,
): 'horizontal' | 'vertical' | undefined => {
  const angle = Math.atan2(
    Math.abs(second.y - first.y),
    Math.abs(second.x - first.x),
  );
  if (angle <= AXIS_TOLERANCE) {
    return 'horizontal';
  }
  if (Math.abs(Math.PI / 2 - angle) <= AXIS_TOLERANCE) {
    return 'vertical';
  }
  return undefined;
};

const snapTwoPointAxis = (
  points: readonly SuggestionPoint[],
  axis: 'horizontal' | 'vertical',
  minor: number,
): SuggestionPoint[] => points.map((point) => axis === 'horizontal'
  ? { x: point.x, y: minor }
  : { x: minor, y: point.y });

const addDemand = (
  demands: Map<number, number[]>,
  index: number,
  value: number,
) => {
  const values = demands.get(index);
  if (values) {
    values.push(value);
  } else {
    demands.set(index, [value]);
  }
};

const hasConflict = (values: readonly number[]): boolean => {
  if (values.length < 2) {
    return false;
  }
  const first = values[0]!;
  return values.some((value) => Math.abs(value - first) > 1e-9);
};

const spanRulesAllow = (
  points: readonly SuggestionPoint[],
  axis: 'horizontal' | 'vertical',
  nodes: ConnectorAxisBounds,
): boolean => {
  const minor = axis === 'horizontal'
    ? (points[0]?.y ?? 0)
    : (points[0]?.x ?? 0);
  return spanContains(nodes.start, axis, minor)
    && spanContains(nodes.end, axis, axis === 'horizontal'
      ? (points.at(-1)?.y ?? 0)
      : (points.at(-1)?.x ?? 0));
};

const spanRulesAllowMulti = (
  points: readonly SuggestionPoint[],
  startAxis: 'horizontal' | 'vertical' | undefined,
  endAxis: 'horizontal' | 'vertical' | undefined,
  nodes: ConnectorAxisBounds,
): boolean => {
  const startMinor = startAxis === 'horizontal'
    ? points[0]?.y
    : startAxis === 'vertical'
      ? points[0]?.x
      : undefined;
  const endMinor = endAxis === 'horizontal'
    ? points.at(-1)?.y
    : endAxis === 'vertical'
      ? points.at(-1)?.x
      : undefined;
  return spanContains(nodes.start, startAxis, startMinor)
    && spanContains(nodes.end, endAxis, endMinor);
};

const spanContains = (
  node: ConnectorBoundNode | undefined,
  axis: 'horizontal' | 'vertical' | undefined,
  value: number | undefined,
): boolean => {
  if (!node || !axis || value === undefined) {
    return true;
  }
  const start = axis === 'horizontal' ? node.bounds.y : node.bounds.x;
  const size = axis === 'horizontal' ? node.bounds.height : node.bounds.width;
  const margin = size * 0.2;
  return value >= start + margin && value <= start + size - margin;
};

const hookRulesAllow = (
  points: readonly SuggestionPoint[],
  startAxis: 'horizontal' | 'vertical' | undefined,
  endAxis: 'horizontal' | 'vertical' | undefined,
  nodes: ConnectorAxisBounds,
): boolean => {
  if (
    nodes.start
    && startAxis
    && points[1]
    && pointInsideShape(points[1], nodes.start.kind, nodes.start.bounds)
  ) {
    return false;
  }
  if (
    nodes.end
    && endAxis
    && points.length > 1
    && pointInsideShape(
      points[points.length - 2]!,
      nodes.end.kind,
      nodes.end.bounds,
    )
  ) {
    return false;
  }
  return true;
};

const fitBoundEndpoints = (
  points: readonly SuggestionPoint[],
  endpointAxes: readonly [
    'horizontal' | 'vertical' | undefined,
    'horizontal' | 'vertical' | undefined,
  ],
  nodes: ConnectorAxisBounds,
): SuggestionPoint[] => {
  const result = points.map((point) => ({ ...point }));
  const startAxis = endpointAxes[0];
  const endAxis = endpointAxes[1];
  if (nodes.start && startAxis && result.length > 1) {
    result[0] = fitEndpoint(result, 0, 1, startAxis, nodes.start);
  }
  if (nodes.end && endAxis && result.length > 1) {
    result[result.length - 1] = fitEndpoint(
      result,
      result.length - 1,
      result.length - 2,
      endAxis,
      nodes.end,
    );
  }
  return result;
};

const fitEndpoint = (
  points: readonly SuggestionPoint[],
  endpointIndex: number,
  restIndex: number,
  axis: 'horizontal' | 'vertical',
  node: ConnectorBoundNode,
): SuggestionPoint => {
  const endpoint = points[endpointIndex]!;
  if (!pointInsideShape(endpoint, node.kind, node.bounds)) {
    return { ...endpoint };
  }
  const rest = points[restIndex]!;
  const majorDelta = axis === 'horizontal'
    ? rest.x - endpoint.x
    : rest.y - endpoint.y;
  const direction: -1 | 1 = majorDelta < 0 ? -1 : 1;
  return axisOutlineCrossing(
    endpoint,
    axis,
    direction,
    node.kind,
    node.bounds,
  ) ?? { ...endpoint };
};

const attachmentRulesAllow = (
  output: readonly SuggestionPoint[],
  input: readonly SuggestionPoint[],
  nodes: ConnectorAxisBounds,
): boolean => {
  return attachmentRuleAllows(output[0], input[0], nodes.start)
    && attachmentRuleAllows(output.at(-1), input.at(-1), nodes.end);
};

const attachmentRuleAllows = (
  output: SuggestionPoint | undefined,
  input: SuggestionPoint | undefined,
  node: ConnectorBoundNode | undefined,
): boolean => {
  if (!output || !input || !node) {
    return true;
  }
  const inputDistance = pointInsideShape(input, node.kind, node.bounds)
    ? 0
    : distanceToShapeOutline(input, node.kind, node.bounds);
  const outputDistance = pointInsideShape(output, node.kind, node.bounds)
    ? 0
    : distanceToShapeOutline(output, node.kind, node.bounds);
  return outputDistance <= Math.max(
    maxBindingGap(node.kind, node.bounds),
    inputDistance,
  );
};

const removeCollinear = (
  points: readonly SuggestionPoint[],
): SuggestionPoint[] => {
  const result = points.map((point) => ({ ...point }));
  for (let index = result.length - 2; index > 0; index -= 1) {
    const previous = result[index - 1]!;
    const current = result[index]!;
    const next = result[index + 1]!;
    const cross = (
      (current.x - previous.x) * (next.y - current.y)
        - (current.y - previous.y) * (next.x - current.x)
    );
    const dot = (
      (current.x - previous.x) * (next.x - current.x)
        + (current.y - previous.y) * (next.y - current.y)
    );
    if (Math.abs(cross) <= COLLINEAR_DISTANCE_TOLERANCE && dot >= 0) {
      result.splice(index, 1);
    }
  }
  return result;
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const mean = (values: readonly number[]): number => {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const pathLength = (points: readonly SuggestionPoint[]): number => {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1]!, points[index]!);
  }
  return length;
};

const distance = (
  first: SuggestionPoint,
  second: SuggestionPoint,
): number => Math.hypot(first.x - second.x, first.y - second.y);
