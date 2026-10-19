import {
  alignNodes,
  boundsCenter,
  buildContainment,
  distanceToBounds,
  pointInBounds,
} from '../../core/structure';
import type {
  NodeRef,
  ShapeSuggestionItem,
  SuggestionBounds,
  SuggestionItem,
  SuggestionPlan,
  SuggestionPoint,
} from '../../core/suggestions';
import type { T0DiagramInput, T0NativeNode, T0Stroke, T0Text } from './types';

type DetectedNode = {
  item: ShapeSuggestionItem;
  points: SuggestionPoint[];
  strokeIndexes: number[];
};

type DetectedConnector = {
  item: SuggestionItem & { kind: 'connector' };
  points: SuggestionPoint[];
  strokeIndexes: number[];
};

type ShapeCandidate = {
  kind: ShapeSuggestionItem['shape'];
  bounds: SuggestionBounds;
  points: SuggestionPoint[];
  confidence: number;
};

export const recognizeDiagram = (input: T0DiagramInput): SuggestionPlan => {
  const strokes = input.strokes.map((stroke) => ({
    ...stroke,
    points: cleanPoints(stroke.points),
  }));
  const usedStrokeIndexes = new Set<number>();
  const nodes: DetectedNode[] = [];
  const nodeByRef = new Map<string, DetectedNode>();

  const singleCandidates = strokes.map((stroke, index) => ({
    index,
    candidate: detectClosedShape(stroke.points),
  }));
  for (const { index, candidate } of singleCandidates) {
    if (!candidate) {
      continue;
    }
    const stroke = strokes[index];
    if (!stroke) {
      continue;
    }
    const item = makeShapeItem(candidate, [stroke.id]);
    const detected = { item, points: candidate.points, strokeIndexes: [index] };
    nodes.push(detected);
    usedStrokeIndexes.add(index);
    nodeByRef.set(item.id, detected);
  }

  const multiCandidates = detectMultiStrokeShapes(
    strokes,
    usedStrokeIndexes,
    nodes.map(({ item }) => ({
      kind: item.shape,
      bounds: {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      },
    })),
  );
  for (const candidate of multiCandidates) {
    const sourceIds = candidate.strokeIndexes
      .map((index) => strokes[index]?.id)
      .filter((id): id is string => Boolean(id));
    if (sourceIds.length === 0) {
      continue;
    }
    const item = makeShapeItem(candidate.shape, sourceIds);
    const detected = {
      item,
      points: candidate.shape.points,
      strokeIndexes: candidate.strokeIndexes,
    };
    nodes.push(detected);
    candidate.strokeIndexes.forEach((index) => usedStrokeIndexes.add(index));
    nodeByRef.set(item.id, detected);
  }

  const nativeNodes = (input.nativeNodes ?? []).map((node) => ({
    ...node,
    ref: { elementId: node.id } as NodeRef,
  }));
  const containerCandidates = new Set(
    nodes
      .filter((outer) => nodes.some((inner) => (
        inner !== outer
        && contains(
          {
            x: outer.item.x,
            y: outer.item.y,
            width: outer.item.width,
            height: outer.item.height,
          },
          {
            x: inner.item.x,
            y: inner.item.y,
            width: inner.item.width,
            height: inner.item.height,
          },
        )
      )))
      .map((node) => node.item.id),
  );
  const allNodeGeometry = [
    ...nodes.map((node) => ({
      ref: { itemId: node.item.id } as NodeRef,
      kind: node.item.shape,
      bounds: {
        x: node.item.x,
        y: node.item.y,
        width: node.item.width,
        height: node.item.height,
      },
    })),
    ...nativeNodes,
  ];
  const bindingNodeGeometry = allNodeGeometry.filter((node) => {
    return !('itemId' in node.ref) || !containerCandidates.has(node.ref.itemId);
  });
  const connectorCandidateIndexes = new Set(
    strokes
      .map((stroke, index) => (
        !usedStrokeIndexes.has(index)
        && !isStandaloneArrowheadStroke(stroke.points)
        && isConnectorCandidate(stroke.points, bindingNodeGeometry)
          ? index
          : undefined
      ))
      .filter((index): index is number => index !== undefined),
  );

  const connectors: DetectedConnector[] = [];
  const arrowheadStrokeIndexes = new Set<number>();
  for (let index = 0; index < strokes.length; index += 1) {
    if (usedStrokeIndexes.has(index)) {
      continue;
    }
    const stroke = strokes[index];
    if (
      !stroke
      || isStandaloneArrowheadStroke(stroke.points)
      || !isConnectorCandidate(stroke.points, bindingNodeGeometry)
    ) {
      continue;
    }
    const inline = detectInlineArrowheads(stroke.points, bindingNodeGeometry);
    const normalizedInline = trimInlineArrowheads(
      stroke.points,
      inline,
      {
        start: nearestInlineTip(stroke.points, true, bindingNodeGeometry),
        end: nearestInlineTip(stroke.points, false, bindingNodeGeometry),
      },
    );
    const connectorPoints = ensureEndpointSegmentLength(
      simplifyConnectorPoints(normalizedInline.points),
      normalizedInline,
    );
    if (connectorPoints.length < 2) {
      continue;
    }

    const sourceIds = [stroke.id];
    const nearby = findSeparateArrowheadStrokes(
      index,
      strokes,
      usedStrokeIndexes,
      connectorPoints,
      normalizedInline,
      connectorCandidateIndexes,
    );
    for (const arrowhead of nearby) {
      arrowheadStrokeIndexes.add(arrowhead.index);
      usedStrokeIndexes.add(arrowhead.index);
      const id = strokes[arrowhead.index]?.id;
      if (id) {
        sourceIds.push(id);
      }
    }

    const start = snapEndpoint(
      connectorPoints[0],
      connectorPoints[1],
      bindingNodeGeometry,
    );
    const end = snapEndpoint(
      connectorPoints[connectorPoints.length - 1],
      connectorPoints[connectorPoints.length - 2],
      bindingNodeGeometry,
    );
    const fittedPoints = connectorPoints.map((point, pointIndex) => {
      if (pointIndex === 0 && start) {
        return start.point;
      }
      if (pointIndex === connectorPoints.length - 1 && end) {
        return end.point;
      }
      return point;
    });
    const item = {
      id: makeItemId('connector', sourceIds),
      kind: 'connector' as const,
      sourceIds,
      points: fittedPoints.map((point) => [point.x, point.y] as [number, number]),
      start: start?.ref ?? null,
      end: end?.ref ?? null,
      startArrowhead: (normalizedInline.start ? 'arrow' : nearby.some((arrow) => arrow.end === 'start') ? 'arrow' : null) as 'arrow' | null,
      endArrowhead: (normalizedInline.end ? 'arrow' : nearby.some((arrow) => arrow.end === 'end') ? 'arrow' : null) as 'arrow' | null,
      confidence: connectorConfidence(stroke.points, start !== undefined || end !== undefined),
    };
    connectors.push({
      item,
      points: connectorPoints,
      strokeIndexes: [index, ...nearby.map((arrow) => arrow.index)],
    });
    usedStrokeIndexes.add(index);
  }

  const alignedNodes = alignNodes(
    nodes.map(({ item }) => ({
      ref: { itemId: item.id },
      kind: item.shape,
      bounds: { x: item.x, y: item.y, width: item.width, height: item.height },
      sourceIds: [...item.sourceIds],
      children: [],
      label: item.label,
    })),
  );
  const containedNodes = buildContainment([
    ...alignedNodes,
    ...nativeNodes.map((node) => ({
      ref: node.ref,
      kind: node.kind,
      bounds: { ...node.bounds },
      sourceIds: [],
      children: [],
    })),
  ]);

  const alignedById = new Map<string, typeof containedNodes[number]>();
  for (const node of containedNodes) {
    if ('itemId' in node.ref) {
      alignedById.set(node.ref.itemId, node);
    }
  }
  for (const node of nodes) {
    const aligned = alignedById.get(node.item.id);
    if (!aligned) {
      continue;
    }
    node.item.x = aligned.bounds.x;
    node.item.y = aligned.bounds.y;
    node.item.width = aligned.bounds.width;
    node.item.height = aligned.bounds.height;
    node.item.children = aligned.children
      .filter((ref): ref is { itemId: string } => 'itemId' in ref)
      .map((ref) => ref.itemId);
  }

  consumeTextLabels(
    nodes,
    connectors,
    input.texts.filter((text) => !text.containerId),
    allNodeGeometry,
  );

  const items: SuggestionItem[] = [
    ...nodes
      .sort(compareDetectedNodes)
      .map(({ item }) => item),
    ...connectors
      .sort(compareDetectedConnectors)
      .map(({ item }) => item),
  ];
  const consumedStrokeIndexes = new Set<number>(
    items.flatMap((item) => item.sourceIds.flatMap((sourceId) => {
      const index = strokes.findIndex((stroke) => stroke.id === sourceId);
      return index >= 0 ? [index] : [];
    })),
  );
  const unresolved = strokes
    .filter((_stroke, index) => !consumedStrokeIndexes.has(index))
    .map((stroke) => ({
      sourceIds: [stroke.id],
      reason: arrowheadStrokeIndexes.has(strokes.indexOf(stroke))
        ? 'arrowhead could not be attached to a connector'
        : 'ambiguous or unsupported stroke',
    }));

  return {
    version: 1,
    lens: 'diagram',
    tier: 't0',
    items,
    unresolved,
  };
};

