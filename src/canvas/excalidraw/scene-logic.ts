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
): TElement => {
  return {
    ...element,
    strokeStyle: 'dashed',
    locked: true,
    customData: {
      ...element.customData,
      drawit: 'preview',
      sourceIds: [...sourceIds],
    },
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
