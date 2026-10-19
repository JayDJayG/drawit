import type {
  ConnectorSuggestionItem,
  NodeRef,
  ShapeSuggestionItem,
  SuggestionItem,
  SuggestionPlan,
  TextSuggestionItem,
} from './types';

export type PlanValidationOptions = {
  knownElementIds?: ReadonlySet<string>;
  maxItems?: number;
  maxPoints?: number;
  maxStringLength?: number;
};

export type PlanValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

const DEFAULT_MAX_ITEMS = 256;
const DEFAULT_MAX_POINTS = 8192;
const DEFAULT_MAX_STRING_LENGTH = 10_000;

export const validateSuggestionPlan = (
  plan: unknown,
  options: PlanValidationOptions = {},
): PlanValidationResult => {
  const errors: string[] = [];
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  if (!isRecord(plan)) {
    return { ok: false, errors: ['plan must be an object'] };
  }

  if (plan.version !== 1) {
    errors.push('plan version must be 1');
  }
  if (plan.lens !== 'stroke' && plan.lens !== 'diagram') {
    errors.push('plan lens is invalid');
  }
  if (plan.tier !== 't0' && plan.tier !== 't2') {
    errors.push('plan tier is invalid');
  }
  if (!Array.isArray(plan.items)) {
    errors.push('plan items must be an array');
  }
  if (!Array.isArray(plan.unresolved)) {
    errors.push('plan unresolved must be an array');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const items = plan.items as unknown[];
  if (items.length > maxItems) {
    errors.push(`plan contains too many items (maximum ${maxItems})`);
  }

  const itemIds = new Set<string>();
  const knownItemIds = new Set<string>();
  const sourceOwners = new Map<string, string>();
  const shapeIds = new Set<string>();
  let pointCount = 0;

  for (const rawItem of items) {
    if (!isRecord(rawItem)) {
      continue;
    }
    if (typeof rawItem.id === 'string' && rawItem.id.length > 0) {
      knownItemIds.add(rawItem.id);
      if (rawItem.kind === 'shape') {
        shapeIds.add(rawItem.id);
      }
    }
  }

  for (const [index, rawItem] of items.entries()) {
    const itemPath = `items[${index}]`;
    if (!isRecord(rawItem)) {
      errors.push(`${itemPath} must be an object`);
      continue;
    }

    const item = rawItem as Partial<SuggestionItem>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      errors.push(`${itemPath}.id must be a non-empty string`);
    } else if (itemIds.has(item.id)) {
      errors.push(`duplicate item id "${item.id}"`);
    } else {
      itemIds.add(item.id);
    }

    if (!Array.isArray(item.sourceIds) || item.sourceIds.length === 0) {
      errors.push(`${itemPath}.sourceIds must be non-empty`);
    } else {
      for (const sourceId of item.sourceIds) {
        if (typeof sourceId !== 'string' || sourceId.length === 0) {
          errors.push(`${itemPath}.sourceIds contains an invalid id`);
          continue;
        }
        const owner = sourceOwners.get(sourceId);
        if (owner) {
          errors.push(`source "${sourceId}" belongs to both "${owner}" and "${item.id ?? itemPath}"`);
        } else {
          sourceOwners.set(sourceId, typeof item.id === 'string' ? item.id : itemPath);
        }
      }
    }

    if (typeof item.confidence === 'number' && !Number.isFinite(item.confidence)) {
      errors.push(`${itemPath}.confidence must be finite`);
    }
    if (typeof item.reason === 'string' && item.reason.length > maxStringLength) {
      errors.push(`${itemPath}.reason is too long`);
    }

    switch (item.kind) {
      case 'stroke': {
        if (!isStrokePrimitive(item.primitive)) {
          errors.push(`${itemPath}.primitive is invalid`);
        }
        pointCount += validatePoints(item.points, `${itemPath}.points`, errors);
        validateBounds(item.bounds, `${itemPath}.bounds`, errors);
        break;
      }
      case 'shape': {
        if (!isShapeKind(item.shape)) {
          errors.push(`${itemPath}.shape is invalid`);
        }
        validateFiniteNumber(item.x, `${itemPath}.x`, errors);
        validateFiniteNumber(item.y, `${itemPath}.y`, errors);
        validatePositiveNumber(item.width, `${itemPath}.width`, errors);
        validatePositiveNumber(item.height, `${itemPath}.height`, errors);
        validateOptionalString(item.label, `${itemPath}.label`, maxStringLength, errors);
        if (Array.isArray(item.children)) {
          for (const child of item.children) {
            if (typeof child !== 'string' || child.length === 0) {
              errors.push(`${itemPath}.children contains an invalid id`);
            }
          }
        } else if (item.children !== undefined) {
          errors.push(`${itemPath}.children must be an array`);
        }
        if (typeof item.id === 'string') {
        }
        break;
      }
      case 'connector': {
        pointCount += validateTuplePoints(item.points, `${itemPath}.points`, errors);
        validateNodeRef(item.start, `${itemPath}.start`, knownItemIds, shapeIds, options.knownElementIds, errors);
        validateNodeRef(item.end, `${itemPath}.end`, knownItemIds, shapeIds, options.knownElementIds, errors);
        if (item.startArrowhead !== 'arrow' && item.startArrowhead !== null) {
          errors.push(`${itemPath}.startArrowhead is invalid`);
        }
        if (item.endArrowhead !== 'arrow' && item.endArrowhead !== null) {
          errors.push(`${itemPath}.endArrowhead is invalid`);
        }
        validateOptionalString(item.label, `${itemPath}.label`, maxStringLength, errors);
        break;
      }
      case 'text': {
        validateFiniteNumber(item.x, `${itemPath}.x`, errors);
        validateFiniteNumber(item.y, `${itemPath}.y`, errors);
        if (typeof item.text !== 'string' || item.text.length === 0) {
          errors.push(`${itemPath}.text must be a non-empty string`);
        } else if (item.text.length > maxStringLength) {
          errors.push(`${itemPath}.text is too long`);
        }
        break;
      }
      default:
        errors.push(`${itemPath}.kind is invalid`);
    }
  }

  for (const [index, unresolved] of (plan.unresolved as unknown[]).entries()) {
    if (!isRecord(unresolved)) {
      errors.push(`unresolved[${index}] must be an object`);
      continue;
    }
    if (
      !Array.isArray(unresolved.sourceIds)
      || unresolved.sourceIds.length === 0
      || unresolved.sourceIds.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      errors.push(`unresolved[${index}].sourceIds must be non-empty strings`);
    } else {
      for (const sourceId of unresolved.sourceIds) {
        const owner = sourceOwners.get(sourceId);
        if (owner) {
          errors.push(`source "${sourceId}" belongs to both "${owner}" and unresolved[${index}]`);
        } else {
          sourceOwners.set(sourceId, `unresolved[${index}]`);
        }
      }
    }
    if (typeof unresolved.reason !== 'string' || unresolved.reason.length === 0) {
      errors.push(`unresolved[${index}].reason must be a non-empty string`);
    } else if (unresolved.reason.length > maxStringLength) {
      errors.push(`unresolved[${index}].reason is too long`);
    }
  }

  if (pointCount > maxPoints) {
    errors.push(`plan contains too many points (maximum ${maxPoints})`);
  }

  for (const item of items as SuggestionItem[]) {
    if (item.kind !== 'shape' || !item.children) {
      continue;
    }
    for (const childId of item.children) {
      if (!knownItemIds.has(childId) || !shapeIds.has(childId)) {
        errors.push(`shape "${item.id}" references unknown child "${childId}"`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
};

export const assertSuggestionPlan = (plan: SuggestionPlan): SuggestionPlan => {
  const result = validateSuggestionPlan(plan);
  if (!result.ok) {
    throw new Error(`Invalid suggestion plan: ${result.errors.join('; ')}`);
  }
  return plan;
};

export const acceptedSuggestionItems = (
  plan: SuggestionPlan,
  rejectedItemIds: ReadonlySet<string>,
): SuggestionItem[] => {
  const acceptedIds = new Set(
    plan.items
      .filter((item) => !rejectedItemIds.has(item.id))
      .map((item) => item.id),
  );

  return plan.items
    .filter((item) => acceptedIds.has(item.id))
    .map((item) => {
      if (item.kind !== 'connector') {
        return item;
      }

      return {
        ...item,
        start: resolveAcceptedNodeRef(item.start, acceptedIds),
        end: resolveAcceptedNodeRef(item.end, acceptedIds),
      };
    });
};

export const summarizeSuggestionPlan = (
  plan: SuggestionPlan,
  rejectedItemIds: ReadonlySet<string> = new Set(),
): string => {
  const items = acceptedSuggestionItems(plan, rejectedItemIds);
  const shapes = items.filter((item) => item.kind === 'shape').length;
  const arrows = items.filter((item) => item.kind === 'connector').length;
  const labels = items.filter((item) => {
    return (item.kind === 'shape' || item.kind === 'connector') && Boolean(item.label);
  }).length + items.filter((item) => item.kind === 'text').length;
  const unresolvedCount = plan.unresolved.length;
  const parts: string[] = [];

  if (shapes > 0) {
    parts.push(`${shapes} ${shapes === 1 ? 'shape' : 'shapes'}`);
  }
  if (arrows > 0) {
    parts.push(`${arrows} ${arrows === 1 ? 'arrow' : 'arrows'}`);
  }
  if (labels > 0) {
    parts.push(`${labels} ${labels === 1 ? 'label' : 'labels'}`);
  }
  if (parts.length === 0) {
    parts.push('no changes');
  }
  if (unresolvedCount > 0) {
    parts.push(`${unresolvedCount} ${unresolvedCount === 1 ? 'stroke' : 'strokes'} left as drawn`);
  }
  return parts.join(', ');
};

export const formatSuggestionPreviewStatus = (
  plan: SuggestionPlan,
  rejectedItemIds: ReadonlySet<string> = new Set(),
  label = 'Diagram',
  skipped = 0,
): string => {
  const acceptedCount = plan.items.filter((item) => !rejectedItemIds.has(item.id)).length;
  const skippedText = skipped > 0
    ? ` (${skipped} suggestion${skipped === 1 ? '' : 's'} skipped)`
    : '';
  return `${label}: ${summarizeSuggestionPlan(plan, rejectedItemIds)}${skippedText}. Click an item to reject or restore it. Enter applies ${acceptedCount} of ${plan.items.length}. Esc dismisses.`;
};

export const getPlanSourceIds = (plan: SuggestionPlan): string[] => {
  const ids = new Set<string>();
  for (const item of plan.items) {
    item.sourceIds.forEach((id) => ids.add(id));
  }
  return [...ids];
};

const resolveAcceptedNodeRef = (
  ref: NodeRef | null,
  acceptedIds: ReadonlySet<string>,
): NodeRef | null => {
  if (!ref || !('itemId' in ref)) {
    return ref;
  }
  return acceptedIds.has(ref.itemId) ? ref : null;
};

const isRecord = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isShapeKind = (value: unknown): value is ShapeSuggestionItem['shape'] => {
  return value === 'rectangle'
    || value === 'roundedRectangle'
    || value === 'diamond'
    || value === 'ellipse';
};

const isStrokePrimitive = (value: unknown): value is 'line' | 'curve' | 'ellipse' | 'rectangle' | 'freedraw' => {
  return value === 'line'
    || value === 'curve'
    || value === 'ellipse'
    || value === 'rectangle'
    || value === 'freedraw';
};

const validateFiniteNumber = (
  value: unknown,
  path: string,
  errors: string[],
) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} must be finite`);
  }
};

const validatePositiveNumber = (
  value: unknown,
  path: string,
  errors: string[],
) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${path} must be positive and finite`);
  }
};