export const detectClosedShape = (
  points: readonly SuggestionPoint[],
): ShapeCandidate | undefined => {
  const cleaned = cleanPoints(points);
  if (cleaned.length < 5) {
    return undefined;
  }
  const bounds = getBounds(cleaned);
  const diagonal = Math.hypot(bounds.width, bounds.height);
  if (diagonal < 28 || Math.min(bounds.width, bounds.height) < 12) {
    return undefined;
  }
  const path = pathLength(cleaned);
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (!first || !last) {
    return undefined;
  }
  const closureGap = distance(first, last);
  const closureTolerance = Math.max(20, diagonal * 0.28);
  if (closureGap > closureTolerance || path < Math.max(55, diagonal * 1.7)) {
    return undefined;
  }

  const withoutClosingPoint = closureGap <= closureTolerance
    ? cleaned.slice(0, -1)
    : cleaned;
  if (withoutClosingPoint.length < 4) {
    return undefined;
  }
  const sampled = resamplePath(withoutClosingPoint, 48, true);
  const simplified = rdp(withoutClosingPoint, Math.max(2.25, diagonal * 0.018));
  const hull = convexHull(sampled);
  const hullArea = Math.abs(polygonArea(hull));
  const loopArea = Math.abs(polygonArea(sampled));
  const bboxArea = Math.max(1, bounds.width * bounds.height);
  const areaRatio = loopArea / bboxArea;
  const hullRatio = hullArea / bboxArea;
  const corners = getCorners(simplified);
  const aspect = Math.min(bounds.width, bounds.height) / Math.max(bounds.width, bounds.height);
  const ellipseError = ellipseFitError(sampled, bounds);
  const diamondError = diamondFitError(sampled, bounds);
  const rectangleError = rectangleFitError(sampled, bounds);
  const isSelfIntersecting = loopArea < hullArea * 0.55
    || path / Math.max(1, diagonal) > 12;
  if (
    isSelfIntersecting
    || hull.length < 4
    || areaRatio < 0.18
    || hullRatio < 0.28
  ) {
    return undefined;
  }

  const diamondEvidence = (
    hull.length <= 6
    && areaRatio < 0.68
    && diamondError <= ellipseError * 0.9
    && diamondError <= rectangleError * 0.8
  ) || (
    corners.length >= 4
    && corners.length <= 6
    && areaRatio < 0.62
    && diamondError < 0.16
  ) || (
    areaRatio < 0.58
    && diamondError < 0.16
    && diamondError + 0.05 < ellipseError
    && diamondError + 0.1 < rectangleError
  );
  if (diamondEvidence) {
    return {
      kind: 'diamond',
      bounds,
      points: cleaned,
      confidence: Math.min(0.96, 0.82 + Math.max(0, 0.68 - areaRatio) * 0.4),
    };
  }

  const ellipseEvidence = (
    aspect > 0.28
    && areaRatio >= 0.62
    && areaRatio <= 0.91
    && ellipseError < 0.105
    && ellipseError + 0.018 < diamondError
    && ellipseError + 0.012 < rectangleError
    && (hull.length >= 7 || corners.length < 4)
  );
  if (ellipseEvidence) {
    return {
      kind: 'ellipse',
      bounds,
      points: cleaned,
      confidence: Math.min(0.96, 0.84 + Math.max(0, 0.105 - ellipseError)),
    };
  }

  const polygonEvidence = (
    rectangleError < 0.16
    && (hull.length <= 10 || corners.length >= 3)
    && areaRatio > 0.62
  ) || (
    hull.length <= 6
    && areaRatio > 0.68
    && rectangleError <= ellipseError
  ) || (
    rectangleError < 0.12
    && areaRatio > 0.86
    && rectangleError + 0.025 < ellipseError
  ) || (
    rectangleError < 0.11
    && areaRatio > 0.78
    && rectangleError <= ellipseError + 0.01
  ) || (
    rectangleError < 0.18
    && areaRatio > 0.7
    && corners.length >= 4
    && rectangleError <= ellipseError + 0.04
  );
  if (polygonEvidence) {
    const rounded = clearlyRoundedRectangle(
      sampled,
      simplified,
      bounds,
      areaRatio,
      corners.length,
    );
    return {
      kind: rounded ? 'roundedRectangle' : 'rectangle',
      bounds: fitRectangleBounds(cleaned, bounds),
      points: cleaned,
      confidence: rounded ? 0.86 : 0.94,
    };
  }

  if (
    aspect > 0.28
    && areaRatio >= 0.58
    && areaRatio <= 0.94
    && ellipseError < diamondError
    && ellipseError < rectangleError
  ) {
    return {
      kind: 'ellipse',
      bounds,
      points: cleaned,
      confidence: 0.8,
    };
  }

  return undefined;
};

type MultiShape = {
  shape: ShapeCandidate;
  strokeIndexes: number[];
};

const looksLikeKnownNodeConnector = (
  points: readonly SuggestionPoint[],
  knownNodes: readonly {
    kind: ShapeSuggestionItem['shape'];
    bounds: SuggestionBounds;
  }[],
): boolean => {
  if (knownNodes.length === 0 || points.length < 2) {
    return false;
  }
  const endpoints = [points[0], points[points.length - 1]].filter(
    (point): point is SuggestionPoint => Boolean(point),
  );
  if (endpoints.length !== 2) {
    return false;
  }
  const endpointMatches = endpoints.map((endpoint) => knownNodes
    .map((node, index) => ({
      index,
      distance: distanceToShapeOutline(endpoint, node.kind, node.bounds),
    }))
    .filter(({ distance: nodeDistance }) => nodeDistance <= 20)
    .map(({ index }) => index));
  if (endpointMatches[0]?.length === 0 || endpointMatches[1]?.length === 0) {
    return false;
  }
  const distinctNodes = new Set([
    ...(endpointMatches[0] ?? []),
    ...(endpointMatches[1] ?? []),
  ]);
  return distinctNodes.size >= 2 || pathLength(points) >= 80;
};

export const detectMultiStrokeShapes = (
  strokes: readonly T0Stroke[],
  usedStrokeIndexes: ReadonlySet<number>,
  knownNodes: readonly {
    kind: ShapeSuggestionItem['shape'];
    bounds: SuggestionBounds;
  }[] = [],
): MultiShape[] => {
  const candidates = strokes
    .map((stroke, index) => ({
      stroke,
      index,
      bounds: getBounds(stroke.points),
      simplified: simplifyShapeStroke(stroke.points),
    }))
    .filter(({ index, stroke, simplified }) => {
      return !usedStrokeIndexes.has(index)
        && simplified.length >= 2
        && shapeStrokeLength(stroke.points) >= 24
        && !isArrowheadStroke(stroke.points)
        && !isBarbStroke(stroke.points)
        && !looksLikeKnownNodeConnector(stroke.points, knownNodes);
    });
  if (candidates.length < 2) {
    return [];
  }

  const allPoints = candidates.flatMap(({ stroke }) => stroke.points);
  const allBounds = getBounds(allPoints);
  const tolerance = Math.max(
    20,
    Math.min(allBounds.width, allBounds.height) * 0.18,
  );
  const links = new Map<number, Set<number>>();
  candidates.forEach(({ index }) => links.set(index, new Set()));
  for (let first = 0; first < candidates.length; first += 1) {
    const firstCandidate = candidates[first];
    if (!firstCandidate) {
      continue;
    }
    for (let second = first + 1; second < candidates.length; second += 1) {
      const secondCandidate = candidates[second];
      if (!secondCandidate) {
        continue;
      }
      if (strokesCanJoin(
        firstCandidate.stroke.points,
        secondCandidate.stroke.points,
        tolerance,
        secondCandidate.bounds,
      )) {
        links.get(firstCandidate.index)?.add(secondCandidate.index);
        links.get(secondCandidate.index)?.add(firstCandidate.index);
      }
    }
  }
  const result: MultiShape[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (seen.has(candidate.index)) {
      continue;
    }
    const component = collectComponent(candidate.index, links, seen);
    if (component.length < 2) {
      seen.add(candidate.index);
      continue;
    }
    const componentCandidates = component
      .map((index) => candidates.find((entry) => entry.index === index))
      .filter((entry): entry is {
        stroke: T0Stroke;
        index: number;
        bounds: SuggestionBounds;
        simplified: SuggestionPoint[];
      } => Boolean(entry))
      .map(({ stroke, index, bounds }) => ({ stroke, index, bounds }))
      .sort((first, second) => first.index - second.index);
    const closedSubset = findClosedStrokeSubset(componentCandidates, tolerance, links);
    if (!closedSubset) {
      seen.add(candidate.index);
      continue;
    }
    const shape = classifyMultiStrokeShape(closedSubset);
    if (!shape) {
      seen.add(candidate.index);
      continue;
    }
    result.push({
      shape,
      strokeIndexes: closedSubset.map(({ index }) => index).sort((a, b) => a - b),
    });
    closedSubset.forEach(({ index }) => seen.add(index));
  }
  return result;
};

const findClosedStrokeSubset = (
  candidates: readonly { stroke: T0Stroke; index: number }[],
  tolerance: number,
  links: ReadonlyMap<number, ReadonlySet<number>>,
): { stroke: T0Stroke; index: number }[] | undefined => {
  const possible: { entries: { stroke: T0Stroke; index: number }[]; score: number }[] = [];
  for (let size = 2; size <= Math.min(4, candidates.length); size += 1) {
    enumerateConnectedCombinations(candidates, size, links, (subset) => {
      if (!isClosedEndpointComponent(subset, tolerance)) {
        return;
      }
      const shape = classifyMultiStrokeShape(subset);
      if (!shape) {
        return;
      }
      const score = multiStrokeScore(subset, shape);
      possible.push({ entries: subset, score });
    });
  }
  possible.sort((first, second) => second.score - first.score);
  const best = possible[0];
  if (best) {
    return best.entries;
  }
  return undefined;
};

const enumerateConnectedCombinations = <T extends { index: number }>(
  values: readonly T[],
  size: number,
  links: ReadonlyMap<number, ReadonlySet<number>>,
  callback: (values: T[]) => void,
): void => {
  const byIndex = new Map(values.map((value) => [value.index, value]));
  const visited = new Set<string>();
  for (const start of values) {
    const selected = [start];
    const selectedIndexes = new Set([start.index]);
    const visit = () => {
      if (selected.length === size) {
        const key = [...selectedIndexes].sort((first, second) => first - second).join(',');
        if (!visited.has(key)) {
          visited.add(key);
          callback([...selected].sort((first, second) => first.index - second.index));
        }
        return;
      }
      const candidates = new Set<number>();
      for (const entry of selected) {
        for (const linked of links.get(entry.index) ?? []) {
          if (!selectedIndexes.has(linked) && byIndex.has(linked) && linked >= start.index) {
            candidates.add(linked);
          }
        }
      }
      for (const index of [...candidates].sort((first, second) => first - second)) {
        const next = byIndex.get(index);
        if (!next) {
          continue;
        }
        selected.push(next);
        selectedIndexes.add(index);
        visit();
        selectedIndexes.delete(index);
        selected.pop();
      }
    };
    visit();
  }
};

