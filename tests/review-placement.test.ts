import { describe, expect, it } from 'vitest';
import { placeReviewBar } from '../src/ui/review-placement';

const canvas = { width: 1000, height: 700 };
const bar = { width: 400, height: 60 };
const insets = { top: 72, right: 12, bottom: 80, left: 12 };

describe('review bar placement', () => {
  it('centres the bar just below the suggestion when there is room', () => {
    expect(placeReviewBar({ x: 300, y: 200, width: 200, height: 100 }, canvas, bar, insets))
      .toEqual({ top: 312, left: 200, side: 'below' });
  });

  it('moves above the suggestion when it would cover the bottom inset', () => {
    expect(placeReviewBar({ x: 300, y: 450, width: 200, height: 100 }, canvas, bar, insets))
      .toEqual({ top: 378, left: 200, side: 'above' });
  });

  it('falls back to the bottom when the suggestion fills the canvas', () => {
    expect(placeReviewBar({ x: 100, y: 60, width: 800, height: 560 }, canvas, bar, insets))
      .toEqual({ top: 560, left: 300, side: 'bottom' });
  });

  it('keeps the bar inside the insets', () => {
    expect(placeReviewBar({ x: -50, y: 100, width: 100, height: 50 }, canvas, bar, insets).left)
      .toBe(12);
    expect(placeReviewBar({ x: 950, y: 100, width: 100, height: 50 }, canvas, bar, insets).left)
      .toBe(588);
    expect(placeReviewBar({ x: 0, y: 0, width: 100, height: 20 }, canvas, bar, insets).top)
      .toBe(72);
    expect(placeReviewBar(
      { x: 0, y: 0, width: 100, height: 50 },
      { width: 300, height: 150 },
      bar,
      insets,
    )).toEqual({ top: 72, left: 12, side: 'below' });
  });

  it('centres the bar at the bottom when the suggestion is off screen', () => {
    const bottom = { top: 560, left: 300, side: 'bottom' };

    expect(placeReviewBar(undefined, canvas, bar, insets)).toEqual(bottom);
    expect(placeReviewBar({ x: 1200, y: 100, width: 50, height: 50 }, canvas, bar, insets))
      .toEqual(bottom);
    expect(placeReviewBar({ x: 100, y: -300, width: 50, height: 50 }, canvas, bar, insets))
      .toEqual(bottom);
  });
});
