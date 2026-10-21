import type {
  CanvasElement,
  DrawitStroke,
  NativeElementDraft,
  Point,
} from './types';

export const isPreviewElement = (element: CanvasElement): boolean => {
  return element.customData?.drawit === 'preview';
};

export const isFreedrawElement = (element: CanvasElement): boolean => {
  return element.type === 'freedraw' && !element.isDeleted;
};

export const removePreviewElements = <TElement extends CanvasElement>(
  elements: readonly TElement[],
): TElement[] => {
  return elements.filter((element) => !isPreviewElement(element));
};

export const markAsPreview = <TElement extends CanvasElement>(
  element: TElement,
  sourceIds: readonly string[],
  metadata?: {
    planItemId?: string;
    review?: 'accepted' | 'rejected';
  },
): TElement => {
  const customData = {
    ...element.customData,
    drawit: 'preview',
    sourceIds: [...sourceIds],
    ...(metadata?.planItemId ? { planItemId: metadata.planItemId } : {}),
    ...(metadata?.review ? { review: metadata.review } : {}),
  };
  return {
    ...element,
    strokeStyle: 'dashed',
    locked: true,
    opacity: metadata?.review === 'rejected' ? 25 : element.opacity,
    customData,
  };
};

export const setPreviewReview = <TElement extends CanvasElement>(
  element: TElement,
  review: 'accepted' | 'rejected',
): TElement => {
  if (!isPreviewElement(element)) {
    return element;
  }
  return {
    ...element,
    opacity: review === 'rejected' ? 25 : 100,
    customData: {
      ...element.customData,
      review,
    },
  };
};

const SOURCE_VEIL_OPACITY = 72;

export const isSourceVeil = (element: CanvasElement): boolean => {
  return isPreviewElement(element) && element.customData?.role === 'veil';
};

const getVeilItemIds = (element: CanvasElement): string[] => {
  const itemIds = element.customData?.planItemIds;
  return Array.isArray(itemIds)
    ? itemIds.filter((itemId): itemId is string => typeof itemId === 'string')
    : [];
};

const sourceVeilOpacity = (
  itemIds: readonly string[],
  rejectedItemIds: ReadonlySet<string>,
): number => {
  return itemIds.some((itemId) => !rejectedItemIds.has(itemId))
    ? SOURCE_VEIL_OPACITY
    : 0;
};

/**
 * Inserts a preview-only copy of each freedraw stroke behind a suggestion,
 * directly above its source and painted in the canvas colour, so the
 * originals fade while the suggestion is reviewed. The user's own elements
 * are never modified.
 */
export const withSourceVeils = <TElement extends CanvasElement>(
  elements: readonly TElement[],
  items: ReadonlyArray<{ id: string; sourceIds: readonly string[] }>,
  backgroundColor: string,
  rejectedItemIds: ReadonlySet<string> = new Set(),
): TElement[] => {
  const itemIdsBySource = new Map<string, string[]>();
  for (const item of items) {
    for (const sourceId of item.sourceIds) {
      itemIdsBySource.set(sourceId, [...(itemIdsBySource.get(sourceId) ?? []), item.id]);
    }
  }

  return elements.flatMap((element) => {
    const itemIds = itemIdsBySource.get(element.id);
    if (!itemIds || !isFreedrawElement(element) || isPreviewElement(element)) {
      return [element];
    }
    const veil = {
      ...element,
      id: `${element.id}-drawit-veil`,
      index: null,
      strokeColor: backgroundColor,
      backgroundColor: 'transparent',
      opacity: sourceVeilOpacity(itemIds, rejectedItemIds),
      locked: true,
      groupIds: [],
      frameId: null,
      boundElements: null,
      link: null,
      customData: {
        drawit: 'preview',
        role: 'veil',
        sourceIds: [element.id],
        planItemIds: itemIds,
      },
    };
    return [element, veil];
  });
};

export const updateSourceVeil = <TElement extends CanvasElement>(
  element: TElement,
  rejectedItemIds: ReadonlySet<string>,
): TElement => {
  if (!isSourceVeil(element)) {
    return element;
  }
  return {
    ...element,
    opacity: sourceVeilOpacity(getVeilItemIds(element), rejectedItemIds),
  };
};

export const filterOutputElements = <TElement extends CanvasElement>(
  elements: readonly TElement[],
): TElement[] => {
  return elements.filter((element) => !element.isDeleted && !isPreviewElement(element));
};