const consumeTextLabels = (
  nodes: DetectedNode[],
  connectors: DetectedConnector[],
  texts: readonly T0Text[],
  allNodeGeometry: readonly {
    ref: NodeRef;
    kind: T0NativeNode['kind'];
    bounds: SuggestionBounds;
  }[],
) => {
  const consumed = new Set<string>();
  const nodeTexts = new Map<string, T0Text[]>();
  for (const text of texts) {
    const center = textCenter(text);
    const matches = allNodeGeometry
      .filter((node) => pointInBounds(center, node.bounds, 0))
      .sort((first, second) => area(first.bounds) - area(second.bounds));
    const match = matches[0];
    const itemRef = match && 'itemId' in match.ref ? match.ref : undefined;
    if (!match || !itemRef) {
      continue;
    }
    const matchedNode = nodes.find((node) => node.item.id === itemRef.itemId);
    const distanceToConnector = connectors.reduce((minimum, connector) => {
      const middle = connector.points.slice(
        Math.floor(connector.points.length * 0.15),
        Math.ceil(connector.points.length * 0.85),
      );
      return Math.min(minimum, distanceToPolyline(center, middle));
    }, Number.POSITIVE_INFINITY);
    if (matchedNode) {
      const nodeBounds = {
        x: matchedNode.item.x,
        y: matchedNode.item.y,
        width: matchedNode.item.width,
        height: matchedNode.item.height,
      };
      const nodeCenterDistance = distance(center, boundsCenter(nodeBounds));
      const connectorThreshold = Math.max(20, text.height * 1.75);
      const isNearNodeEdge = nodeCenterDistance > Math.max(
        text.height,
        Math.min(nodeBounds.width, nodeBounds.height) * 0.3,
      );
      if (
        distanceToConnector <= connectorThreshold
        && (
          (matchedNode.item.children?.length ?? 0) > 0
          || isNearNodeEdge
        )
      ) {
        continue;
      }
    }
    const current = nodeTexts.get(itemRef.itemId) ?? [];
    current.push(text);
    nodeTexts.set(itemRef.itemId, current);
    consumed.add(text.id);
  }
  for (const node of nodes) {
    const labels = nodeTexts.get(node.item.id);
    if (!labels || labels.length === 0) {
      continue;
    }
    labels.sort(compareText);
    node.item.label = labels.map((text) => text.text.trim()).filter(Boolean).join('\n');
    node.item.sourceIds.push(...labels.map((text) => text.id));
  }

  const connectorAssignments = texts
    .filter((text) => !consumed.has(text.id))
    .map((text) => {
      const center = textCenter(text);
      const candidates = connectors
        .map((connector) => ({
          connector,
          distance: distanceToPolyline(
            center,
            connector.points.slice(
              Math.floor(connector.points.length * 0.15),
              Math.ceil(connector.points.length * 0.85),
            ),
          ),
        }))
        .filter(({ distance: distanceToMiddle }) => {
          return distanceToMiddle <= Math.max(20, text.height * 1.75);
        })
        .sort((first, second) => first.distance - second.distance);
      return { text, candidates };
    })
    .filter(({ candidates }) => candidates.length > 0)
    .sort((first, second) => {
      const firstMargin = (first.candidates[1]?.distance ?? Number.POSITIVE_INFINITY)
        - (first.candidates[0]?.distance ?? Number.POSITIVE_INFINITY);
      const secondMargin = (second.candidates[1]?.distance ?? Number.POSITIVE_INFINITY)
        - (second.candidates[0]?.distance ?? Number.POSITIVE_INFINITY);
      return first.candidates.length - second.candidates.length
        || secondMargin - firstMargin
        || (first.candidates[0]?.distance ?? 0) - (second.candidates[0]?.distance ?? 0);
    });
  const labeledConnectors = new Set<string>();
  for (const assignment of connectorAssignments) {
    const candidate = assignment.candidates.find(({ connector }) => {
      return !labeledConnectors.has(connector.item.id);
    });
    if (!candidate) {
      continue;
    }
    const connector = candidate.connector;
    connector.item.label = assignment.text.text.trim();
    connector.item.sourceIds.push(assignment.text.id);
    labeledConnectors.add(connector.item.id);
    consumed.add(assignment.text.id);
  }
};

const makeShapeItem = (
  candidate: ShapeCandidate,
  sourceIds: string[],
): ShapeSuggestionItem => ({
  id: makeItemId('shape', sourceIds),
  kind: 'shape',
  shape: candidate.kind,
  x: candidate.bounds.x,
  y: candidate.bounds.y,
  width: Math.max(1, candidate.bounds.width),
  height: Math.max(1, candidate.bounds.height),
  sourceIds,
  confidence: candidate.confidence,
});

