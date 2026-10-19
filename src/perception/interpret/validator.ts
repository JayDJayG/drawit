import {
  validateSuggestionPlan,
  type ConnectorSuggestionItem,
  type NodeRef,
  type ShapeSuggestionItem,
  type StrokeSuggestionItem,
  type SuggestionItem,
  type SuggestionPlan,
  type TextSuggestionItem,
} from '../../core/suggestions';
import type { InterpretRequest } from './types';

export type InterpretValidationResult =
  | {
      ok: true;
      plan: SuggestionPlan;
      dropped: string[];
      repairs: string[];
    }
  | { ok: false; errors: string[] };

export const INTERPRET_PLAN_LIMITS = {
  maxItems: 40,
  maxPointsPerItem: 32,
  maxPoints: 384,
  maxUnresolved: 16,
  maxIdLength: 32,
  maxReasonLength: 140,
  maxTextLength: 200,
} as const;

const COORDINATE_MARGIN = 1000;

type ParsedItem = {
  item: SuggestionItem;
  path: string;
  id: string;
};

export const validateInterpretResponse = (
  raw: unknown,
  request: InterpretRequest,
): InterpretValidationResult => {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
      return { ok: false, errors: ['response was empty'] };
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ['response was not valid JSON'] };
    }
  }
  if (!isRecord(value)) {
    return { ok: false, errors: ['plan must be an object'] };
  }

  const envelopeErrors: string[] = [];
  const repairs: string[] = [];
  if (!Object.hasOwn(value, 'version')) {
    repairs.push('version defaulted to 1');
  } else if (value.version !== 1) {
    envelopeErrors.push('plan version must be 1');
  }
  if (envelopeErrors.length > 0) {
    return { ok: false, errors: envelopeErrors };
  }
  if (value.tier !== 't2') {
    repairs.push('tier normalized to t2');
  }
  if (value.lens !== request.lens) {
    repairs.push('lens normalized to the request lens');
  }

  if (!Array.isArray(value.items)) {
    return { ok: false, errors: ['plan items must be an array'] };
  }
  const rawItems = value.items;
  if (rawItems.length > INTERPRET_PLAN_LIMITS.maxItems) {
    return {
      ok: false,
      errors: [`plan contains too many items (maximum ${INTERPRET_PLAN_LIMITS.maxItems})`],
    };
  }
  const rawPointCount = rawItems.reduce((total, rawItem) => {
    if (
      isRecord(rawItem)
      && (rawItem.kind === 'connector' || rawItem.kind === 'stroke')
      && Array.isArray(rawItem.points)
    ) {
      return total + rawItem.points.length;
    }
    return total;
  }, 0);
  if (rawPointCount > INTERPRET_PLAN_LIMITS.maxPoints) {
    return {
      ok: false,
      errors: [`plan contains too many points (maximum ${INTERPRET_PLAN_LIMITS.maxPoints})`],
    };
  }

  const unresolvedWasArray = Array.isArray(value.unresolved);
  if (!unresolvedWasArray) {
    repairs.push('unresolved normalized to an empty array');
  }
  const rawUnresolved = unresolvedWasArray
    ? value.unresolved as unknown[]
    : [];
  const unresolved = rawUnresolved.slice(0, INTERPRET_PLAN_LIMITS.maxUnresolved);
  if (rawUnresolved.length > INTERPRET_PLAN_LIMITS.maxUnresolved) {
    repairs.push(
      `unresolved truncated to ${INTERPRET_PLAN_LIMITS.maxUnresolved} entries`,
    );
  }

  const allowedSourceIds = new Set([
    ...request.strokes.map((stroke) => stroke.id),
    ...request.texts.map((text) => text.id),
  ]);
  const bounds = getRequestBounds(request);
  const seenItemIds = new Set<string>();
  const candidates: ParsedItem[] = [];
  const dropped: string[] = [];

  rawItems.forEach((rawItem, index) => {
    const path = `items[${index}]`;
    if (!isRecord(rawItem)) {
      dropped.push(formatDropped(path, undefined, `${path} must be an object`));
      return;
    }

    const itemId = readId(rawItem.id, `${path}.id`);
    if (itemId && seenItemIds.has(itemId)) {
      dropped.push(formatDropped(path, itemId, `duplicate item id "${itemId}"`));
      return;
    }
    if (itemId) {
      seenItemIds.add(itemId);
    }

    const errors: string[] = [];
    const itemRepairs: string[] = [];
    if (!itemId) {
      errors.push(idError(rawItem.id, `${path}.id`));
    }
    const sourceIds = readSourceIds(
      rawItem.sourceIds,
      path,
      allowedSourceIds,
      errors,
    );
    const metadata = readMetadata(rawItem, path, itemRepairs);
    let item: SuggestionItem | undefined;
    switch (rawItem.kind) {
      case 'shape':
        item = parseShape(
          rawItem,
          itemId,
          sourceIds,
          metadata,
          bounds,
          path,
          errors,
          itemRepairs,
        );
        break;
      case 'connector':
        item = parseConnector(
          rawItem,
          itemId,
          sourceIds,
          metadata,
          bounds,
          path,
          errors,
          itemRepairs,
        );
        break;
      case 'stroke':
        item = parseStroke(
          rawItem,
          itemId,
          sourceIds,
          metadata,
          bounds,
          path,
          errors,
          itemRepairs,
        );
        break;
      case 'text':
        item = parseText(
          rawItem,
          itemId,
          sourceIds,
          metadata,
          bounds,
          path,
          errors,
        );
        break;
      default:
        errors.push(`${path}.kind is invalid`);
    }

    if (!item || errors.length > 0) {
      dropped.push(formatDropped(path, itemId, errors[0] ?? `${path}.item is invalid`));
      return;
    }
    repairs.push(...itemRepairs);
    candidates.push({ item, path, id: itemId! });
  });

  const sourceOwners = new Map<string, string>();
  const kept: ParsedItem[] = [];
  for (const candidate of candidates) {
    const conflict = candidate.item.sourceIds.find((sourceId) => sourceOwners.has(sourceId));
    if (conflict) {
      const owner = sourceOwners.get(conflict)!;
      dropped.push(formatDropped(
        candidate.path,
        candidate.id,
        `source "${conflict}" belongs to both "${owner}" and "${candidate.path}"`,
      ));
      continue;
    }
    candidate.item.sourceIds.forEach((sourceId) => {
      sourceOwners.set(sourceId, candidate.path);
    });
    kept.push(candidate);
  }

  if (rawItems.length > 0 && kept.length === 0) {
    return { ok: false, errors: dropped };
  }

  const knownItemIds = new Set(kept.map((candidate) => candidate.id));
  const shapeIds = new Set(
    kept
      .filter((candidate) => candidate.item.kind === 'shape')
      .map((candidate) => candidate.id),
  );
  const cleanItems = kept.map((candidate) => {
    const item = candidate.item;
    if (item.kind === 'connector') {
      return {
        ...item,
        start: cleanNodeRef(item.start, knownItemIds, shapeIds, `${candidate.path}.start`, repairs),
        end: cleanNodeRef(item.end, knownItemIds, shapeIds, `${candidate.path}.end`, repairs),
      };
    }
    if (item.kind === 'shape' && item.children) {
      const children = item.children.filter((childId, childIndex) => {
        if (shapeIds.has(childId)) {
          return true;
        }
        repairs.push(
          `${candidate.path}.children[${childIndex}] removed because it is not a kept shape`,
        );
        return false;
      });
      return { ...item, children };
    }
    return item;
  });

  const cleanUnresolved: SuggestionPlan['unresolved'] = [];
  for (const [index, rawEntry] of unresolved.entries()) {
    const path = `unresolved[${index}]`;
    if (!isRecord(rawEntry)) {
      repairs.push(`${path} dropped because it is not an object`);
      continue;
    }
    if (
      typeof rawEntry.reason !== 'string'
      || rawEntry.reason.length === 0
      || rawEntry.reason.length > INTERPRET_PLAN_LIMITS.maxReasonLength
    ) {
      repairs.push(`${path} dropped because its reason is invalid`);
      continue;
    }
    if (!Array.isArray(rawEntry.sourceIds) || rawEntry.sourceIds.length === 0) {
      repairs.push(`${path} dropped because sourceIds is not non-empty`);
      continue;
    }
    const entrySources: string[] = [];
    for (const [sourceIndex, sourceValue] of rawEntry.sourceIds.entries()) {
      const sourceId = readId(sourceValue, `${path}.sourceIds[${sourceIndex}]`);
      if (!sourceId) {
        repairs.push(`${path}.sourceIds[${sourceIndex}] removed because it is invalid`);
        continue;
      }
      if (!allowedSourceIds.has(sourceId)) {
        repairs.push(`${path}.sourceIds[${sourceIndex}] removed because the source is unknown`);
        continue;
      }
      if (sourceOwners.has(sourceId)) {
        repairs.push(`${path}.sourceIds[${sourceIndex}] removed because the source is already owned`);
        continue;
      }
      if (entrySources.includes(sourceId)) {
        repairs.push(`${path}.sourceIds[${sourceIndex}] removed because it is duplicated`);
        continue;
      }
      entrySources.push(sourceId);
    }
    if (entrySources.length === 0) {
      repairs.push(`${path} dropped because no sourceIds remain`);
      continue;
    }
    entrySources.forEach((sourceId) => {
      sourceOwners.set(sourceId, path);
    });
    cleanUnresolved.push({
      sourceIds: entrySources,
      reason: rawEntry.reason,
    });
  }

  const plan: SuggestionPlan = {
    version: 1,
    lens: request.lens,
    tier: 't2',
    items: cleanItems,
    unresolved: cleanUnresolved,
  };
  const safety = validateSuggestionPlan(plan, {
    maxItems: INTERPRET_PLAN_LIMITS.maxItems,
    maxPoints: INTERPRET_PLAN_LIMITS.maxPoints,
    maxStringLength: INTERPRET_PLAN_LIMITS.maxTextLength,
  });
  if (!safety.ok) {
    return safety;
  }
  return { ok: true, plan, dropped, repairs };
};