export const getTargetFreedrawElements = <TElement extends CanvasElement>(
  elements: readonly TElement[],
  selectedElementIds: Readonly<Record<string, true>>,
): TElement[] => {
  const hasSelection = elements.some((element) => {
    return selectedElementIds[element.id] && !element.isDeleted;
  });
  const selected = elements.filter((element) => {
    return selectedElementIds[element.id] && isFreedrawElement(element);
  });

  if (hasSelection) {
    return selected;
  }

  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];

    if (element && isFreedrawElement(element)) {
      return [element];
    }
  }

  return [];
};

export const getAbsoluteFreedrawPoints = (element: CanvasElement): Point[] => {
  if (element.type !== 'freedraw' || !element.points || element.points.length === 0) {
    return [];
  }

  const localBounds = element.points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point[0]),
      minY: Math.min(bounds.minY, point[1]),
      maxX: Math.max(bounds.maxX, point[0]),
      maxY: Math.max(bounds.maxY, point[1]),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
  const center = {
    x: element.x + (localBounds.minX + localBounds.maxX) / 2,
    y: element.y + (localBounds.minY + localBounds.maxY) / 2,
  };
  const cosine = Math.cos(element.angle);
  const sine = Math.sin(element.angle);

  return element.points.map(([x, y]) => {
    const absoluteX = element.x + x;
    const absoluteY = element.y + y;
    const translatedX = absoluteX - center.x;
    const translatedY = absoluteY - center.y;

    return {
      x: translatedX * cosine - translatedY * sine + center.x,
      y: translatedX * sine + translatedY * cosine + center.y,
    };
  });
};

export const freedrawElementToStroke = (element: CanvasElement): DrawitStroke | undefined => {
  if (!isFreedrawElement(element)) {
    return undefined;
  }

  return {
    sourceId: element.id,
    points: getAbsoluteFreedrawPoints(element),
    color: element.strokeColor,
    width: element.strokeWidth,
    opacity: element.opacity,
    angle: element.angle,
  };
};

export const strokesToDrafts = (
  strokes: readonly DrawitStroke[],
  mode: 'straightened' | 'smoothed' | 'circled',
  replacementPoints: readonly Point[],
): NativeElementDraft[] => {
  const source = strokes[0];

  if (!source || replacementPoints.length === 0) {
    return [];
  }

  if (mode === 'circled') {
    const bounds = getPointBounds(replacementPoints);

    return [{
      kind: 'ellipse',
      sourceIds: strokes.map((stroke) => stroke.sourceId),
      bounds: {
        x: bounds.minX,
        y: bounds.minY,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
      },
      style: getStyle(source),
    }];
  }

  if (mode === 'straightened') {
    return [{
      kind: 'line',
      sourceIds: strokes.map((stroke) => stroke.sourceId),
      points: replacementPoints.map((point) => ({ ...point })),
      style: getStyle(source),
    }];
  }

  return [{
    kind: 'freedraw',
    sourceIds: strokes.map((stroke) => stroke.sourceId),
    points: replacementPoints.map((point) => ({ ...point })),
    style: getStyle(source),
  }];
};

export const rectangleDraft = (
  strokes: readonly DrawitStroke[],
  replacementPoints: readonly Point[],
): NativeElementDraft[] => {
  const source = strokes[0];

  if (!source || replacementPoints.length === 0) {
    return [];
  }

  const bounds = getPointBounds(replacementPoints);

  return [{
    kind: 'rectangle',
    sourceIds: strokes.map((stroke) => stroke.sourceId),
    bounds: {
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    },
    style: getStyle(source),
  }];
};

export const applyElementSet = <TElement extends CanvasElement>(
  elements: readonly TElement[],
  sourceIds: readonly string[],
  nativeElements: readonly TElement[],
  bumpDeleted: (element: TElement) => TElement,
): TElement[] => {
  const sourceIdSet = new Set(sourceIds);
  const nextElements = removePreviewElements(elements).map((element) => {
    return sourceIdSet.has(element.id) ? bumpDeleted(element) : element;
  });

  return [...nextElements, ...nativeElements];
};

export const sceneSignature = (elements: readonly CanvasElement[]): string => {
  return removePreviewElements(elements)
    .map((element) => `${element.id}:${element.version}:${element.isDeleted ? 1 : 0}`)
    .join('|');
};

export const getPointBounds = (points: readonly Point[]) => {
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
};

const getStyle = (stroke: DrawitStroke) => ({
  color: stroke.color,
  width: stroke.width,
  opacity: stroke.opacity,
});
