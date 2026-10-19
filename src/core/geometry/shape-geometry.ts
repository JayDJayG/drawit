import type {
  SuggestionBounds,
  SuggestionPoint,
  ShapeSuggestionItem,
} from '../suggestions';

export type ShapeGeometryKind = ShapeSuggestionItem['shape'];

export const maxBindingGap = (
  kind: ShapeGeometryKind,
  bounds: SuggestionBounds,
): number => {
  const shapeRatio = kind === 'diamond' ? 1 / Math.sqrt(2) : 1;
  return Math.max(
    16,
    Math.min(0.25 * shapeRatio * Math.min(bounds.width, bounds.height), 32),
  );
};

export const projectToShapeOutline = (
  point: SuggestionPoint,
  neighbor: SuggestionPoint | undefined,
  kind: ShapeGeometryKind,
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

export const distanceToShapeOutline = (
  point: SuggestionPoint,
  kind: ShapeGeometryKind,
  bounds: SuggestionBounds,
): number => {
  return distance(point, projectToShapeOutline(point, undefined, kind, bounds));
};

export const pointInsideShape = (
  point: SuggestionPoint,
  kind: ShapeGeometryKind,
  bounds: SuggestionBounds,
): boolean => {
  const center = boundsCenter(bounds);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const halfWidth = Math.max(0.5, bounds.width / 2);
  const halfHeight = Math.max(0.5, bounds.height / 2);
  if (kind === 'ellipse') {
    return (dx / halfWidth) ** 2 + (dy / halfHeight) ** 2 <= 1;
  }
  if (kind === 'diamond') {
    return Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight <= 1;
  }
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
};

export const axisOutlineCrossing = (
  point: SuggestionPoint,
  axis: 'horizontal' | 'vertical',
  direction: -1 | 1,
  kind: ShapeGeometryKind,
  bounds: SuggestionBounds,
): SuggestionPoint | undefined => {
  const center = boundsCenter(bounds);
  const halfWidth = Math.max(0.5, bounds.width / 2);
  const halfHeight = Math.max(0.5, bounds.height / 2);
  if (axis === 'horizontal') {
    const normalized = (point.y - center.y) / halfHeight;
    if (kind === 'ellipse') {
      if (Math.abs(normalized) > 1) {
        return undefined;
      }
      return {
        x: center.x + direction * halfWidth * Math.sqrt(Math.max(0, 1 - normalized ** 2)),
        y: point.y,
      };
    }
    if (kind === 'diamond') {
      if (Math.abs(normalized) > 1) {
        return undefined;
      }
      return {
        x: center.x + direction * halfWidth * Math.max(0, 1 - Math.abs(normalized)),
        y: point.y,
      };
    }
    return {
      x: direction < 0 ? bounds.x : bounds.x + bounds.width,
      y: point.y,
    };
  }

  const normalized = (point.x - center.x) / halfWidth;
  if (kind === 'ellipse') {
    if (Math.abs(normalized) > 1) {
      return undefined;
    }
    return {
      x: point.x,
      y: center.y + direction * halfHeight * Math.sqrt(Math.max(0, 1 - normalized ** 2)),
    };
  }
  if (kind === 'diamond') {
    if (Math.abs(normalized) > 1) {
      return undefined;
    }
    return {
      x: point.x,
      y: center.y + direction * halfHeight * Math.max(0, 1 - Math.abs(normalized)),
    };
  }
  return {
    x: point.x,
    y: direction < 0 ? bounds.y : bounds.y + bounds.height,
  };
};

export const boundsCenter = (bounds: SuggestionBounds): SuggestionPoint => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

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
  const a = dx * dx + dy * dy;
  const b = -2 * (dx * cornerX + dy * cornerY);
  const c = cornerX * cornerX + cornerY * cornerY - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0 || a === 0) {
    return rectangleScale;
  }
  const root = (-b + Math.sqrt(discriminant)) / (2 * a);
  return root > 0 ? root : rectangleScale;
};

const distance = (
  first: SuggestionPoint,
  second: SuggestionPoint,
): number => Math.hypot(first.x - second.x, first.y - second.y);
