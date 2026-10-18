import {
  validateSuggestionPlan,
  type SuggestionItem,
  type SuggestionPlan,
} from '../../core/suggestions';
import type { InterpretRequest } from './types';

export type InterpretValidationResult =
  | { ok: true; plan: SuggestionPlan }
  | { ok: false; errors: string[] };

const MAX_ITEMS = 128;
const MAX_POINTS = 4096;
const MAX_STRING_LENGTH = 4000;
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
    maxItems: MAX_ITEMS,
    maxPoints: MAX_POINTS,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!base.ok) {
    return base;
  }
  const plan = value as SuggestionPlan;
  const errors: string[] = [];
  if (plan.tier !== 't2') {
    errors.push('response tier must be t2');
  }
  if (plan.lens !== request.lens) {
    errors.push('response lens does not match the request');
  }

  const allowedSourceIds = new Set([
    ...request.strokes.map((stroke) => stroke.id),
    ...request.texts.map((text) => text.id),
  ]);
  const bounds = getRequestBounds(request);
  const sourceIds = new Set<string>();
  for (const item of plan.items) {
    for (const sourceId of item.sourceIds) {
      if (!allowedSourceIds.has(sourceId)) {
        errors.push(`item "${item.id}" references unknown source "${sourceId}"`);
      }
      if (sourceIds.has(sourceId)) {
        errors.push(`source "${sourceId}" is used by more than one item`);
      }
      sourceIds.add(sourceId);
    }
    validateItemGeometry(item, bounds, errors);
    if (item.kind === 'connector') {
      validateInterpretRef(item.start, plan.items, allowedSourceIds, errors);
      validateInterpretRef(item.end, plan.items, allowedSourceIds, errors);
    }
  }
  for (const unresolved of plan.unresolved) {
    for (const sourceId of unresolved.sourceIds) {
      if (!allowedSourceIds.has(sourceId)) {
        errors.push(`unresolved references unknown source "${sourceId}"`);
      }
      if (sourceIds.has(sourceId)) {
        errors.push(`source "${sourceId}" is both resolved and unresolved`);
      }
      sourceIds.add(sourceId);
    }
  }

  return errors.length === 0 ? { ok: true, plan } : { ok: false, errors };
};

const validateItemGeometry = (
  item: SuggestionItem,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  errors: string[],
) => {
  const checkCoordinate = (value: number, path: string) => {
    if (!Number.isFinite(value)) {
      errors.push(`${path} must be finite`);
      return;
    }
    if (
      value < bounds.minX - COORDINATE_MARGIN
      || value > bounds.maxX + COORDINATE_MARGIN
    ) {
      errors.push(`${path} is outside the request bounds`);
    }
  };
  switch (item.kind) {
    case 'shape':
      checkCoordinate(item.x, `${item.id}.x`);
      checkCoordinate(item.y, `${item.id}.y`);
      checkCoordinate(item.x + item.width, `${item.id}.right`);
      checkCoordinate(item.y + item.height, `${item.id}.bottom`);
      if (item.width <= 0 || item.height <= 0) {
        errors.push(`${item.id} has a non-positive size`);
      }
      break;
    case 'connector':
      if (item.points.length > MAX_POINTS) {
        errors.push(`${item.id} has too many points`);
      }
      item.points.forEach(([x, y], index) => {
        checkCoordinate(x, `${item.id}.points[${index}][0]`);
        checkCoordinate(y, `${item.id}.points[${index}][1]`);
      });
      break;
    case 'stroke':
      item.points?.forEach((point, index) => {
        checkCoordinate(point.x, `${item.id}.points[${index}].x`);
        checkCoordinate(point.y, `${item.id}.points[${index}].y`);
      });
      if (item.bounds) {
        checkCoordinate(item.bounds.x, `${item.id}.bounds.x`);
        checkCoordinate(item.bounds.y, `${item.id}.bounds.y`);
        checkCoordinate(item.bounds.x + item.bounds.width, `${item.id}.bounds.right`);
        checkCoordinate(item.bounds.y + item.bounds.height, `${item.id}.bounds.bottom`);
      }
      break;
    case 'text':
      checkCoordinate(item.x, `${item.id}.x`);
      checkCoordinate(item.y, `${item.id}.y`);
      break;
  }
};

const validateInterpretRef = (
  ref: SuggestionItem extends never ? never : { itemId: string } | { elementId: string } | null,
  items: readonly SuggestionItem[],
  allowedSourceIds: ReadonlySet<string>,
  errors: string[],
) => {
  if (!ref) {
    return;
  }
  if ('elementId' in ref) {
    errors.push(`connector references native element "${ref.elementId}" not present in the request`);
    return;
  }
  const target = items.find((item) => item.id === ref.itemId);
  if (!target) {
    errors.push(`connector references unknown item "${ref.itemId}"`);
  } else if (target.kind !== 'shape') {
    errors.push(`connector reference "${ref.itemId}" is not a shape`);
  }
  void allowedSourceIds;
};

const getRequestBounds = (request: InterpretRequest) => {
  const values: number[] = [];
  request.strokes.forEach((stroke) => {
    stroke.points.forEach((point) => values.push(point.x, point.y));
  });
  request.texts.forEach((text) => {
    values.push(text.x, text.y, text.x + text.width, text.y + text.height);
  });
  if (values.length === 0) {
    return { minX: -COORDINATE_MARGIN, minY: -COORDINATE_MARGIN, maxX: COORDINATE_MARGIN, maxY: COORDINATE_MARGIN };
  }
  return {
    minX: Math.min(...values),
    minY: Math.min(...values),
    maxX: Math.max(...values),
    maxY: Math.max(...values),
  };
};