const makeItemId = (prefix: string, sourceIds: readonly string[]): string => {
  return `${prefix}-${sourceIds.join('-').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
};

const classifyMultiStrokeShape = (
  entries: readonly { stroke: T0Stroke; index: number }[],
): ShapeCandidate | undefined => {
  if (entries.some(({ stroke }) => {
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    if (!first || !last) {
      return true;
    }
    return distance(first, last) / Math.max(1, pathLength(stroke.points)) < 0.3;
  })) {
    return undefined;
  }
  const points = entries.flatMap(({ stroke }) => stroke.points);
  const bounds = getBounds(points);
  const diagonal = Math.hypot(bounds.width, bounds.height);
  if (bounds.width < 25 || bounds.height < 25 || diagonal === 0) {
    return undefined;
  }
  const hull = convexHull(points);
  const areaRatio = Math.abs(polygonArea(hull))
    / Math.max(1, bounds.width * bounds.height);
  const diamondError = diamondFitError(points, bounds);
  const rectangleError = rectangleFitError(points, bounds);
  if (!hasMultiStrokeDirectionChange(entries)) {
    return undefined;
  }
  const isDiamond = (
    areaRatio < 0.68
    && diamondError < 0.2
    && diamondError < rectangleError
  ) || (
    hull.length <= 6
    && areaRatio < 0.6
    && diamondError < 0.24
  );
  if (!isDiamond && rectangleError > 0.18) {
    return undefined;
  }
  if (areaRatio < 0.28 || areaRatio > 1.08) {
    return undefined;
  }
  const fittedBounds = isDiamond
    ? fitDiamondBounds(points, bounds)
    : fitRectangleBounds(
        points,
        bounds,
        entries.map(({ stroke }) => stroke.points),
      );
  return {
    kind: isDiamond ? 'diamond' : 'rectangle',
    bounds: fittedBounds,
    points: points.map((point) => ({ ...point })),
    confidence: isDiamond ? 0.88 : 0.93,
  };
};

const isClosedEndpointComponent = (
  entries: readonly { stroke: T0Stroke; index: number }[],
  tolerance: number,
): boolean => {
  const endpoints = entries.flatMap((entry) => {
    const first = entry.stroke.points[0];
    const last = entry.stroke.points[entry.stroke.points.length - 1];
    return first && last
      ? [
          { point: first, parent: entry.index, stroke: entry.stroke },
          { point: last, parent: entry.index, stroke: entry.stroke },
        ]
      : [];
  });
  if (endpoints.length !== entries.length * 2) {
    return false;
  }

  const neighborCounts = endpoints.map((endpoint, index) => {
    let count = 0;
    for (let other = 0; other < endpoints.length; other += 1) {
      if (other === index) {
        continue;
      }
      const candidate = endpoints[other];
      if (!candidate || candidate.parent === endpoint.parent) {
        continue;
      }
      if (
        distance(endpoint.point, candidate.point) <= tolerance
        || endpointToStrokeDistance(endpoint.point, candidate.stroke.points)
          <= tolerance
      ) {
        count += 1;
      }
    }
    return count;
  });
  return neighborCounts.every((count) => count >= 1);
};

const hasMultiStrokeDirectionChange = (
  entries: readonly { stroke: T0Stroke; index: number }[],
): boolean => {
  const angles = entries
    .flatMap(({ stroke }) => {
      const bounds = getBounds(stroke.points);
      const simplified = rdp(
        stroke.points,
        Math.max(2, Math.min(8, Math.max(bounds.width, bounds.height) * 0.04)),
      );
      return simplified.slice(1).map((point, index) => {
        const previous = simplified[index];
        return previous
          ? normalizeAngle(Math.atan2(point.y - previous.y, point.x - previous.x))
          : undefined;
      });
    })
    .filter((angle): angle is number => angle !== undefined);
  for (let first = 0; first < angles.length; first += 1) {
    for (let second = first + 1; second < angles.length; second += 1) {
      const difference = Math.abs((angles[first] ?? 0) - (angles[second] ?? 0));
      const folded = Math.min(difference, Math.PI - difference);
      if (folded >= 0.35) {
        return true;
      }
    }
  }
  return false;
};

const collectComponent = (
  start: number,
  links: ReadonlyMap<number, ReadonlySet<number>>,
  blocked: ReadonlySet<number>,
): number[] => {
  const result: number[] = [];
  const queue = [start];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    if (current !== start && blocked.has(current)) {
      continue;
    }
    seen.add(current);
    result.push(current);
    queue.push(...(links.get(current) ?? []));
  }
  return result;
};

const strokesTouch = (
  first: readonly SuggestionPoint[],
  second: readonly SuggestionPoint[],
  tolerance: number,
): boolean => {
  const firstEnds = [first[0], first[first.length - 1]].filter(
    (point): point is SuggestionPoint => Boolean(point),
  );
  const secondEnds = [second[0], second[second.length - 1]].filter(
    (point): point is SuggestionPoint => Boolean(point),
  );
  return firstEnds.some((firstEnd) => {
    return secondEnds.some((secondEnd) => distance(firstEnd, secondEnd) <= tolerance);
  });
};

const findSeparateArrowheadStrokes = (
  connectorIndex: number,
  strokes: readonly T0Stroke[],
  usedStrokeIndexes: ReadonlySet<number>,
  points: readonly SuggestionPoint[],
  inline: { start: boolean; end: boolean },
  connectorCandidateIndexes: ReadonlySet<number>,
): { index: number; end: 'start' | 'end' }[] => {
  const connectorStart = points[0];
  const connectorEnd = points[points.length - 1];
  if (!connectorStart || !connectorEnd) {
    return [];
  }
  const tolerance = Math.max(22, endpointTolerance(points) * 2);
  const result: { index: number; end: 'start' | 'end' }[] = [];
  const candidates: {
    index: number;
    end: 'start' | 'end';
    distance: number;
    barb: boolean;
    angle: number;
  }[] = [];
  for (let index = 0; index < strokes.length; index += 1) {
    if (index === connectorIndex || usedStrokeIndexes.has(index)) {
      continue;
    }
    const candidate = strokes[index];
    if (!candidate) {
      continue;
    }
    const isV = isArrowheadStroke(candidate.points);
    const isBarb = isBarbStroke(candidate.points);
    if (!isV && !isBarb) {
      continue;
    }
    const candidateBounds = getBounds(candidate.points);
    const candidateCenter = boundsCenter(candidateBounds);
    const startDistance = Math.min(
      distance(candidate.points[0] ?? candidateCenter, connectorStart),
      distance(candidate.points[candidate.points.length - 1] ?? candidateCenter, connectorStart),
      distance(candidateCenter, connectorStart),
    );
    const endDistance = Math.min(
      distance(candidate.points[0] ?? candidateCenter, connectorEnd),
      distance(candidate.points[candidate.points.length - 1] ?? candidateCenter, connectorEnd),
      distance(candidateCenter, connectorEnd),
    );
    const first = candidate.points[0];
    const last = candidate.points[candidate.points.length - 1];
    const angle = first && last
      ? normalizeAngle(Math.atan2(last.y - first.y, last.x - first.x))
      : 0;
    const startAligned = arrowheadAlignsWithShaft(
      candidate.points,
      connectorStart,
      points[1],
    );
    const endAligned = arrowheadAlignsWithShaft(
      candidate.points,
      connectorEnd,
      points[points.length - 2],
    );
    const closerStart = hasCloserArrowheadOwner(
      candidate.points,
      connectorIndex,
      connectorStart,
      points[1],
      strokes,
      connectorCandidateIndexes,
    );
    const closerEnd = hasCloserArrowheadOwner(
      candidate.points,
      connectorIndex,
      connectorEnd,
      points[points.length - 2],
      strokes,
      connectorCandidateIndexes,
    );
    if (
      !inline.start
      &&
      startDistance <= tolerance
      && startDistance <= endDistance
      && startAligned
      && (isBarb || !closerStart)
    ) {
      candidates.push({ index, end: 'start', distance: startDistance, barb: isBarb, angle });
    } else if (
      !inline.end
      &&
      endDistance <= tolerance
      && endAligned
      && (isBarb || !closerEnd)
    ) {
      candidates.push({ index, end: 'end', distance: endDistance, barb: isBarb, angle });
    }
  }
  const endpointCandidatesByEnd = {
    start: candidates
      .filter((candidate) => candidate.end === 'start')
      .sort((first, second) => first.distance - second.distance),
    end: candidates
      .filter((candidate) => candidate.end === 'end')
      .sort((first, second) => first.distance - second.distance),
  };
  const explicitByEnd = {
    start: endpointCandidatesByEnd.start.find((candidate) => !candidate.barb),
    end: endpointCandidatesByEnd.end.find((candidate) => !candidate.barb),
  };
  for (const end of ['start', 'end'] as const) {
    const endpointCandidates = endpointCandidatesByEnd[end];
    const explicit = explicitByEnd[end];
    if (explicit) {
      result.push({ index: explicit.index, end });
      continue;
    }
    const opposite = end === 'start' ? explicitByEnd.end : explicitByEnd.start;
    if (opposite) {
      continue;
    }
    const barbs = endpointCandidates.filter((candidate) => candidate.barb);
    let pair: typeof barbs = [];
    for (let first = 0; first < barbs.length; first += 1) {
      for (let second = first + 1; second < barbs.length; second += 1) {
        const firstBarb = barbs[first];
        const secondBarb = barbs[second];
        if (!firstBarb || !secondBarb) {
          continue;
        }
        if (angleDistance(firstBarb.angle, secondBarb.angle) > 0.15) {
          pair = [firstBarb, secondBarb];
          break;
        }
      }
      if (pair.length > 0) {
        break;
      }
    }
    pair.forEach((candidate) => result.push({ index: candidate.index, end }));
  }
  return result.slice(0, 4);
};

const arrowheadAlignsWithShaft = (
  points: readonly SuggestionPoint[],
  endpoint: SuggestionPoint,
  adjacent: SuggestionPoint | undefined,
): boolean => {
  const alignment = arrowheadShaftAlignment(points, endpoint, adjacent);
  return alignment !== undefined && alignment >= 0.5;
};

const arrowheadShaftAlignment = (
  points: readonly SuggestionPoint[],
  endpoint: SuggestionPoint,
  adjacent: SuggestionPoint | undefined,
): number | undefined => {
  if (!adjacent || points.length < 2) {
    return undefined;
  }
  const tipIndex = points.reduce((bestIndex, point, index) => {
    const best = points[bestIndex]!;
    return distance(point, endpoint) < distance(best, endpoint) ? index : bestIndex;
  }, 0);
  const tip = points[tipIndex];
  if (!tip) {
    return undefined;
  }
  const basePoints = points.filter((_point, index) => index !== tipIndex);
  const base = basePoints.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  base.x /= Math.max(1, basePoints.length);
  base.y /= Math.max(1, basePoints.length);
  const shaft = normalizeVector({
    x: endpoint.x - adjacent.x,
    y: endpoint.y - adjacent.y,
  });
  const head = normalizeVector({
    x: tip.x - base.x,
    y: tip.y - base.y,
  });
  return shaft.x * head.x + shaft.y * head.y;
};

const hasCloserArrowheadOwner = (
  arrowhead: readonly SuggestionPoint[],
  connectorIndex: number,
  endpoint: SuggestionPoint,
  adjacent: SuggestionPoint | undefined,
  strokes: readonly T0Stroke[],
  connectorCandidateIndexes: ReadonlySet<number>,
): boolean => {
  const tip = arrowhead.reduce((closest, point) => (
    distance(point, endpoint) < distance(closest, endpoint) ? point : closest
  ), arrowhead[0] ?? endpoint);
  const tipDistance = distance(tip, endpoint);
  const currentAlignment = arrowheadShaftAlignment(arrowhead, endpoint, adjacent);
  const currentScore = tipDistance
    + (1 - (currentAlignment ?? 0)) * 20;
  for (let index = 0; index < strokes.length; index += 1) {
    if (index === connectorIndex || !connectorCandidateIndexes.has(index)) {
      continue;
    }
    const candidate = strokes[index];
    if (!candidate || isStandaloneArrowheadStroke(candidate.points)) {
      continue;
    }
    const length = pathLength(candidate.points);
    const direct = distance(candidate.points[0]!, candidate.points[candidate.points.length - 1]!);
    if (length < 30 || direct < 20 || direct / length < 0.35) {
      continue;
    }
    const endpoints = [
      { point: candidate.points[0], adjacent: candidate.points[1] },
      {
        point: candidate.points[candidate.points.length - 1],
        adjacent: candidate.points[candidate.points.length - 2],
      },
    ];
    for (const other of endpoints) {
      if (
        other.point
        && other.adjacent
        && (distance(tip, other.point)
          + (1 - (arrowheadShaftAlignment(arrowhead, other.point, other.adjacent) ?? 0)) * 20)
          < currentScore - 0.5
      ) {
        return true;
      }
    }
  }
  return false;
};

const normalizeVector = (value: SuggestionPoint): SuggestionPoint => {
  const length = Math.hypot(value.x, value.y);
  return length < 0.001 ? { x: 0, y: 0 } : {
    x: value.x / length,
    y: value.y / length,
  };
};

const isArrowheadStroke = (points: readonly SuggestionPoint[]): boolean => {
  if (points.length < 3 || pathLength(points) < 7 || pathLength(points) > 95) {
    return false;
  }
  const direct = distance(points[0]!, points[points.length - 1]!);
  const ratio = direct === 0 ? Number.POSITIVE_INFINITY : pathLength(points) / direct;
  const turns = turnAngles(points);
  const bounds = getBounds(points);
  const simplified = rdp(
    points,
    Math.max(1.5, Math.min(6, Math.max(bounds.width, bounds.height) * 0.08)),
  );
  if (simplified.length < 3) {
    return false;
  }
  const sharpTurns = turns.filter((turn) => turn < Math.PI * 0.62).length;
  const reversalTurns = turns.filter((turn) => turn < Math.PI * 0.82).length;
  const maximum = Math.max(bounds.width, bounds.height);
  const minimum = Math.min(bounds.width, bounds.height);
  return maximum >= 7
    && (
      (sharpTurns >= 2 && ratio > 1.12 && maximum <= 55)
      || (reversalTurns >= 1 && ratio > 1.35 && maximum <= 65 && minimum <= 42)
    );
};

const isBarbStroke = (points: readonly SuggestionPoint[]): boolean => {
  if (points.length < 2) {
    return false;
  }
  const length = pathLength(points);
  const direct = distance(points[0], points[points.length - 1]);
  const bounds = getBounds(points);
  const maximum = Math.max(bounds.width, bounds.height);
  const minimum = Math.min(bounds.width, bounds.height);
  return length >= 5
    && length <= 42
    && direct >= 3
    && direct / length > 0.55
    && maximum >= 7
    && maximum <= 38
    && minimum <= 30
    && points.every((point) => distanceFromLine(
      point,
      points[0] ?? point,
      points[points.length - 1] ?? point,
    ) <= 8);
};

const isStandaloneArrowheadStroke = (
  points: readonly SuggestionPoint[],
): boolean => {
  if (isBarbStroke(points)) {
    return true;
  }
  if (!isArrowheadStroke(points)) {
    return false;
  }
  const bounds = getBounds(points);
  return Math.max(bounds.width, bounds.height) <= 95
    && Math.min(bounds.width, bounds.height) <= 42;
};

const detectInlineArrowheads = (
  points: readonly SuggestionPoint[],
  nodes: readonly {
    kind: ShapeSuggestionItem['shape'];
    bounds: SuggestionBounds;
  }[] = [],
): { start: boolean; end: boolean } => ({
  start: detectInlineArrowhead(points, true, nodes),
  end: detectInlineArrowhead(points, false, nodes),
});

const detectInlineArrowhead = (
  points: readonly SuggestionPoint[],
  atStart: boolean,
  nodes: readonly {
    kind: ShapeSuggestionItem['shape'];
    bounds: SuggestionBounds;
  }[] = [],
): boolean => {
  if (points.length < 3 || pathLength(points) < 24) {
    return false;
  }
  const boundaries = findInlineArrowBoundaries(points, atStart);
  const fallback = looksLikeInlineArrowheadFallback(points, atStart);
  if (nodes.length === 0) {
    return boundaries.length > 0 || fallback;
  }
  const endpoint = atStart ? points[0] : points[points.length - 1];
  if (!endpoint) {
    return false;
  }
  const boundaryMatchesEndpoint = (boundary: { point: SuggestionPoint }) => nodes.some((node) => (
    distanceToShapeOutline(boundary.point, node.kind, node.bounds)
      <= maxBindingGap(node.kind, node.bounds) + 16
    && distanceToShapeOutline(endpoint, node.kind, node.bounds)
      <= maxBindingGap(node.kind, node.bounds) + 36
  ));
  const nearNode = boundaries.some(boundaryMatchesEndpoint);
  if (nearNode) {
    return true;
  }
  const extendedBoundaries = findInlineArrowBoundaries(
    points,
    atStart,
    Math.min(160, pathLength(points) * 0.65),
  );
  return extendedBoundaries.some((boundary) => (
    boundaryMatchesEndpoint(boundary)
    && distance(endpoint, boundary.point) <= 56
  ));
};

const trimInlineArrowheads = (
  points: readonly SuggestionPoint[],
  inline: { start: boolean; end: boolean },
  hints: { start?: SuggestionPoint; end?: SuggestionPoint } = {},
): { points: SuggestionPoint[]; start: boolean; end: boolean } => {
  let result = [...points];
  let start = inline.start;
  let end = inline.end;
  if (inline.start && result.length >= 3) {
    const trimmed = trimInlineArrowhead(result, true, hints.start);
    result = trimmed.points;
    start = trimmed.arrowhead;
  }
  if (inline.end && result.length >= 3) {
    const trimmed = trimInlineArrowhead(result, false, hints.end);
    result = trimmed.points;
    end = trimmed.arrowhead;
  }
  return {
    points: result.length >= 2 ? result : [...points],
    start,
    end,
  };
};

const trimInlineArrowhead = (
  points: readonly SuggestionPoint[],
  atStart: boolean,
  preferredTip?: SuggestionPoint,
): { points: SuggestionPoint[]; arrowhead: boolean } => {
  const ordered = atStart ? [...points].reverse() : [...points];
  if (ordered.length < 3) {
    return { points: [...points], arrowhead: false };
  }
  const boundaries = findInlineArrowBoundaries(
    points,
    atStart,
    preferredTip ? Math.min(160, pathLength(points) * 0.65) : undefined,
  );
  const boundary = preferredTip
    ? boundaries
      .slice()
      .sort((first, second) => (
        distance(first.point, preferredTip) - distance(second.point, preferredTip)
      ))[0]
    : boundaries[0];
  const preferredIndex = preferredTip
    ? ordered.reduce((best, point, index) => (
      distance(point, preferredTip) < distance(ordered[best]!, preferredTip)
        ? index
        : best
    ), 0)
    : undefined;
  let shaftOrdered: SuggestionPoint[];
  if (boundary) {
    if (preferredIndex !== undefined && preferredIndex < boundary.index) {
      shaftOrdered = ordered.slice(0, preferredIndex + 1);
    } else {
      const appendPreferred = preferredIndex !== undefined
        && preferredIndex >= boundary.index + 1;
      shaftOrdered = [
        ...ordered.slice(0, appendPreferred ? boundary.index : boundary.index + 1),
        ...(appendPreferred ? [ordered[preferredIndex]!] : []),
      ];
    }
  } else {
    const fallbackDistance = Math.min(18, Math.max(8, pathLength(points) * 0.12));
    const fallback = pointAtDistanceFromVertex(
      ordered,
      ordered.length - 1,
      -fallbackDistance,
    );
    const fallbackIndex = ordered.reduce((best, point, index) => (
      distance(point, fallback) < distance(ordered[best]!, fallback)
        ? index
        : best
    ), Math.max(1, ordered.length - 2));
    shaftOrdered = ordered.slice(0, fallbackIndex + 1);
  }
  if (shaftOrdered.length < 2) {
    return { points: [...points], arrowhead: false };
  }
  const shaft = atStart ? shaftOrdered.reverse() : shaftOrdered;
  return {
    points: shaft,
    arrowhead: Boolean(boundary) || looksLikeInlineArrowheadFallback(points, atStart),
  };
};

const findInlineArrowBoundary = (
  points: readonly SuggestionPoint[],
  atStart: boolean,
  tailLimit?: number,
): { index: number; point: SuggestionPoint } | undefined => {
  return findInlineArrowBoundaries(points, atStart, tailLimit)[0];
};

const findInlineArrowBoundaries = (
  points: readonly SuggestionPoint[],
  atStart: boolean,
  tailLimitOverride?: number,
): { index: number; point: SuggestionPoint }[] => {
  const ordered = atStart ? [...points].reverse() : [...points];
  const total = pathLength(ordered);
  if (ordered.length < 3 || total < 24) {
    return [];
  }
  const tailLimit = tailLimitOverride === undefined
    ? Math.min(70, total * 0.35)
    : Math.min(tailLimitOverride, total * 0.65);
  const cumulative = [0];
  for (let index = 1; index < ordered.length; index += 1) {
    cumulative.push(
      (cumulative[index - 1] ?? 0) + distance(ordered[index - 1]!, ordered[index]!),
    );
  }
  const boundaries: { index: number; point: SuggestionPoint }[] = [];
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    if (!current || total - (cumulative[index] ?? 0) > tailLimit) {
      continue;
    }
    const before = pointAtDistanceFromVertex(ordered, index, -7);
    const after = pointAtDistanceFromVertex(ordered, index, 7);
    if (distance(before, current) < 3 || distance(after, current) < 3) {
      continue;
    }
    const directionalTurn = Math.PI - angleAtPoint(before, current, after);
    const returnsToTip = pathReturnsToPoint(ordered, index, current);
    if (
      directionalTurn >= (105 * Math.PI) / 180
      || (directionalTurn >= (80 * Math.PI) / 180 && returnsToTip)
    ) {
      boundaries.push({ index, point: current });
    }
  }
  return boundaries;
};

const pathReturnsToPoint = (
  points: readonly SuggestionPoint[],
  index: number,
  tip: SuggestionPoint,
): boolean => {
  let travelled = 0;
  for (let next = index + 1; next < points.length; next += 1) {
    const previous = points[next - 1];
    const current = points[next];
    if (!previous || !current) {
      continue;
    }
    travelled += distance(previous, current);
    if (travelled > 42) {
      break;
    }
    if (travelled >= 7 && distance(current, tip) <= 4) {
      return true;
    }
  }
  return false;
};

const looksLikeInlineArrowheadFallback = (
  points: readonly SuggestionPoint[],
  atStart: boolean,
): boolean => {
  const ordered = atStart ? [...points].reverse() : [...points];
  const total = pathLength(ordered);
  const tail = takeLastByDistance(ordered, Math.min(34, total * 0.35));
  if (tail.length < 3) {
    return false;
  }
  const direct = distance(tail[0]!, tail[tail.length - 1]!);
  const spread = getBounds(tail);
  const simplified = rdp(tail, 1.5);
  const hasStrongTurn = simplified.slice(1, -1).some((current, index) => {
    const previous = simplified[index];
    const next = simplified[index + 2];
    return previous && next
      && Math.PI - angleAtPoint(previous, current, next) >= (105 * Math.PI) / 180;
  });
  return pathLength(tail) / Math.max(1, direct) > 1.25
    && Math.max(spread.width, spread.height) >= 7
    && hasStrongTurn;
};

const takeLastByDistance = (
  points: readonly SuggestionPoint[],
  maximum: number,
): SuggestionPoint[] => takeByDistance([...points].reverse(), maximum).reverse();

const pointAtDistanceFromVertex = (
  points: readonly SuggestionPoint[],
  index: number,
  offset: number,
): SuggestionPoint => {
  const direction = offset < 0 ? -1 : 1;
  let remaining = Math.abs(offset);
  let cursor = index;
  while (remaining > 0.001) {
    const nextIndex = cursor + direction;
    if (nextIndex < 0 || nextIndex >= points.length) {
      return { ...(points[cursor] ?? { x: 0, y: 0 }) };
    }
    const current = points[cursor]!;
    const next = points[nextIndex]!;
    const segment = distance(current, next);
    if (segment <= 0.001) {
      cursor = nextIndex;
      continue;
    }
    if (segment >= remaining) {
      const ratio = remaining / segment;
      return {
        x: current.x + (next.x - current.x) * ratio,
        y: current.y + (next.y - current.y) * ratio,
      };
    }
    remaining -= segment;
    cursor = nextIndex;
  }
  return { ...(points[cursor] ?? { x: 0, y: 0 }) };
};

const isCleanInlineShaft = (
  points: readonly SuggestionPoint[],
  atStart: boolean,
): boolean => {
  const ordered = atStart ? [...points].reverse() : [...points];
  const tail = takeLastByDistance(
    rdp(ordered, 2.5),
    30,
  );
  for (let index = 1; index < tail.length - 1; index += 1) {
    const before = pointAtDistanceFromVertex(tail, index, -7);
    const after = pointAtDistanceFromVertex(tail, index, 7);
    const directionalTurn = Math.PI - angleAtPoint(before, tail[index]!, after);
    if (directionalTurn > (60 * Math.PI) / 180) {
      return false;
    }
  }
  return true;
};

const inlineArrowheadAxisMatches = (
  ordered: readonly SuggestionPoint[],
  shaftEndIndex: number,
): boolean => {
  const tip = ordered[shaftEndIndex];
  const previous = ordered[Math.max(0, shaftEndIndex - 1)];
  if (!tip || !previous || shaftEndIndex >= ordered.length - 1) {
    return true;
  }
  const shaft = normalizeVector({
    x: tip.x - previous.x,
    y: tip.y - previous.y,
  });
  const headPoints: SuggestionPoint[] = [];
  let travelled = 0;
  for (let index = shaftEndIndex + 1; index < ordered.length; index += 1) {
    const current = ordered[index];
    const prior = ordered[index - 1];
    if (!current || !prior) {
      continue;
    }
    travelled += distance(prior, current);
    headPoints.push(current);
    if (travelled >= 35) {
      break;
    }
  }
  if (headPoints.length === 0) {
    return true;
  }
  const base = headPoints.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  base.x /= headPoints.length;
  base.y /= headPoints.length;
  const axis = normalizeVector({
    x: tip.x - base.x,
    y: tip.y - base.y,
  });
  return shaft.x * axis.x + shaft.y * axis.y >= Math.cos((20 * Math.PI) / 180);
};

const nearestInlineTip = (
  points: readonly SuggestionPoint[],
  atStart: boolean,
  nodes: readonly {
    kind: ShapeSuggestionItem['shape'];
    bounds: SuggestionBounds;
  }[],
): SuggestionPoint | undefined => {
  if (nodes.length === 0) {
    return undefined;
  }
  const reversals = findInlineArrowBoundaries(points, atStart);
  const candidateReversals = reversals.length > 0
    ? reversals
    : findInlineArrowBoundaries(
      points,
      atStart,
      Math.min(160, pathLength(points) * 0.65),
    );
  if (candidateReversals.length > 0) {
    const ordered = atStart ? [...points].reverse() : [...points];
    return candidateReversals
      .map((reversal) => ({
        point: reversal.point,
        returnsToTip: pathReturnsToPoint(ordered, reversal.index, reversal.point),
        distance: Math.min(...nodes.map((node) => (
          inlineTipScore(
            reversal.point,
            pointAtDistanceFromVertex(ordered, reversal.index, -12),
            node.kind,
            node.bounds,
          )
        ))),
      }))
      .sort((first, second) => (
        Number(second.returnsToTip) - Number(first.returnsToTip)
        || first.distance - second.distance
      ))[0]?.point;
  }
  const ordered = atStart ? [...points].reverse() : [...points];
  const candidates = takeLastByDistance(
    ordered,
    Math.min(70, pathLength(ordered) * 0.45),
  );
  return candidates
    .map((point) => ({
      point,
      distance: Math.min(...nodes.map((node) => (
        inlineTipScore(
          point,
          ordered[Math.max(0, ordered.indexOf(point) - 1)],
          node.kind,
          node.bounds,
        )
      ))),
    }))
    .sort((first, second) => first.distance - second.distance)[0]?.point;
};

const inlineTipScore = (
  point: SuggestionPoint,
  previous: SuggestionPoint,
  kind: ShapeSuggestionItem['shape'],
  bounds: SuggestionBounds,
): number => {
  const center = boundsCenter(bounds);
  const radial = normalizeVector({
    x: point.x - center.x,
    y: point.y - center.y,
  });
  const shaft = normalizeVector({
    x: point.x - previous.x,
    y: point.y - previous.y,
  });
  const alignment = Math.abs(radial.x * shaft.x + radial.y * shaft.y);
  return distanceToShapeOutline(point, kind, bounds)
    + (1 - alignment) * Math.max(8, Math.min(bounds.width, bounds.height) * 0.2);
};

const snapEndpoint = (
  point: SuggestionPoint | undefined,
  neighbor: SuggestionPoint | undefined,
  nodes: readonly {
    ref: NodeRef;
    kind: ShapeSuggestionItem['shape'];
    bounds: SuggestionBounds;
  }[],
): { ref: NodeRef; point: SuggestionPoint } | undefined => {
  if (!point) {
    return undefined;
  }
  const matches = nodes
    .map((node) => ({
      node,
      distance: distanceToShapeOutline(point, node.kind, node.bounds),
      inside: pointInBounds(point, node.bounds, 0),
    }))
    .filter(({ node, distance: nodeDistance, inside }) => {
      return inside || (
        nodeDistance <= maxBindingGap(node.kind, node.bounds)
      );
    })
    .sort((first, second) => {
      return first.distance - second.distance
        || Number(second.inside) - Number(first.inside)
        || area(first.node.bounds) - area(second.node.bounds);
    });
  const match = matches[0];
  if (!match) {
    return undefined;
  }
  return {
    ref: match.node.ref,
    point: match.inside
      ? projectToShapeOutline(point, neighbor, match.node.kind, match.node.bounds)
      : point,
  };
};

const maxBindingGap = (
  kind: ShapeSuggestionItem['shape'],
  bounds: SuggestionBounds,
): number => {
  const shapeRatio = kind === 'diamond' ? 1 / Math.sqrt(2) : 1;
  return Math.max(
    16,
    Math.min(0.25 * shapeRatio * Math.min(bounds.width, bounds.height), 32),
  );
};

const projectToShapeOutline = (
  point: SuggestionPoint,
  neighbor: SuggestionPoint | undefined,
  kind: ShapeSuggestionItem['shape'],
  bounds: SuggestionBounds,
): SuggestionPoint => {
  const center = boundsCenter(bounds);
  let dx = point.x - center.x;
  let dy = point.y - center.y;
  if (Math.hypot(dx, dy) < 1 && neighbor) {
    dx = neighbor.x - center.x;
    dy = neighbor.y - center.y;
  }
  if (dx === 0 && dy === 0) {
    return { x: center.x, y: bounds.y };
  }
  const halfWidth = Math.max(0.5, bounds.width / 2);
  const halfHeight = Math.max(0.5, bounds.height / 2);
  let scale: number;
  if (kind === 'ellipse') {
    scale = 1 / Math.sqrt(
      (dx / halfWidth) ** 2 + (dy / halfHeight) ** 2,
    );
  } else if (kind === 'diamond') {
    scale = 1 / (Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight);
  } else if (kind === 'roundedRectangle') {
    scale = roundedRectangleRayScale(dx, dy, halfWidth, halfHeight);
  } else {
    scale = Math.min(
      Math.abs(dx) > 0 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY,
      Math.abs(dy) > 0 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY,
    );
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    return { x: center.x, y: bounds.y };
  }
  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale,
  };
};

const isConnectorCandidate = (
  points: readonly SuggestionPoint[],
  nodes: readonly {
    kind: ShapeSuggestionItem['shape'];
    bounds: SuggestionBounds;
  }[],
): boolean => {
  if (points.length < 2) {
    return false;
  }
  const inline = detectInlineArrowheads(points, nodes);
  const touchesNode = [points[0], points[points.length - 1]]
    .filter((point): point is SuggestionPoint => Boolean(point))
    .some((point) => nodes.some((node) => {
      return pointInBounds(point, node.bounds, 0)
        || distanceToShapeOutline(point, node.kind, node.bounds)
          <= Math.max(16, Math.min(node.bounds.width, node.bounds.height) * 0.25);
    }));
  if (!touchesNode) {
    return false;
  }
  const length = pathLength(points);
  const direct = distance(points[0], points[points.length - 1]);
  if (
    length < 30
    || direct < 20
    || (direct / Math.max(1, length) < 0.48 && !inline.start && !inline.end)
  ) {
    return false;
  }
  const bounds = getBounds(points);
  const area = bounds.width * bounds.height;
  if (area < 30 || pathLength(points) / Math.max(1, Math.hypot(bounds.width, bounds.height)) > 16) {
    return false;
  }
  const turns = turnAngles(points);
  const severeTurns = turns.filter((turn) => turn < Math.PI * 0.42).length;
  if (severeTurns > 5 && !inline.start && !inline.end) {
    return false;
  }
  return direct / length > 0.48
    || inline.start
    || inline.end;
};

const isStraightStroke = (points: readonly SuggestionPoint[]): boolean => {
  if (points.length < 2) {
    return false;
  }
  const start = points[0];
  const end = points[points.length - 1];
  if (!start || !end) {
    return false;
  }
  const length = distance(start, end);
  return length >= 20
    && points.every((point) => distanceFromLine(point, start, end) <= Math.max(5, length * 0.15));
};

const connectorConfidence = (points: readonly SuggestionPoint[], snapped: boolean): number => {
  const direct = distance(points[0] ?? { x: 0, y: 0 }, points[points.length - 1] ?? { x: 0, y: 0 });
  const ratio = direct / Math.max(1, pathLength(points));
  return Math.min(0.95, 0.65 + ratio * 0.25 + (snapped ? 0.08 : 0));
};

const simplifyConnectorPoints = (points: readonly SuggestionPoint[]): SuggestionPoint[] => {
  if (points.length <= 3) {
    return points.map((point) => ({ ...point }));
  }
  const bounds = getBounds(points);
  return rdp(points, Math.max(2.5, Math.min(bounds.width, bounds.height) * 0.025))
    .map((point) => ({ ...point }));
};

const ensureEndpointSegmentLength = (
  points: readonly SuggestionPoint[],
  arrowheads: { start: boolean; end: boolean },
  minimum = 10,
): SuggestionPoint[] => {
  const result = points.map((point) => ({ ...point }));
  if (arrowheads.start) {
    while (result.length > 2 && distance(result[0]!, result[1]!) < minimum) {
      result.splice(1, 1);
    }
  }
  if (arrowheads.end) {
    while (result.length > 2 && distance(result.at(-1)!, result.at(-2)!) < minimum) {
      result.splice(result.length - 2, 1);
    }
  }
  return result;
};

const compareDetectedNodes = (first: DetectedNode, second: DetectedNode): number => {
  return first.item.y - second.item.y
    || first.item.x - second.item.x
    || first.item.id.localeCompare(second.item.id);
};

const compareDetectedConnectors = (
  first: DetectedConnector,
  second: DetectedConnector,
): number => {
  const firstPoint = first.points[0] ?? { x: 0, y: 0 };
  const secondPoint = second.points[0] ?? { x: 0, y: 0 };
  return firstPoint.y - secondPoint.y
    || firstPoint.x - secondPoint.x
    || first.item.id.localeCompare(second.item.id);
};

const compareText = (first: T0Text, second: T0Text): number => {
  return first.y - second.y || first.x - second.x || first.id.localeCompare(second.id);
};

const textCenter = (text: T0Text): SuggestionPoint => ({
  x: text.x + text.width / 2,
  y: text.y + text.height / 2,
});

const resamplePath = (
  points: readonly SuggestionPoint[],
  count: number,
  closed: boolean,
): SuggestionPoint[] => {
  if (points.length < 2 || count < 2) {
    return points.map((point) => ({ ...point }));
  }
  const source = closed
    ? [...points, points[0] as SuggestionPoint]
    : [...points];
  const lengths = [0];
  for (let index = 1; index < source.length; index += 1) {
    lengths.push(
      (lengths[index - 1] ?? 0) + distance(source[index - 1]!, source[index]!),
    );
  }
  const total = lengths[lengths.length - 1] ?? 0;
  if (total <= 0) {
    return points.slice(0, count).map((point) => ({ ...point }));
  }
  const samples: SuggestionPoint[] = [];
  const denominator = closed ? count : count - 1;
  for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
    const target = (total * sampleIndex) / denominator;
    let segment = 1;
    while (
      segment < lengths.length - 1
      && (lengths[segment] ?? 0) < target
    ) {
      segment += 1;
    }
    const before = lengths[segment - 1] ?? 0;
    const after = lengths[segment] ?? total;
    const ratio = after === before ? 0 : (target - before) / (after - before);
    const first = source[segment - 1] ?? source[0]!;
    const second = source[segment] ?? source[source.length - 1]!;
    samples.push({
      x: first.x + (second.x - first.x) * ratio,
      y: first.y + (second.y - first.y) * ratio,
    });
  }
  return samples;
};

const polygonArea = (points: readonly SuggestionPoint[]): number => {
  if (points.length < 3) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!;
    const second = points[(index + 1) % points.length]!;
    total += first.x * second.y - second.x * first.y;
  }
  return total / 2;
};

const convexHull = (
  points: readonly SuggestionPoint[],
): SuggestionPoint[] => {
  const sorted = points
    .map((point) => ({ ...point }))
    .sort((first, second) => first.x - second.x || first.y - second.y);
  const unique: SuggestionPoint[] = [];
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (!previous || distance(previous, point) > 0.01) {
      unique.push(point);
    }
  }
  if (unique.length <= 2) {
    return unique;
  }
  const cross = (
    origin: SuggestionPoint,
    first: SuggestionPoint,
    second: SuggestionPoint,
  ) => (first.x - origin.x) * (second.y - origin.y)
    - (first.y - origin.y) * (second.x - origin.x);
  const lower: SuggestionPoint[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2
      && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: SuggestionPoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!;
    while (
      upper.length >= 2
      && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
};

const ellipseFitError = (
  points: readonly SuggestionPoint[],
  bounds: SuggestionBounds,
): number => {
  const center = boundsCenter(bounds);
  const halfWidth = Math.max(1, bounds.width / 2);
  const halfHeight = Math.max(1, bounds.height / 2);
  return points.reduce((sum, point) => {
    const radius = Math.sqrt(
      ((point.x - center.x) / halfWidth) ** 2
      + ((point.y - center.y) / halfHeight) ** 2,
    );
    return sum + Math.abs(radius - 1);
  }, 0) / Math.max(1, points.length);
};

const diamondFitError = (
  points: readonly SuggestionPoint[],
  bounds: SuggestionBounds,
): number => {
  const center = boundsCenter(bounds);
  const halfWidth = Math.max(1, bounds.width / 2);
  const halfHeight = Math.max(1, bounds.height / 2);
  return points.reduce((sum, point) => {
    const radius = Math.abs(point.x - center.x) / halfWidth
      + Math.abs(point.y - center.y) / halfHeight;
    return sum + Math.abs(radius - 1);
  }, 0) / Math.max(1, points.length);
};

const fitRectangleBounds = (
  points: readonly SuggestionPoint[],
  seedBounds: SuggestionBounds,
  groups: readonly (readonly SuggestionPoint[])[] = [points],
): SuggestionBounds => {
  const cleaned = cleanPoints(points);
  if (cleaned.length < 8) {
    return seedBounds;
  }

  const center = boundsCenter(seedBounds);
  const angle = estimateRectangleAngle(groups, seedBounds);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const local = cleaned.map((point) => ({
    point,
    u: (point.x - center.x) * cosine + (point.y - center.y) * sine,
    v: -(point.x - center.x) * sine + (point.y - center.y) * cosine,
  }));
  const scaleU = percentile(local.map(({ u }) => Math.abs(u)), 0.82);
  const scaleV = percentile(local.map(({ v }) => Math.abs(v)), 0.82);
  if (scaleU < 4 || scaleV < 4) {
    return seedBounds;
  }

  const sides: Record<'left' | 'right' | 'top' | 'bottom', number[]> = {
    left: [],
    right: [],
    top: [],
    bottom: [],
  };
  const assign = (centralFraction: number) => {
    for (const { u, v } of local) {
      const verticalScore = Math.abs(u) / scaleU;
      const horizontalScore = Math.abs(v) / scaleV;
      if (verticalScore >= horizontalScore) {
        if (Math.abs(v) <= scaleV * centralFraction) {
          (u < 0 ? sides.left : sides.right).push(u);
        }
      } else if (Math.abs(u) <= scaleU * centralFraction) {
        (v < 0 ? sides.top : sides.bottom).push(v);
      }
    }
  };
  assign(0.78);
  if (
    sides.left.length < 3
    || sides.right.length < 3
    || sides.top.length < 3
    || sides.bottom.length < 3
  ) {
    sides.left = [];
    sides.right = [];
    sides.top = [];
    sides.bottom = [];
    assign(0.92);
  }
  if (
    sides.left.length < 2
    || sides.right.length < 2
    || sides.top.length < 2
    || sides.bottom.length < 2
  ) {
    return seedBounds;
  }

  const left = trimmedMedian(sides.left);
  const right = trimmedMedian(sides.right);
  const top = trimmedMedian(sides.top);
  const bottom = trimmedMedian(sides.bottom);
  const width = right - left;
  const height = bottom - top;
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width < 12
    || height < 12
  ) {
    return seedBounds;
  }

  const fittedCenter = {
    u: (left + right) / 2,
    v: (top + bottom) / 2,
  };
  const worldCenter = {
    x: center.x + fittedCenter.u * cosine - fittedCenter.v * sine,
    y: center.y + fittedCenter.u * sine + fittedCenter.v * cosine,
  };
  const swapAxes = (
    seedBounds.width >= seedBounds.height
  ) !== (width >= height);
  return {
    x: worldCenter.x - (swapAxes ? height : width) / 2,
    y: worldCenter.y - (swapAxes ? width : height) / 2,
    width: swapAxes ? height : width,
    height: swapAxes ? width : height,
  };
};

const fitDiamondBounds = (
  points: readonly SuggestionPoint[],
  seedBounds: SuggestionBounds,
): SuggestionBounds => {
  const cleaned = cleanPoints(points);
  if (cleaned.length < 8) {
    return seedBounds;
  }
  const center = boundsCenter(seedBounds);
  const halfWidth = Math.max(1, seedBounds.width / 2);
  const halfHeight = Math.max(1, seedBounds.height / 2);
  const tolerance = Math.max(3, Math.min(halfWidth, halfHeight) * 0.12);
  const sidePoints = [
    cleaned.filter((point) => (
      point.x - center.x >= -tolerance
      && point.y - center.y <= tolerance
    )),
    cleaned.filter((point) => (
      point.x - center.x >= -tolerance
      && point.y - center.y >= -tolerance
    )),
    cleaned.filter((point) => (
      point.x - center.x <= tolerance
      && point.y - center.y >= -tolerance
    )),
    cleaned.filter((point) => (
      point.x - center.x <= tolerance
      && point.y - center.y <= tolerance
    )),
  ];
  const lines = sidePoints.map((group) => fitRobustLine(group));
  if (lines.some((line) => !line)) {
    return seedBounds;
  }
  const top = intersectLines(lines[3]!, lines[0]!);
  const right = intersectLines(lines[0]!, lines[1]!);
  const bottom = intersectLines(lines[1]!, lines[2]!);
  const left = intersectLines(lines[2]!, lines[3]!);
  if (!top || !right || !bottom || !left) {
    return seedBounds;
  }
  const fittedCenter = {
    x: (top.x + right.x + bottom.x + left.x) / 4,
    y: (top.y + right.y + bottom.y + left.y) / 4,
  };
  const fittedHalfWidth = Math.abs(right.x - left.x) / 2;
  const fittedHalfHeight = Math.abs(bottom.y - top.y) / 2;
  const fittedLeft = fittedCenter.x - fittedHalfWidth;
  const fittedRight = fittedCenter.x + fittedHalfWidth;
  const fittedTop = fittedCenter.y - fittedHalfHeight;
  const fittedBottom = fittedCenter.y + fittedHalfHeight;
  const seedRight = seedBounds.x + seedBounds.width;
  const seedBottom = seedBounds.y + seedBounds.height;
  const leftEdge = Math.min(fittedLeft, seedBounds.x + 4);
  const rightEdge = Math.max(fittedRight, seedRight - 4);
  const topEdge = Math.min(fittedTop, seedBounds.y + 4);
  const bottomEdge = Math.max(fittedBottom, seedBottom - 4);
  const fittedBounds = {
    x: leftEdge,
    y: topEdge,
    width: rightEdge - leftEdge,
    height: bottomEdge - topEdge,
  };
  return fittedBounds.width >= 20 && fittedBounds.height >= 20
    ? fittedBounds
    : seedBounds;
};

type FittedLine = {
  a: number;
  b: number;
  c: number;
};

const fitRobustLine = (
  points: readonly SuggestionPoint[],
): FittedLine | undefined => {
  if (points.length < 4) {
    return undefined;
  }
  let selected = [...points];
  let line: FittedLine | undefined;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    line = fitLine(selected);
    if (!line) {
      return undefined;
    }
    const residuals = selected.map((point) => Math.abs(
      line!.a * point.x + line!.b * point.y + line!.c,
    ));
    const cutoff = Math.max(2, percentile(residuals, 0.75) + 1);
    const next = selected.filter((_point, index) => (
      residuals[index]! <= cutoff
    ));
    if (next.length < 4 || next.length === selected.length) {
      break;
    }
    selected = next;
  }
  return line;
};

const fitLine = (
  points: readonly SuggestionPoint[],
): FittedLine | undefined => {
  if (points.length < 2) {
    return undefined;
  }
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const directionAngle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const normal = {
    x: -Math.sin(directionAngle),
    y: Math.cos(directionAngle),
  };
  return {
    a: normal.x,
    b: normal.y,
    c: -(normal.x * center.x + normal.y * center.y),
  };
};

const intersectLines = (
  first: FittedLine,
  second: FittedLine,
): SuggestionPoint | undefined => {
  const determinant = first.a * second.b - second.a * first.b;
  if (Math.abs(determinant) < 1e-5) {
    return undefined;
  }
  return {
    x: (first.b * second.c - second.b * first.c) / determinant,
    y: (second.a * first.c - first.a * second.c) / determinant,
  };
};

const estimateRectangleAngle = (
  groups: readonly (readonly SuggestionPoint[])[],
  bounds: SuggestionBounds,
): number => {
  const minimumSegment = Math.max(3, Math.min(bounds.width, bounds.height) * 0.025);
  const segments: { angle: number; length: number }[] = [];
  for (const group of groups) {
    const cleaned = cleanPoints(group);
    const simplified = rdp(cleaned, Math.max(1.5, minimumSegment * 0.8));
    for (let index = 1; index < simplified.length; index += 1) {
      const first = simplified[index - 1];
      const second = simplified[index];
      if (!first || !second) {
        continue;
      }
      const length = distance(first, second);
      if (length >= minimumSegment) {
        segments.push({
          angle: normalizeAngle(Math.atan2(second.y - first.y, second.x - first.x)),
          length,
        });
      }
    }
  }
  if (segments.length === 0) {
    return 0;
  }
  let sumCosine = 0;
  let sumSine = 0;
  let totalWeight = 0;
  let longest = segments[0]!;
  for (const segment of segments) {
    const doubled = segment.angle * 2;
    sumCosine += Math.cos(doubled) * segment.length;
    sumSine += Math.sin(doubled) * segment.length;
    totalWeight += segment.length;
    if (segment.length > longest.length) {
      longest = segment;
    }
  }
  if (Math.hypot(sumCosine, sumSine) < totalWeight * 0.14) {
    return longest.angle;
  }
  return normalizeAngle(Math.atan2(sumSine, sumCosine) / 2);
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

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index]!;
};

const trimmedMedian = (values: readonly number[]): number => {
  if (values.length < 5) {
    return median(values);
  }
  const sorted = [...values].sort((first, second) => first - second);
  const trim = Math.floor(sorted.length * 0.15);
  return median(sorted.slice(trim, sorted.length - trim));
};

const rectangleFitError = (
  points: readonly SuggestionPoint[],
  bounds: SuggestionBounds,
): number => {
  const center = boundsCenter(bounds);
  const halfWidth = Math.max(1, bounds.width / 2);
  const halfHeight = Math.max(1, bounds.height / 2);
  const scale = Math.max(1, Math.min(halfWidth, halfHeight));
  return points.reduce((sum, point) => {
    const dx = Math.abs(Math.abs(point.x - center.x) - halfWidth);
    const dy = Math.abs(Math.abs(point.y - center.y) - halfHeight);
    return sum + Math.min(dx, dy) / scale;
  }, 0) / Math.max(1, points.length);
};

const clearlyRoundedRectangle = (
  sampled: readonly SuggestionPoint[],
  simplified: readonly SuggestionPoint[],
  _bounds: SuggestionBounds,
  areaRatio: number,
  cornerCount: number,
): boolean => {
  if (areaRatio >= 0.985 || simplified.length < 6 || cornerCount > 7) {
    return false;
  }
  const turns = turnAngles(sampled);
  const sharpTurns = turns.filter((turn) => turn < Math.PI * 0.66).length;
  const roundedTurns = turns.filter((turn) => turn < Math.PI * 0.94).length;
  const arcTurnClusters: number[][] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn === undefined || turn >= 2.9) {
      continue;
    }
    const previous = turns[(index - 1 + turns.length) % turns.length];
    const last = arcTurnClusters.at(-1);
    if (previous !== undefined && previous < 2.9 && last) {
      last.push(index);
    } else {
      arcTurnClusters.push([index]);
    }
  }
  if (
    arcTurnClusters.length > 1
    && turns[0] !== undefined
    && turns.at(-1) !== undefined
    && turns[0] < 2.9
    && turns.at(-1)! < 2.9
  ) {
    const first = arcTurnClusters[0];
    const last = arcTurnClusters.at(-1);
    if (first && last) {
      first.unshift(...last);
      arcTurnClusters.pop();
    }
  }
  const clearArcCorners = arcTurnClusters.filter((cluster) => cluster.length >= 2).length;
  return (
    sharpTurns === 0
    && clearArcCorners >= 3
    && roundedTurns >= 6
    && areaRatio > 0.7
    && simplified.length >= 8
    && cornerCount <= 7
  );
};

const simplifyShapeStroke = (
  points: readonly SuggestionPoint[],
): SuggestionPoint[] => {
  const cleaned = cleanPoints(points);
  if (cleaned.length <= 2) {
    return cleaned;
  }
  const bounds = getBounds(cleaned);
  const epsilon = Math.max(2, Math.min(bounds.width, bounds.height) * 0.025);
  const first = rdp(cleaned, epsilon);
  return first.length > 7 ? rdp(first, epsilon * 1.5) : first;
};

const shapeStrokeLength = (points: readonly SuggestionPoint[]): number => {
  return pathLength(points);
};

const strokesCanJoin = (
  first: readonly SuggestionPoint[],
  second: readonly SuggestionPoint[],
  tolerance: number,
  secondBounds = getBounds(second),
): boolean => {
  const firstEnds = [first[0], first[first.length - 1]].filter(
    (point): point is SuggestionPoint => Boolean(point),
  );
  const secondEnds = [second[0], second[second.length - 1]].filter(
    (point): point is SuggestionPoint => Boolean(point),
  );
  return firstEnds.some((endpoint) => {
    if (distanceToBounds(endpoint, secondBounds) > tolerance) {
      return false;
    }
    return secondEnds.some((candidate) => {
      return distance(endpoint, candidate) <= tolerance
        || endpointToStrokeDistance(endpoint, second) <= tolerance;
    });
  });
};

const endpointToStrokeDistance = (
  point: SuggestionPoint,
  stroke: readonly SuggestionPoint[],
): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < stroke.length; index += 1) {
    const first = stroke[index - 1];
    const second = stroke[index];
    if (!first || !second) {
      continue;
    }
    minimum = Math.min(minimum, distanceToSegment(point, first, second));
  }
  return minimum;
};

const distanceToSegment = (
  point: SuggestionPoint,
  first: SuggestionPoint,
  second: SuggestionPoint,
): number => {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, (
      (point.x - first.x) * dx + (point.y - first.y) * dy
    ) / lengthSquared));
  return Math.hypot(
    point.x - (first.x + ratio * dx),
    point.y - (first.y + ratio * dy),
  );
};

const multiStrokeScore = (
  entries: readonly { stroke: T0Stroke; index: number }[],
  shape: ShapeCandidate,
): number => {
  const endpoints = entries.flatMap(({ stroke }) => [
    stroke.points[0],
    stroke.points[stroke.points.length - 1],
  ]).filter((point): point is SuggestionPoint => Boolean(point));
  let joinDistance = 0;
  for (const endpoint of endpoints) {
    joinDistance += Math.min(
      ...endpoints
        .filter((candidate) => candidate !== endpoint)
        .map((candidate) => distance(endpoint, candidate)),
    );
  }
  return shape.confidence * 10
    + entries.length * 2
    - joinDistance / Math.max(1, Math.hypot(shape.bounds.width, shape.bounds.height))
    - Math.sqrt(area(shape.bounds)) / 10;
};

const turnAngles = (points: readonly SuggestionPoint[]): number[] => {
  const sampled = points.length > 36
    ? resamplePath(points, 36, false)
    : points;
  const turns: number[] = [];
  for (let index = 1; index < sampled.length - 1; index += 1) {
    const previous = sampled[index - 1];
    const current = sampled[index];
    const next = sampled[index + 1];
    if (previous && current && next) {
      turns.push(angleAtPoint(previous, current, next));
    }
  }
  return turns;
};

const takeByDistance = (
  points: readonly SuggestionPoint[],
  maximum: number,
): SuggestionPoint[] => {
  if (points.length < 2) {
    return points.map((point) => ({ ...point }));
  }
  const result = [{ ...points[0]! }];
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    length += distance(previous, current);
    result.push({ ...current });
    if (length >= maximum) {
      break;
    }
  }
  return result;
};

const roundedRectangleRayScale = (
  dx: number,
  dy: number,
  halfWidth: number,
  halfHeight: number,
): number => {
  const radius = Math.min(18, halfWidth * 0.3, halfHeight * 0.45);
  const rectangleScale = Math.min(
    Math.abs(dx) > 0 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY,
    Math.abs(dy) > 0 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY,
  );
  const rectanglePoint = { x: dx * rectangleScale, y: dy * rectangleScale };
  if (
    Math.abs(rectanglePoint.x) <= halfWidth - radius
    || Math.abs(rectanglePoint.y) <= halfHeight - radius
  ) {
    return rectangleScale;
  }
  const cornerX = Math.sign(dx) * (halfWidth - radius);
  const cornerY = Math.sign(dy) * (halfHeight - radius);
  const ax = dx * dx + dy * dy;
  const bx = -2 * (dx * cornerX + dy * cornerY);
  const cx = cornerX * cornerX + cornerY * cornerY - radius * radius;
  const discriminant = bx * bx - 4 * ax * cx;
  if (discriminant <= 0 || ax === 0) {
    return rectangleScale;
  }
  const root = (-bx + Math.sqrt(discriminant)) / (2 * ax);
  return root > 0 ? root : rectangleScale;
};

const distanceToShapeOutline = (
  point: SuggestionPoint,
  kind: ShapeSuggestionItem['shape'],
  bounds: SuggestionBounds,
): number => {
  const projected = projectToShapeOutline(point, undefined, kind, bounds);
  return distance(point, projected);
};

const getBounds = (points: readonly SuggestionPoint[]): SuggestionBounds => {
  if (points.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...xs) - minX),
    height: Math.max(1, Math.max(...ys) - minY),
  };
};

const area = (bounds: SuggestionBounds): number => bounds.width * bounds.height;

const contains = (
  outer: SuggestionBounds,
  inner: SuggestionBounds,
): boolean => {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
    && area(inner) < area(outer);
};

const cleanPoints = (points: readonly SuggestionPoint[]): SuggestionPoint[] => {
  const cleaned: SuggestionPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    const previous = cleaned[cleaned.length - 1];
    if (!previous || distance(previous, point) > 0.5) {
      cleaned.push({ x: point.x, y: point.y });
    }
  }
  return cleaned;
};

const pathLength = (points: readonly SuggestionPoint[]): number => {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) {
      length += distance(previous, current);
    }
  }
  return length;
};

const distance = (first: SuggestionPoint, second: SuggestionPoint): number => {
  return Math.hypot(first.x - second.x, first.y - second.y);
};

const endpointTolerance = (points: readonly SuggestionPoint[]): number => {
  const bounds = getBounds(points);
  return Math.max(10, Math.min(bounds.width, bounds.height) * 0.18);
};

const distanceFromLine = (
  point: SuggestionPoint,
  start: SuggestionPoint,
  end: SuggestionPoint,
): number => {
  const denominator = distance(start, end);
  if (denominator === 0) {
    return distance(point, start);
  }
  return Math.abs(
    ((end.x - start.x) * (start.y - point.y))
    - ((start.x - point.x) * (end.y - start.y)),
  ) / denominator;
};

const rdp = (
  points: readonly SuggestionPoint[],
  epsilon: number,
): SuggestionPoint[] => {
  if (points.length <= 2) {
    return points.map((point) => ({ ...point }));
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return [];
  }
  let maximum = epsilon;
  let index = -1;
  for (let current = 1; current < points.length - 1; current += 1) {
    const point = points[current];
    if (!point) {
      continue;
    }
    const deviation = distanceFromLine(point, first, last);
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

const getCorners = (points: readonly SuggestionPoint[]): number[] => {
  const corners: number[] = [];
  if (points.length < 3) {
    return corners;
  }
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!previous || !current || !next) {
      continue;
    }
    const angle = angleAtPoint(previous, current, next);
    if (angle < Math.PI * 0.78) {
      corners.push(index);
    }
  }
  return corners;
};

const hasRoundedCorners = (points: readonly SuggestionPoint[]): boolean => {
  if (points.length < 5) {
    return false;
  }
  const turns = points.map((_, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    return previous && current && next ? angleAtPoint(previous, current, next) : Math.PI;
  });
  return turns.filter((turn) => turn < Math.PI * 0.88).length >= 4
    && turns.filter((turn) => turn < Math.PI * 0.62).length < 4;
};

const isDiamondLike = (
  points: readonly SuggestionPoint[],
  bounds: SuggestionBounds,
): boolean => {
  if (points.length < 4 || bounds.width <= 0 || bounds.height <= 0) {
    return false;
  }
  const toleranceX = Math.max(4, bounds.width * 0.18);
  const toleranceY = Math.max(4, bounds.height * 0.18);
  const sides = [false, false, false, false];
  let singleSidePoints = 0;
  for (const point of points) {
    const hits = [
      Math.abs(point.y - bounds.y) <= toleranceY,
      Math.abs(point.x - (bounds.x + bounds.width)) <= toleranceX,
      Math.abs(point.y - (bounds.y + bounds.height)) <= toleranceY,
      Math.abs(point.x - bounds.x) <= toleranceX,
    ];
    const hitCount = hits.filter(Boolean).length;
    if (hitCount === 1) {
      singleSidePoints += 1;
      hits.forEach((hit, index) => {
        if (hit) {
          sides[index] = true;
        }
      });
    }
  }
  return singleSidePoints >= 4 && sides.every(Boolean);
};

const angleAtPoint = (
  previous: SuggestionPoint,
  current: SuggestionPoint,
  next: SuggestionPoint,
): number => {
  const first = { x: previous.x - current.x, y: previous.y - current.y };
  const second = { x: next.x - current.x, y: next.y - current.y };
  const denominator = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);
  if (denominator === 0) {
    return Math.PI;
  }
  return Math.acos(Math.max(-1, Math.min(1, (first.x * second.x + first.y * second.y) / denominator)));
};

const getRadialError = (
  points: readonly SuggestionPoint[],
  center: SuggestionPoint,
): number => {
  const radii = points.map((point) => distance(point, center));
  const average = radii.reduce((sum, radius) => sum + radius, 0) / Math.max(1, radii.length);
  if (average === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt(
    radii.reduce((sum, radius) => sum + (radius - average) ** 2, 0) / Math.max(1, radii.length),
  ) / average;
};

const dominantEdgeAngle = (points: readonly SuggestionPoint[]): number => {
  let longest = 0;
  let angle = 0;
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1];
    const second = points[index];
    if (!first || !second) {
      continue;
    }
    const length = distance(first, second);
    if (length > longest) {
      longest = length;
      angle = Math.atan2(second.y - first.y, second.x - first.x);
    }
  }
  return normalizeAngle(angle);
};

const normalizeAngle = (angle: number): number => {
  let value = angle % Math.PI;
  if (value < 0) {
    value += Math.PI;
  }
  return value;
};

const angleDistance = (first: number, second: number): number => {
  const difference = Math.abs(normalizeAngle(first) - normalizeAngle(second));
  return Math.min(difference, Math.PI - difference);
};

const polygonCoverage = (
  points: readonly SuggestionPoint[],
  bounds: SuggestionBounds,
): number => {
  const first = points[0];
  const last = points[points.length - 1];
  const perimeter = pathLength(points)
    + (first && last ? distance(first, last) : 0);
  const expected = 2 * (bounds.width + bounds.height);
  return expected === 0 ? 0 : Math.min(1.2, perimeter / expected);
};

const distanceToPolyline = (
  point: SuggestionPoint,
  points: readonly SuggestionPoint[],
): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1];
    const second = points[index];
    if (!first || !second) {
      continue;
    }
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared));
    minimum = Math.min(minimum, Math.hypot(
      point.x - (first.x + t * dx),
      point.y - (first.y + t * dy),
    ));
  }
  return minimum;
};