export const getRequestBounds = (request: InterpretRequest) => {
  const xValues: number[] = [];
  const yValues: number[] = [];
  request.strokes.forEach((stroke) => {
    stroke.points.forEach((point) => {
      xValues.push(point.x);
      yValues.push(point.y);
    });
  });
  request.texts.forEach((text) => {
    xValues.push(text.x, text.x + text.width);
    yValues.push(text.y, text.y + text.height);
  });
  if (xValues.length === 0 || yValues.length === 0) {
    return {
      minX: -COORDINATE_MARGIN,
      minY: -COORDINATE_MARGIN,
      maxX: COORDINATE_MARGIN,
      maxY: COORDINATE_MARGIN,
    };
  }
  return {
    minX: Math.min(...xValues),
    minY: Math.min(...yValues),
    maxX: Math.max(...xValues),
    maxY: Math.max(...yValues),
  };
};

const parseShape = (
  raw: Record<string, unknown>,
  id: string | undefined,
  sourceIds: string[],
  metadata: Metadata,
  bounds: ReturnType<typeof getRequestBounds>,
  path: string,
  errors: string[],
  repairs: string[],
): ShapeSuggestionItem | undefined => {
  if (
    raw.shape !== 'rectangle'
    && raw.shape !== 'roundedRectangle'
    && raw.shape !== 'diamond'
    && raw.shape !== 'ellipse'
  ) {
    errors.push(`${path}.shape is invalid`);
  }
  const x = readFiniteNumber(raw.x, `${path}.x`, errors);
  const y = readFiniteNumber(raw.y, `${path}.y`, errors);
  const width = readPositiveNumber(raw.width, `${path}.width`, errors);
  const height = readPositiveNumber(raw.height, `${path}.height`, errors);
  if (x !== undefined) {
    checkCoordinate(x, `${path}.x`, 'x', bounds, errors);
    checkCoordinate(x + (width ?? 0), `${path}.right`, 'x', bounds, errors);
  }
  if (y !== undefined) {
    checkCoordinate(y, `${path}.y`, 'y', bounds, errors);
    checkCoordinate(y + (height ?? 0), `${path}.bottom`, 'y', bounds, errors);
  }
  const label = readLabel(raw.label, `${path}.label`, repairs);
  const children = readChildren(raw.children, `${path}.children`, repairs);
  if (
    !id
    || !sourceIds.length
    || x === undefined
    || y === undefined
    || width === undefined
    || height === undefined
  ) {
    return undefined;
  }
  return {
    id,
    kind: 'shape',
    shape: raw.shape as ShapeSuggestionItem['shape'],
    x,
    y,
    width,
    height,
    sourceIds,
    ...(label !== undefined ? { label } : {}),
    ...(children !== undefined ? { children } : {}),
    ...metadata,
  };
};

