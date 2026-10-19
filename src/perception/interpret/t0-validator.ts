import {
  validateSuggestionPlan,
  type ConnectorSuggestionItem,
  type NodeRef,
  type ShapeSuggestionItem,
  type SuggestionItem,
  type SuggestionPlan,
  type TextSuggestionItem,
  type StrokeSuggestionItem,
} from '../../core/suggestions';
import type { InterpretRequest } from './types';

export type T0ValidationResult =
  | { ok: true; plan: SuggestionPlan | null }
  | { ok: false; errors: string[] };

const MAX_ITEMS = 40;
const MAX_UNRESOLVED = 16;
const MAX_POINTS = 384;
const MAX_STRING_LENGTH = 200;
const MAX_REASON_LENGTH = 140;

export const validateT0Plan = (
  value: unknown,
  strokes: InterpretRequest['strokes'],
  texts: InterpretRequest['texts'],
): T0ValidationResult => {
  if (value === null) {
    return { ok: true, plan: null };
  }
  if (!isRecord(value)) {
    return { ok: false, errors: ['request.t0Plan must be an object or null'] };
  }

  const sourceIds = new Set([
    ...strokes.map((stroke) => stroke.id),
    ...texts.map((text) => text.id),
  ]);
  const errors: string[] = [];
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const rawUnresolved = Array.isArray(value.unresolved) ? value.unresolved : [];

  if (value.version !== 1 || value.lens !== 'diagram' || value.tier !== 't0') {
    errors.push('request.t0Plan must be a version 1 diagram t0 plan');
  }
  if (!Array.isArray(value.items)) {
    errors.push('request.t0Plan.items must be an array');
  } else if (rawItems.length > MAX_ITEMS) {
    errors.push(`request.t0Plan.items exceeds the plan limit of ${MAX_ITEMS}`);
  }
  if (!Array.isArray(value.unresolved)) {
    errors.push('request.t0Plan.unresolved must be an array');
  } else if (rawUnresolved.length > MAX_UNRESOLVED) {
    errors.push(`request.t0Plan.unresolved exceeds the plan limit of ${MAX_UNRESOLVED}`);
  }

  const itemIds = new Set<string>();
  const shapeItemIds = new Set<string>();
  const cleanItems: unknown[] = [];

  rawItems.forEach((rawItem) => {
    if (isRecord(rawItem) && typeof rawItem.id === 'string') {
      itemIds.add(rawItem.id);
      if (rawItem.kind === 'shape') {
        shapeItemIds.add(rawItem.id);
      }
    }
  });

  rawItems.forEach((rawItem, index) => {
    const path = `request.t0Plan.items[${index}]`;
    if (!isRecord(rawItem)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (rawItem.id !== `p${index + 1}`) {
      errors.push(`${path}.id must be p${index + 1}`);
    }
    validateSourceIds(rawItem.sourceIds, sourceIds, path, errors);
    validateReasonAndConfidence(rawItem, path, errors);
    if (rawItem.kind === 'connector') {
      validateNodeRef(rawItem.start, `${path}.start`, itemIds, shapeItemIds, errors);
      validateNodeRef(rawItem.end, `${path}.end`, itemIds, shapeItemIds, errors);
    }
    if (rawItem.kind === 'shape' && rawItem.children !== undefined) {
      validateChildren(rawItem.children, `${path}.children`, itemIds, shapeItemIds, errors);
    }
    cleanItems.push(cleanItem(rawItem));
  });

  const cleanUnresolved: unknown[] = [];
  rawUnresolved.forEach((rawEntry, index) => {
    const path = `request.t0Plan.unresolved[${index}]`;
    if (!isRecord(rawEntry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    validateSourceIds(rawEntry.sourceIds, sourceIds, path, errors);
    if (
      typeof rawEntry.reason !== 'string'
      || rawEntry.reason.length === 0
      || rawEntry.reason.length > MAX_REASON_LENGTH
    ) {
      errors.push(`${path}.reason is invalid`);
    }
    cleanUnresolved.push({
      sourceIds: cloneArray(rawEntry.sourceIds),
      reason: rawEntry.reason,
    });
  });

  const cleanPlan = {
    version: 1,
    lens: 'diagram',
    tier: 't0',
    items: cleanItems,
    unresolved: cleanUnresolved,
  };
  const base = validateSuggestionPlan(cleanPlan, {
    maxItems: MAX_ITEMS,
    maxPoints: MAX_POINTS,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!base.ok) {
    errors.push(...base.errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors: uniqueErrors(errors) };
  }
  return { ok: true, plan: cleanPlan as SuggestionPlan };
};

const cleanItem = (rawItem: Record<string, unknown>): SuggestionItem => {
  const base = {
    id: rawItem.id,
    kind: rawItem.kind,
    sourceIds: cloneArray(rawItem.sourceIds),
    ...(rawItem.confidence !== undefined ? { confidence: rawItem.confidence } : {}),
    ...(rawItem.reason !== undefined ? { reason: rawItem.reason } : {}),
  };
  switch (rawItem.kind) {
    case 'shape':
      return {
        ...base,
        shape: rawItem.shape,
        x: rawItem.x,
        y: rawItem.y,
        width: rawItem.width,
        height: rawItem.height,
        ...(rawItem.label !== undefined ? { label: rawItem.label } : {}),
        ...(rawItem.children !== undefined ? { children: cloneArray(rawItem.children) } : {}),
      } as unknown as ShapeSuggestionItem;
    case 'connector':
      return {
        ...base,
        points: cloneArray(rawItem.points),
        start: cleanNodeRef(rawItem.start),
        end: cleanNodeRef(rawItem.end),
        startArrowhead: rawItem.startArrowhead,
        endArrowhead: rawItem.endArrowhead,
        ...(rawItem.label !== undefined ? { label: rawItem.label } : {}),
      } as unknown as ConnectorSuggestionItem;
    case 'stroke':
      return {
        ...base,
        primitive: rawItem.primitive,
        ...(rawItem.points !== undefined ? { points: cloneArray(rawItem.points) } : {}),
        ...(rawItem.bounds !== undefined ? { bounds: rawItem.bounds } : {}),
      } as unknown as StrokeSuggestionItem;
    case 'text':
      return {
        ...base,
        x: rawItem.x,
        y: rawItem.y,
        text: rawItem.text,
      } as unknown as TextSuggestionItem;
    default:
      return base as unknown as SuggestionItem;
  }
};

const cleanNodeRef = (value: unknown): NodeRef | null => {
  if (!isRecord(value) || typeof value.itemId !== 'string') {
    return null;
  }
  return { itemId: value.itemId };
};

const validateSourceIds = (
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
) => {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}.sourceIds must be non-empty`);
    return;
  }
  value.forEach((sourceId, index) => {
    if (
      typeof sourceId !== 'string'
      || sourceId.length > 32
      || !/^s[1-9]\d*$|^t[1-9]\d*$/.test(sourceId)
      || !allowed.has(sourceId)
    ) {
      errors.push(`${path}.sourceIds[${index}] is not a known alias`);
    }
  });
};

const validateReasonAndConfidence = (
  value: Record<string, unknown>,
  path: string,
  errors: string[],
) => {
  if (
    value.reason !== undefined
    && (typeof value.reason !== 'string' || value.reason.length > MAX_REASON_LENGTH)
  ) {
    errors.push(`${path}.reason is invalid`);
  }
  if (
    value.confidence !== undefined
    && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))
  ) {
    errors.push(`${path}.confidence is invalid`);
  }
};

const validateNodeRef = (
  value: unknown,
  path: string,
  itemIds: ReadonlySet<string>,
  shapeItemIds: ReadonlySet<string>,
  errors: string[],
) => {
  if (value === null) {
    return;
  }
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || typeof value.itemId !== 'string'
    || !itemIds.has(value.itemId)
    || !shapeItemIds.has(value.itemId)
  ) {
    errors.push(`${path} must be null or a known shape itemId`);
  }
};

const validateChildren = (
  value: unknown,
  path: string,
  itemIds: ReadonlySet<string>,
  shapeItemIds: ReadonlySet<string>,
  errors: string[],
) => {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  value.forEach((child) => {
    if (
      typeof child !== 'string'
      || !itemIds.has(child)
      || !shapeItemIds.has(child)
    ) {
      errors.push(`${path} contains an unknown shape itemId`);
    }
  });
};

const cloneArray = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value.map((entry) => entry) : [];
};

const uniqueErrors = (errors: string[]): string[] => {
  return [...new Set(errors)];
};

const isRecord = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
