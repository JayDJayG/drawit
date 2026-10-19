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
  | { ok: true; plan: SuggestionPlan }
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

  const base = validateSuggestionPlan(value, {
    maxItems: INTERPRET_PLAN_LIMITS.maxItems,
    maxPoints: INTERPRET_PLAN_LIMITS.maxPoints,
    maxStringLength: INTERPRET_PLAN_LIMITS.maxTextLength,
  });
  if (!base.ok) {
    return base;
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ['response must be an object'] };
  }

  const errors: string[] = [];
  if (value.tier !== 't2') {
    errors.push('response tier must be t2');
  }
  if (value.lens !== request.lens) {
    errors.push('response lens does not match the request');
  }

  const items = Array.isArray(value.items) ? value.items : [];
  const unresolved = Array.isArray(value.unresolved) ? value.unresolved : [];
  if (items.length > INTERPRET_PLAN_LIMITS.maxItems) {
    errors.push(`response contains too many items (maximum ${INTERPRET_PLAN_LIMITS.maxItems})`);
  }
  if (unresolved.length > INTERPRET_PLAN_LIMITS.maxUnresolved) {
    errors.push(`response contains too many unresolved entries (maximum ${INTERPRET_PLAN_LIMITS.maxUnresolved})`);
  }

  const allowedSourceIds = new Set([
    ...request.strokes.map((stroke) => stroke.id),
    ...request.texts.map((text) => text.id),
  ]);
  const bounds = getRequestBounds(request);
  const itemIds = new Set<string>();
  const shapeIds = new Set<string>();
  const sourceOwners = new Map<string, string>();
  const parsedItems: SuggestionItem[] = [];
  let pointCount = 0;

  for (const [index, rawItem] of items.entries()) {
    const itemPath = `items[${index}]`;
    if (!isRecord(rawItem)) {
      errors.push(`${itemPath} must be an object`);
      continue;
    }

    const itemId = readId(rawItem.id, `${itemPath}.id`, errors);
    if (itemId) {
      if (itemIds.has(itemId)) {
        errors.push(`duplicate item id "${itemId}"`);
      }
      itemIds.add(itemId);
      if (rawItem.kind === 'shape') {
        shapeIds.add(itemId);
      }
    }

    const sourceIds = readSourceIds(
      rawItem.sourceIds,
      itemPath,
      allowedSourceIds,
      sourceOwners,
      errors,
    );
    validateOptionalConfidence(rawItem.confidence, `${itemPath}.confidence`, errors);
    const reason = readOptionalString(
      rawItem.reason,
      `${itemPath}.reason`,
      INTERPRET_PLAN_LIMITS.maxReasonLength,
      errors,
    );

    let item: SuggestionItem | undefined;
    switch (rawItem.kind) {
      case 'shape':
        item = parseShape(
          rawItem,
          itemId,
          sourceIds,
          reason,
          bounds,
          `${itemPath}`,
          errors,
        );
        break;
      case 'connector':
        item = parseConnector(
          rawItem,
          itemId,
          sourceIds,
          reason,
          bounds,
          `${itemPath}`,
          errors,
        );
        pointCount += Array.isArray(rawItem.points) ? rawItem.points.length : 0;
        break;
      case 'stroke':
        item = parseStroke(
          rawItem,
          itemId,
          sourceIds,
          reason,
          bounds,
          `${itemPath}`,
          errors,
        );
        pointCount += Array.isArray(rawItem.points) ? rawItem.points.length : 0;
        break;
      case 'text':
        item = parseText(
          rawItem,
          itemId,
          sourceIds,
          reason,
          bounds,
          `${itemPath}`,
          errors,
        );
        break;
      default:
        errors.push(`${itemPath}.kind is invalid`);
    }
    if (item) {
      parsedItems.push(withOptionalMetadata(item, rawItem.confidence, reason));
    }
  }

  const parsedUnresolved: SuggestionPlan['unresolved'] = [];
  for (const [index, rawEntry] of unresolved.entries()) {
    const entryPath = `unresolved[${index}]`;
    if (!isRecord(rawEntry)) {
      errors.push(`${entryPath} must be an object`);
      continue;
    }
    const sourceIds = readSourceIds(
      rawEntry.sourceIds,
      entryPath,
      allowedSourceIds,
      sourceOwners,
      errors,
    );
    const reason = readRequiredString(
      rawEntry.reason,
      `${entryPath}.reason`,
      INTERPRET_PLAN_LIMITS.maxReasonLength,
      errors,
    );
    if (sourceIds.length > 0 && reason) {
      parsedUnresolved.push({ sourceIds, reason });
    }
  }

  for (const item of parsedItems) {
    if (item.kind === 'shape' && item.children) {
      for (const childId of item.children) {
        if (!itemIds.has(childId) || !shapeIds.has(childId)) {
          errors.push(`shape "${item.id}" references unknown child "${childId}"`);
        }
      }
    }
    if (item.kind === 'connector') {
      validateInterpretRef(item.start, itemIds, shapeIds, `${item.id}.start`, errors);
      validateInterpretRef(item.end, itemIds, shapeIds, `${item.id}.end`, errors);
    }
  }

  if (pointCount > INTERPRET_PLAN_LIMITS.maxPoints) {
    errors.push(`response contains too many points (maximum ${INTERPRET_PLAN_LIMITS.maxPoints})`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    plan: {
      version: 1,
      lens: request.lens,
      tier: 't2',
      items: parsedItems,
      unresolved: parsedUnresolved,
    },
  };
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
  reason: string | undefined,
  bounds: ReturnType<typeof getRequestBounds>,
  path: string,
  errors: string[],
): ShapeSuggestionItem | undefined => {
  const shape = raw.shape;
  if (
    shape !== 'rectangle'
    && shape !== 'roundedRectangle'
    && shape !== 'diamond'
    && shape !== 'ellipse'
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
  const label = readOptionalString(
    raw.label,
    `${path}.label`,
    INTERPRET_PLAN_LIMITS.maxTextLength,
    errors,
  );
  const children = readOptionalIds(raw.children, `${path}.children`, errors);
  if (!id || !sourceIds.length || x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return {
    id,
    kind: 'shape',
    shape: shape as ShapeSuggestionItem['shape'],
    x,
    y,
    width,
    height,
    sourceIds,
    ...(label !== undefined ? { label } : {}),
    ...(children !== undefined ? { children } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
};

const parseConnector = (
  raw: Record<string, unknown>,
  id: string | undefined,
  sourceIds: string[],
  reason: string | undefined,
  bounds: ReturnType<typeof getRequestBounds>,
  path: string,
  errors: string[],
): ConnectorSuggestionItem | undefined => {
  const points = readTuplePoints(raw.points, `${path}.points`, bounds, errors);
  const start = readNodeRef(raw.start, `${path}.start`, errors);
  const end = readNodeRef(raw.end, `${path}.end`, errors);
  if (raw.startArrowhead !== 'arrow' && raw.startArrowhead !== null) {
    errors.push(`${path}.startArrowhead is invalid`);
  }
  if (raw.endArrowhead !== 'arrow' && raw.endArrowhead !== null) {
    errors.push(`${path}.endArrowhead is invalid`);
  }
  const label = readOptionalString(
    raw.label,
    `${path}.label`,
    INTERPRET_PLAN_LIMITS.maxTextLength,
    errors,
  );
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
    ...(reason !== undefined ? { reason } : {}),
  };
};

const parseStroke = (
  raw: Record<string, unknown>,
  id: string | undefined,
  sourceIds: string[],
  reason: string | undefined,
  bounds: ReturnType<typeof getRequestBounds>,
  path: string,
  errors: string[],
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
  if (!id || !sourceIds.length || (
    (needsPoints && points.length < 2)
    || (needsBounds && !strokeBounds)
  )) {
    return undefined;
  }
  return {
    id,
    kind: 'stroke',
    primitive: primitive as StrokeSuggestionItem['primitive'],
    sourceIds,
    ...(points.length > 0 ? { points } : {}),
    ...(strokeBounds ? { bounds: strokeBounds } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
};

const parseText = (
  raw: Record<string, unknown>,
  id: string | undefined,
  sourceIds: string[],
  reason: string | undefined,
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
    ...(reason !== undefined ? { reason } : {}),
  };
};

const readSourceIds = (
  value: unknown,
  path: string,
  allowedSourceIds: ReadonlySet<string>,
  sourceOwners: Map<string, string>,
  errors: string[],
): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}.sourceIds must be non-empty`);
    return [];
  }
  const sourceIds: string[] = [];
  for (const [index, valueItem] of value.entries()) {
    const sourceId = readId(valueItem, `${path}.sourceIds[${index}]`, errors);
    if (!sourceId) {
      continue;
    }
    if (!allowedSourceIds.has(sourceId)) {
      errors.push(`${path} references unknown source "${sourceId}"`);
    }
    const owner = sourceOwners.get(sourceId);
    if (owner) {
      errors.push(`source "${sourceId}" belongs to both "${owner}" and "${path}"`);
    } else {
      sourceOwners.set(sourceId, path);
    }
    sourceIds.push(sourceId);
  }
  return sourceIds;
};

const readId = (
  value: unknown,
  path: string,
  errors: string[],
): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }
  if (value.length > INTERPRET_PLAN_LIMITS.maxIdLength) {
    errors.push(`${path} is too long`);
    return undefined;
  }
  return value;
};

const readOptionalIds = (
  value: unknown,
  path: string,
  errors: string[],
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    const id = readId(entry, `${path}[${index}]`, errors);
    if (id) {
      result.push(id);
    }
  });
  return result;
};

const readOptionalString = (
  value: unknown,
  path: string,
  maxLength: number,
  errors: string[],
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`);
    return undefined;
  }
  if (value.length > maxLength) {
    errors.push(`${path} is too long`);
  }
  return value;
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

const readNodeRef = (
  value: unknown,
  path: string,
  errors: string[],
): NodeRef | null => {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    errors.push(`${path} must be null or an itemId reference`);
    return null;
  }
  if (!Object.hasOwn(value, 'itemId')) {
    errors.push(`${path} must reference a suggestion item, not a native element`);
    return null;
  }
  const itemId = readId(value.itemId, `${path}.itemId`, errors);
  return itemId ? { itemId } : null;
};

const validateInterpretRef = (
  ref: NodeRef | null,
  itemIds: ReadonlySet<string>,
  shapeIds: ReadonlySet<string>,
  path: string,
  errors: string[],
) => {
  if (!ref) {
    return;
  }
  if (!('itemId' in ref)) {
    errors.push(`${path} must reference a suggestion item, not a native element`);
    return;
  }
  if (!itemIds.has(ref.itemId)) {
    errors.push(`${path}.itemId "${ref.itemId}" does not resolve`);
  } else if (!shapeIds.has(ref.itemId)) {
    errors.push(`${path}.itemId "${ref.itemId}" is not a shape`);
  }
};

const validateOptionalConfidence = (
  value: unknown,
  path: string,
  errors: string[],
) => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${path} must be a finite number from 0 to 1`);
  }
};

const withOptionalMetadata = (
  item: SuggestionItem,
  confidence: unknown,
  reason: string | undefined,
): SuggestionItem => ({
  ...item,
  ...(typeof confidence === 'number' && Number.isFinite(confidence)
    ? { confidence }
    : {}),
  ...(reason !== undefined ? { reason } : {}),
});

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

const isRecord = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