const parseConnector = (
  raw: Record<string, unknown>,
  id: string | undefined,
  sourceIds: string[],
  metadata: Metadata,
  bounds: ReturnType<typeof getRequestBounds>,
  path: string,
  errors: string[],
  repairs: string[],
): ConnectorSuggestionItem | undefined => {
  const points = readTuplePoints(raw.points, `${path}.points`, bounds, errors);
  const start = readNodeRef(raw.start, `${path}.start`, repairs);
  const end = readNodeRef(raw.end, `${path}.end`, repairs);
  if (raw.startArrowhead !== 'arrow' && raw.startArrowhead !== null) {
    errors.push(`${path}.startArrowhead is invalid`);
  }
  if (raw.endArrowhead !== 'arrow' && raw.endArrowhead !== null) {
    errors.push(`${path}.endArrowhead is invalid`);
  }
  const label = readLabel(raw.label, `${path}.label`, repairs);
  if (!id || !sourceIds.length || points.length < 2) {
    return undefined;
  }
  return {
    id,
    kind: 'connector',
    points,
    start,
    end,
    startArrowhead: raw.startArrowhead as 'arrow' | null,
    endArrowhead: raw.endArrowhead as 'arrow' | null,
    sourceIds,
    ...(label !== undefined ? { label } : {}),
    ...metadata,
  };
};

