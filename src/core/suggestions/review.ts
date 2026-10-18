import type { SuggestionPoint } from './types';

export type PreviewHitTarget = {
  itemId: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  points?: readonly SuggestionPoint[];
};

export const hitTestPreviewItems = (
  items: readonly PreviewHitTarget[],
  point: SuggestionPoint,
  tolerance = 8,
): string | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (item.points && item.points.length > 1) {
      if (distanceToPolyline(point, item.points) <= tolerance) {
        return item.itemId;
      }
    }
    const bounds = item.bounds;
    if (
      point.x >= bounds.x - tolerance
      && point.x <= bounds.x + bounds.width + tolerance
      && point.y >= bounds.y - tolerance
      && point.y <= bounds.y + bounds.height + tolerance
    ) {
      return item.itemId;
    }
  }
  return undefined;
};

const distanceToPolyline = (
  point: SuggestionPoint,
  points: readonly SuggestionPoint[],
): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    minimum = Math.min(minimum, distanceToSegment(point, start, end));
  }
  return minimum;
};

const distanceToSegment = (
  point: SuggestionPoint,
  start: SuggestionPoint,
  end: SuggestionPoint,
): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(
    point.x - (start.x + t * dx),
    point.y - (start.y + t * dy),
  );
};
