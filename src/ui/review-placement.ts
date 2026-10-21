export type Size = {
  width: number;
  height: number;
};

export type Rect = Size & {
  x: number;
  y: number;
};

export type Insets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type ReviewBarPlacement = {
  top: number;
  left: number;
  side: 'below' | 'above' | 'bottom';
};

const intersects = (rect: Rect, container: Size): boolean => {
  return rect.x < container.width
    && rect.y < container.height
    && rect.x + rect.width > 0
    && rect.y + rect.height > 0;
};

/**
 * Places the review bar next to the suggestion it controls: below it when
 * there is room, otherwise above it, otherwise at the bottom of the canvas.
 * The bar always stays inside the canvas, clear of the given insets.
 */
export const placeReviewBar = (
  anchor: Rect | undefined,
  container: Size,
  bar: Size,
  insets: Insets,
  gap = 12,
): ReviewBarPlacement => {
  const minTop = insets.top;
  const maxTop = Math.max(minTop, container.height - insets.bottom - bar.height);
  const minLeft = insets.left;
  const maxLeft = Math.max(minLeft, container.width - insets.right - bar.width);
  const clampLeft = (left: number) => Math.min(Math.max(left, minLeft), maxLeft);

  if (!anchor || !intersects(anchor, container)) {
    return {
      top: maxTop,
      left: clampLeft((container.width - bar.width) / 2),
      side: 'bottom',
    };
  }

  const left = clampLeft(anchor.x + anchor.width / 2 - bar.width / 2);
  const below = anchor.y + anchor.height + gap;
  if (below <= maxTop) {
    return { top: Math.max(below, minTop), left, side: 'below' };
  }
  const above = anchor.y - gap - bar.height;
  if (above >= minTop) {
    return { top: Math.min(above, maxTop), left, side: 'above' };
  }
  return { top: maxTop, left, side: 'bottom' };
};