const parseStroke = (
  raw: Record<string, unknown>,
  id: string | undefined,
  sourceIds: string[],
  metadata: Metadata,
  bounds: ReturnType<typeof getRequestBounds>,
  path: string,
  errors: string[],
  repairs: string[],
): StrokeSuggestionItem | undefined => {
  const primitive = raw.primitive;
  if (
    primitive !== 'line'
    && primitive !== 'curve'
    && primitive !== 'ellipse'
    && primitive !== 'rectangle'
    && primitive !== 'freedraw'
  ) {
    errors.push(`${path}.primitive is invalid`);
  }
  const points = readPointObjects(raw.points, `${path}.points`, bounds, errors);
  const strokeBounds = readBounds(raw.bounds, `${path}.bounds`, bounds, errors);
  const needsPoints = primitive === 'line' || primitive === 'curve' || primitive === 'freedraw';
  const needsBounds = primitive === 'ellipse' || primitive === 'rectangle';
  if (needsPoints && points.length < 2) {
    errors.push(`${path}.points must contain at least two points for ${String(primitive)}`);
  }
  if (needsBounds && !strokeBounds) {
    errors.push(`${path}.bounds is required for ${String(primitive)}`);
  }
  if (
    !id
    || !sourceIds.length
    || (
      (needsPoints && points.length < 2)
      || (needsBounds && !strokeBounds)
    )
  ) {
    return undefined;
  }
  return {
    id,
    kind: 'stroke',
    primitive: primitive as StrokeSuggestionItem['primitive'],
    sourceIds,
    ...(points.length > 0 ? { points } : {}),
    ...(strokeBounds ? { bounds: strokeBounds } : {}),
    ...metadata,
  };
};

const parseText = (
  raw: Record<string, unknown>,
  id: string | undefined,
  sourceIds: string[],
  metadata: Metadata,
  bounds: ReturnType<typeof getRequestBounds>,
  path: string,
  errors: string[],
): TextSuggestionItem | undefined => {
  const x = readFiniteNumber(raw.x, `${path}.x`, errors);
  const y = readFiniteNumber(raw.y, `${path}.y`, errors);
  if (x !== undefined) {
    checkCoordinate(x, `${path}.x`, 'x', bounds, errors);
  }
  if (y !== undefined) {
    checkCoordinate(y, `${path}.y`, 'y', bounds, errors);
  }
  const text = readRequiredString(
    raw.text,
    `${path}.text`,
    INTERPRET_PLAN_LIMITS.maxTextLength,
    errors,
  );
  if (!id || !sourceIds.length || x === undefined || y === undefined || !text) {
    return undefined;
  }
  return {
    id,
    kind: 'text',
    x,
    y,
    text,
    sourceIds,
    ...metadata,
  };
};