const validateOptionalString = (
  value: unknown,
  path: string,
  maxLength: number,
  errors: string[],
) => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`);
  } else if (value.length > maxLength) {
    errors.push(`${path} is too long`);
  }
};

const validateBounds = (
  value: unknown,
  path: string,
  errors: string[],
) => {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateFiniteNumber(value.x, `${path}.x`, errors);
  validateFiniteNumber(value.y, `${path}.y`, errors);
  validatePositiveNumber(value.width, `${path}.width`, errors);
  validatePositiveNumber(value.height, `${path}.height`, errors);
};

const validatePoints = (
  value: unknown,
  path: string,
  errors: string[],
): number => {
  if (value === undefined) {
    return 0;
  }
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return 0;
  }
  let count = 0;
  for (const [index, point] of value.entries()) {
    if (!isRecord(point)) {
      errors.push(`${path}[${index}] must be an object`);
      continue;
    }
    validateFiniteNumber(point.x, `${path}[${index}].x`, errors);
    validateFiniteNumber(point.y, `${path}[${index}].y`, errors);
    count += 1;
  }
  return count;
};

const validateTuplePoints = (
  value: unknown,
  path: string,
  errors: string[],
): number => {
  if (!Array.isArray(value) || value.length < 2) {
    errors.push(`${path} must contain at least two points`);
    return 0;
  }
  let count = 0;
  for (const [index, point] of value.entries()) {
    if (
      !Array.isArray(point)
      || point.length !== 2
      || typeof point[0] !== 'number'
      || typeof point[1] !== 'number'
      || !Number.isFinite(point[0])
      || !Number.isFinite(point[1])
    ) {
      errors.push(`${path}[${index}] must be a finite [x, y] tuple`);
      continue;
    }
    count += 1;
  }
  return count;
};

const validateNodeRef = (
  value: unknown,
  path: string,
  itemIds: ReadonlySet<string>,
  shapeIds: ReadonlySet<string>,
  knownElementIds: ReadonlySet<string> | undefined,
  errors: string[],
) => {
  if (value === null) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${path} must be null or a node reference`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== 'itemId' && keys[0] !== 'elementId')) {
    errors.push(`${path} contains an unknown node reference`);
    return;
  }
  const key = keys[0];
  const id = value[key];
  if (typeof id !== 'string' || id.length === 0) {
    errors.push(`${path}.${key} must be a non-empty string`);
    return;
  }
  if (key === 'itemId') {
    if (!itemIds.has(id)) {
      errors.push(`${path}.itemId "${id}" does not resolve`);
    } else if (!shapeIds.has(id)) {
      errors.push(`${path}.itemId "${id}" is not a shape`);
    }
  }
  if (key === 'elementId' && knownElementIds && !knownElementIds.has(id)) {
    errors.push(`${path}.elementId "${id}" does not resolve`);
  }
};
