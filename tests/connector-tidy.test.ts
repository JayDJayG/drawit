import { describe, expect, it } from 'vitest';
import {
  tidyConnectorAxis,
  tidyConnectorPath,
  type ConnectorAxisBounds,
} from '../src/core/geometry';
import type { SuggestionPoint } from '../src/core/suggestions';

const point = (x: number, y: number): SuggestionPoint => ({ x, y });

const rectangle = (
  x: number,
  y: number,
  width: number,
  height: number,
): ConnectorAxisBounds['start'] => ({
  kind: 'rectangle',
  bounds: { x, y, width, height },
});

const assertIdempotent = (
  points: readonly SuggestionPoint[],
  samples = points,
  bounds: ConnectorAxisBounds = {},
) => {
  const path = tidyConnectorPath(points);
  expect(tidyConnectorPath(path)).toEqual(path);
  const axis = tidyConnectorAxis(path, samples, bounds);
  expect(tidyConnectorAxis(axis, samples, bounds)).toEqual(axis);
};

describe('connector tidy geometry', () => {
  it('deduplicates consecutive points while preserving both endpoints', () => {
    const input = [point(0, 0), point(0.2, 0), point(0.7, 0), point(5, 0)];
    expect(tidyConnectorPath(input)).toEqual([
      point(0, 0),
      point(0.7, 0),
      point(5, 0),
    ]);
    assertIdempotent(input);
  });

  it('leaves a short chord unchanged after deduplication', () => {
    const input = [point(0, 0), point(2, 1), point(4, 0), point(10, 2)];
    expect(tidyConnectorPath(input)).toEqual(input);
    assertIdempotent(input);
  });

  it('collapses a mostly straight path to its exact endpoints', () => {
    const input = [
      point(0, 0),
      point(20, 2),
      point(40, -2),
      point(60, 1),
      point(100, 0),
    ];
    expect(tidyConnectorPath(input)).toEqual([point(0, 0), point(100, 0)]);
    assertIdempotent(input);
  });

  it('keeps an L shape as three points and snaps each segment to its axis', () => {
    const input = [point(0, 0), point(50, 0), point(50, 50)];
    expect(tidyConnectorPath(input)).toEqual(input);
    expect(tidyConnectorAxis(input)).toEqual(input);
    assertIdempotent(input);
  });

  it('collapses a clean 30 degree diagonal without changing its direction', () => {
    const input = [
      point(0, 0),
      point(20, 11.547),
      point(40, 23.094),
      point(80, 46.188),
    ];
    expect(tidyConnectorPath(input)).toEqual([input[0], input.at(-1)]);
    assertIdempotent(input);
  });

  it('does not collapse a semicircle and keeps a compact outline', () => {
    const input = [
      point(-100, 0),
      point(-70, 70),
      point(0, 100),
      point(70, 70),
      point(100, 0),
    ];
    const output = tidyConnectorPath(input);
    expect(output.length).toBeGreaterThanOrEqual(5);
    expect(output.length).toBeLessThanOrEqual(8);
    expect(output[0]).toEqual(input[0]);
    expect(output.at(-1)).toEqual(input.at(-1));
    assertIdempotent(input);
  });

  it('removes a sharp reversal spike', () => {
    const input = [
      point(0, 0),
      point(40, 0),
      point(0, 0),
      point(70, 50),
    ];
    const output = tidyConnectorPath(input);
    expect(output).toHaveLength(2);
    expect(output[0]).toEqual(input[0]);
    expect(output.at(-1)).toEqual(input.at(-1));
    assertIdempotent(input);
  });

  it('caps a noisy zigzag at eight points', () => {
    const input = Array.from({ length: 25 }, (_, index) => point(
      index * 10,
      index % 2 === 0 ? 0 : 24,
    ));
    const output = tidyConnectorPath(input);
    expect(output.length).toBeLessThanOrEqual(8);
    expect(output[0]).toEqual(input[0]);
    expect(output.at(-1)).toEqual(input.at(-1));
    assertIdempotent(input);
  });

  it('removes interior points that finish within the dedupe threshold', () => {
    const input = [point(0, 0), point(10, 0), point(10.2, 0)];
    const output = tidyConnectorPath(input);
    expect(output).toEqual([input[0], input.at(-1)]);
    expect(output.every((current, index) => {
      const previous = output[index - 1];
      return !previous || Math.hypot(current.x - previous.x, current.y - previous.y) >= 0.5;
    })).toBe(true);
    assertIdempotent(input);
  });

  it('uses the sample median for a two-point horizontal connector', () => {
    const input = [point(0, 10), point(100, 12)];
    const samples = [point(0, 8), point(50, 11), point(100, 12)];
    expect(tidyConnectorAxis(input, samples)).toEqual([
      point(0, 11),
      point(100, 11),
    ]);
    assertIdempotent(input, samples);
  });

  it('skips multi-segment snapping when shared demands conflict', () => {
    const input = [point(0, 0), point(50, 0), point(100, 5)];
    expect(tidyConnectorAxis(input)).toEqual(input);
    assertIdempotent(input);
  });

  it('skips axis snapping when a bound span excludes the snapped end', () => {
    const input = [point(0, 0), point(100, 0)];
    const bounds = {
      start: rectangle(0, 0, 20, 10),
    };
    expect(tidyConnectorAxis(input, input, bounds)).toEqual(input);
    assertIdempotent(input, input, bounds);
  });

  it('skips a hook whose adjacent vertex is inside the bound node', () => {
    const input = [point(200, 50), point(50, 50), point(0, 50)];
    const bounds = { end: rectangle(0, 0, 100, 100) };
    expect(tidyConnectorAxis(input, input, bounds)).toEqual(input);
    assertIdempotent(input, input, bounds);
  });

  it('skips a corner-near snapped end with the twenty-percent span margin', () => {
    const input = [point(200, 0), point(100, 0)];
    const samples = [point(200, 15), point(100, 15)];
    const bounds = { end: rectangle(0, 0, 100, 100) };
    expect(tidyConnectorAxis(input, samples, bounds)).toEqual(input);
    assertIdempotent(input, samples, bounds);
  });

  it('guards diamond attachment when snapping would move beyond the binding gap', () => {
    const input = [point(0, 40), point(95, 40)];
    const samples = [point(0, 20), point(95, 20)];
    const bounds = {
      end: {
        kind: 'diamond' as const,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      },
    };
    expect(tidyConnectorAxis(input, samples, bounds)).toEqual(input);
    assertIdempotent(input, samples, bounds);
  });

  it('keeps a moderate diamond attachment within the binding gap', () => {
    const input = [point(0, 40), point(95, 40)];
    const samples = [point(0, 30), point(95, 30)];
    const bounds = {
      end: {
        kind: 'diamond' as const,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      },
    };
    expect(tidyConnectorAxis(input, samples, bounds)).toEqual([
      point(0, 30),
      point(95, 30),
    ]);
    assertIdempotent(input, samples, bounds);
  });

  it('fits a far-side start onto the facing rectangle edge', () => {
    const input = [point(50, 100), point(50, -50)];
    const bounds = { start: rectangle(0, 0, 100, 100) };
    expect(tidyConnectorAxis(input, input, bounds)).toEqual([
      point(50, 0),
      point(50, -50),
    ]);
    assertIdempotent(input, input, bounds);
  });

  it('snaps an interior aligned segment without moving diagonal ends', () => {
    const input = [
      point(0, 0),
      point(50, 29),
      point(100, 31),
      point(150, 80),
    ];
    expect(tidyConnectorAxis(input)).toEqual([
      point(0, 0),
      point(50, 30),
      point(100, 30),
      point(150, 80),
    ]);
    assertIdempotent(input);
  });

  it.each([
    ['rectangle', rectangle(0, 0, 100, 40), point(50, 20), point(150, 20), point(100, 20)],
    ['ellipse', {
      kind: 'ellipse' as const,
      bounds: { x: 0, y: 0, width: 100, height: 40 },
    }, point(50, 20), point(150, 20), point(100, 20)],
    ['diamond', {
      kind: 'diamond' as const,
      bounds: { x: 0, y: 0, width: 100, height: 40 },
    }, point(50, 20), point(150, 20), point(100, 20)],
  ])('fits an inside endpoint onto a %s outline', (
    _kind,
    node,
    start,
    end,
    fittedStart,
  ) => {
    const input = [start, end];
    const output = tidyConnectorAxis(input, input, { start: node });
    expect(output).toEqual([fittedStart, end]);
    assertIdempotent(input, input, { start: node });
  });
});