type Metadata = {
  confidence?: number;
  reason?: string;
};

const readMetadata = (
  raw: Record<string, unknown>,
  path: string,
  repairs: string[],
): Metadata => {
  const metadata: Metadata = {};
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') {
      repairs.push(`${path}.reason omitted because it is not a string`);
    } else if (raw.reason.length > INTERPRET_PLAN_LIMITS.maxReasonLength) {
      metadata.reason = raw.reason.slice(0, INTERPRET_PLAN_LIMITS.maxReasonLength);
      repairs.push(`${path}.reason truncated to ${INTERPRET_PLAN_LIMITS.maxReasonLength} characters`);
    } else {
      metadata.reason = raw.reason;
    }
  }
  if (raw.confidence !== undefined) {
    if (
      typeof raw.confidence !== 'number'
      || !Number.isFinite(raw.confidence)
      || raw.confidence < 0
      || raw.confidence > 1
    ) {
      repairs.push(`${path}.confidence omitted because it is outside 0 to 1`);
    } else {
      metadata.confidence = raw.confidence;
    }
  }
  return metadata;
};

const readLabel = (
  value: unknown,
  path: string,
  repairs: string[],
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    repairs.push(`${path} omitted because it is not a string`);
    return undefined;
  }
  if (value.length > INTERPRET_PLAN_LIMITS.maxTextLength) {
    repairs.push(`${path} truncated to ${INTERPRET_PLAN_LIMITS.maxTextLength} characters`);
    return value.slice(0, INTERPRET_PLAN_LIMITS.maxTextLength);
  }
  return value;
};

const readChildren = (
  value: unknown,
  path: string,
  repairs: string[],
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    repairs.push(`${path} removed because it is not an array`);
    return undefined;
  }
  const children: string[] = [];
  value.forEach((entry, index) => {
    if (
      typeof entry !== 'string'
      || entry.length === 0
      || entry.length > INTERPRET_PLAN_LIMITS.maxIdLength
    ) {
      repairs.push(`${path}[${index}] removed because it is invalid`);
      return;
    }
    children.push(entry);
  });
  return children;
};

const readSourceIds = (
  value: unknown,
  path: string,
  allowedSourceIds: ReadonlySet<string>,
  errors: string[],
): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}.sourceIds must be non-empty`);
    return [];
  }
  const sourceIds: string[] = [];
  for (const [index, valueItem] of value.entries()) {
    const sourceId = readId(valueItem, `${path}.sourceIds[${index}]`);
    if (!sourceId) {
      errors.push(idError(valueItem, `${path}.sourceIds[${index}]`));
      continue;
    }
    if (!allowedSourceIds.has(sourceId)) {
      errors.push(`${path} references unknown source "${sourceId}"`);
    }
    if (sourceIds.includes(sourceId)) {
      errors.push(`source "${sourceId}" belongs to both "${path}" and "${path}"`);
    }
    sourceIds.push(sourceId);
  }
  return sourceIds;
};

const readNodeRef = (
  value: unknown,
  path: string,
  repairs: string[],
): NodeRef | null => {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'itemId')
    || typeof value.itemId !== 'string'
    || value.itemId.length === 0
    || value.itemId.length > INTERPRET_PLAN_LIMITS.maxIdLength
  ) {
    repairs.push(`${path} normalized to null because it is malformed`);
    return null;
  }
  return { itemId: value.itemId };
};

const cleanNodeRef = (
  ref: NodeRef | null,
  knownItemIds: ReadonlySet<string>,
  shapeIds: ReadonlySet<string>,
  path: string,
  repairs: string[],
): NodeRef | null => {
  if (!ref) {
    return null;
  }
  if (!('itemId' in ref) || !knownItemIds.has(ref.itemId) || !shapeIds.has(ref.itemId)) {
    repairs.push(`${path} normalized to null because it does not reference a kept shape`);
    return null;
  }
  return ref;
};

const readId = (
  value: unknown,
  _path: string,
): string | undefined => {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > INTERPRET_PLAN_LIMITS.maxIdLength
  ) {
    return undefined;
  }
  return value;
};

const idError = (
  value: unknown,
  path: string,
): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return `${path} must be a non-empty string`;
  }
  return `${path} is too long`;
};

const readRequiredString = (
  value: unknown,
  path: string,
  maxLength: number,
  errors: string[],
): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }
  if (value.length > maxLength) {
    errors.push(`${path} is too long`);
    return undefined;
  }
  return value;
};

const readFiniteNumber = (
  value: unknown,
  path: string,
  errors: string[],
): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} must be finite`);
    return undefined;
  }
  return value;
};

const readPositiveNumber = (
  value: unknown,
  path: string,
  errors: string[],
): number | undefined => {
  const number = readFiniteNumber(value, path, errors);
  if (number !== undefined && number <= 0) {
    errors.push(`${path} must be positive`);
    return undefined;
  }
  return number;
};

const readPointObjects = (
  value: unknown,
  path: string,
  bounds: ReturnType<typeof getRequestBounds>,
  errors: string[],
): { x: number; y: number }[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (value.length > INTERPRET_PLAN_LIMITS.maxPointsPerItem) {
    errors.push(`${path} has too many points`);
  }
  const points: { x: number; y: number }[] = [];
  value.forEach((point, index) => {
    if (!isRecord(point)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    const x = readFiniteNumber(point.x, `${path}[${index}].x`, errors);
    const y = readFiniteNumber(point.y, `${path}[${index}].y`, errors);
    if (x !== undefined) {
      checkCoordinate(x, `${path}[${index}].x`, 'x', bounds, errors);
    }
    if (y !== undefined) {
      checkCoordinate(y, `${path}[${index}].y`, 'y', bounds, errors);
    }
    if (x !== undefined && y !== undefined) {
      points.push({ x, y });
    }
  });
  return points;
};

const readTuplePoints = (
  value: unknown,
  path: string,
  bounds: ReturnType<typeof getRequestBounds>,
  errors: string[],
): [number, number][] => {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (value.length > INTERPRET_PLAN_LIMITS.maxPointsPerItem) {
    errors.push(`${path} has too many points`);
  }
  const points: [number, number][] = [];
  value.forEach((point, index) => {
    if (
      !Array.isArray(point)
      || point.length !== 2
      || typeof point[0] !== 'number'
      || typeof point[1] !== 'number'
      || !Number.isFinite(point[0])
      || !Number.isFinite(point[1])
    ) {
      errors.push(`${path}[${index}] must be a finite [x, y] tuple`);
      return;
    }
    checkCoordinate(point[0], `${path}[${index}][0]`, 'x', bounds, errors);
    checkCoordinate(point[1], `${path}[${index}][1]`, 'y', bounds, errors);
    points.push([point[0], point[1]]);
  });
  if (points.length < 2) {
    errors.push(`${path} must contain at least two points`);
  }
  return points;
};

const readBounds = (
  value: unknown,
  path: string,
  requestBounds: ReturnType<typeof getRequestBounds>,
  errors: string[],
): { x: number; y: number; width: number; height: number } | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const x = readFiniteNumber(value.x, `${path}.x`, errors);
  const y = readFiniteNumber(value.y, `${path}.y`, errors);
  const width = readPositiveNumber(value.width, `${path}.width`, errors);
  const height = readPositiveNumber(value.height, `${path}.height`, errors);
  if (x !== undefined) {
    checkCoordinate(x, `${path}.x`, 'x', requestBounds, errors);
    checkCoordinate(x + (width ?? 0), `${path}.right`, 'x', requestBounds, errors);
  }
  if (y !== undefined) {
    checkCoordinate(y, `${path}.y`, 'y', requestBounds, errors);
    checkCoordinate(y + (height ?? 0), `${path}.bottom`, 'y', requestBounds, errors);
  }
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
};

const checkCoordinate = (
  value: number,
  path: string,
  axis: 'x' | 'y',
  bounds: ReturnType<typeof getRequestBounds>,
  errors: string[],
) => {
  const min = axis === 'x' ? bounds.minX : bounds.minY;
  const max = axis === 'x' ? bounds.maxX : bounds.maxY;
  if (value < min - COORDINATE_MARGIN || value > max + COORDINATE_MARGIN) {
    errors.push(`${path} is outside the request bounds`);
  }
};

const formatDropped = (
  path: string,
  id: string | undefined,
  error: string,
): string => `${path}${id ? ` (${id})` : ''}: ${error}`;

const isRecord = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
