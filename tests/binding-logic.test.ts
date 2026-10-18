import { describe, expect, it, vi } from 'vitest';
vi.mock('open-color/open-color.json', () => ({}));
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: {
    NEVER: 'NEVER',
    IMMEDIATELY: 'IMMEDIATELY',
  },
  ROUNDNESS: {
    PROPORTIONAL_RADIUS: 'proportional-radius',
  },
  convertToExcalidrawElements: (skeletons: readonly Record<string, unknown>[]) => (
    skeletons.map((skeleton) => ({
      ...skeleton,
      boundElements: null,
      isDeleted: false,
      version: 1,
    }))
  ),
  exportToSvg: vi.fn(),
  newElementWith: (element: Record<string, unknown>, changes: Record<string, unknown>) => ({
    ...element,
    ...changes,
  }),
  viewportCoordsToSceneCoords: vi.fn(),
}));
import { CanvasAdapter } from '../src/canvas/excalidraw/CanvasAdapter';
import {
  bindArrowEndpoint,
  calculateBinding,
  determineFocusPoint,
  stabilizeBinding,
  synchronizeBindingMutuality,
  updateBoundPoint,
  type BindingElement,
  type BindingGeometry,
} from '../src/canvas/excalidraw/binding-logic';
import { recognizeDiagram } from '../src/perception/t0';
import type { SuggestionPlan } from '../src/core/suggestions';

type AdapterTestElement = {
  id: string;
  type: string;
  x?: number;
  y?: number;
  points?: readonly [number, number][];
  isDeleted?: boolean;
  customData?: { planItemId?: string };
  boundElements?: readonly { id: string; type: string }[] | null;
  startBinding?: AdapterBinding | null;
  endBinding?: AdapterBinding | null;
  [key: string]: unknown;
};

type AdapterBinding = {
  elementId: string;
  focus: number;
  gap: number;
};

const distance = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) => Math.hypot(first.x - second.x, first.y - second.y);

const angleVector = (angle: number) => ({
  x: Math.cos(angle),
  y: Math.sin(angle),
});

const outlineRadius = (
  target: BindingGeometry,
  direction: { x: number; y: number },
): number => {
  const halfWidth = target.width / 2;
  const halfHeight = target.height / 2;
  const dx = Math.abs(direction.x);
  const dy = Math.abs(direction.y);
  if (target.type === 'ellipse') {
    return 1 / Math.sqrt((direction.x / halfWidth) ** 2 + (direction.y / halfHeight) ** 2);
  }
  if (target.type === 'diamond') {
    return 1 / (dx / halfWidth + dy / halfHeight);
  }
  return Math.min(
    dx > 0 ? halfWidth / dx : Number.POSITIVE_INFINITY,
    dy > 0 ? halfHeight / dy : Number.POSITIVE_INFINITY,
  );
};

const generatedAdapterCases = () => {
  const cases: Array<{
    target: BindingGeometry;
    endpoint: 'start' | 'end';
    points: readonly [number, number][];
    origin: { x: number; y: number };
    outside: number;
    angle: number;
  }> = [];
  const shapeKinds = [
    { type: 'diamond', roundness: undefined },
    { type: 'rectangle', roundness: null },
    { type: 'rectangle', roundness: { type: 'proportional-radius' } },
    { type: 'ellipse', roundness: undefined },
  ] as const;
  const outsideValues = [0, 4, 8];
  const approachAngles = [-30, 0, 30].map((degrees) => degrees * Math.PI / 180);
  let index = 0;
  for (const shape of shapeKinds) {
    for (let directionIndex = 0; directionIndex < 8; directionIndex += 1) {
      const angle = directionIndex * Math.PI / 4;
      const direction = angleVector(angle);
      const perpendicular = { x: -direction.y, y: direction.x };
      const target = {
        id: `target-${index}`,
        type: shape.type,
        x: 100,
        y: 100,
        width: 120,
        height: 80,
        roundness: shape.roundness,
      };
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const radius = outlineRadius(target, direction);
      for (const outside of outsideValues) {
        for (const approachAngle of approachAngles) {
          const offAxis = 4;
          const endpoint = {
            x: center.x + direction.x * (radius + outside) + perpendicular.x * offAxis,
            y: center.y + direction.y * (radius + outside) + perpendicular.y * offAxis,
          };
          const approach = angleVector(angle + approachAngle);
          const adjacent = {
            x: endpoint.x + approach.x * 32,
            y: endpoint.y + approach.y * 32,
          };
          const previous = {
            x: adjacent.x + perpendicular.x * 18,
            y: adjacent.y + perpendicular.y * 18,
          };
          for (const endpointKind of ['start', 'end'] as const) {
            const absolutePoints = endpointKind === 'end'
              ? [previous, adjacent, endpoint]
              : [endpoint, adjacent, previous];
            const origin = absolutePoints[0]!;
            cases.push({
              target,
              endpoint: endpointKind,
              points: absolutePoints.map((point) => [
                point.x - origin.x,
                point.y - origin.y,
              ] as [number, number]),
              origin,
              outside,
              angle,
            });
            index += 1;
          }
        }
      }
    }
  }
  return cases;
};

const roundTrip = (
  target: BindingGeometry,
  points: readonly [number, number][],
  endpoint: 'start' | 'end',
) => {
  const arrow = { x: 0, y: 0, points };
  const binding = calculateBinding(arrow, target, endpoint);
  const boundArrow = {
    ...arrow,
    ...(endpoint === 'start' ? { startBinding: binding } : { endBinding: binding }),
  };
  const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
  const edge = points[edgeIndex]!;
  const recomputed = updateBoundPoint(boundArrow, target, endpoint);
  const focusPoint = determineFocusPoint(
    target,
    binding.focus,
    endpoint === 'start'
      ? { x: points[1]![0], y: points[1]![1] }
      : { x: points[points.length - 2]![0], y: points[points.length - 2]![1] },
  );
  return {
    binding,
    edge: { x: edge[0], y: edge[1] },
    focusPoint,
    recomputed,
  };
};

describe('Excalidraw 0.18.1 binding geometry port', () => {
  it('round-trips off-centre and multi-point bindings for rectangles, diamonds, and ellipses', () => {
    const cases: Array<{
      target: BindingGeometry;
      points: readonly [number, number][];
      endpoint: 'start' | 'end';
    }> = [
      {
        target: { id: 'rectangle', type: 'rectangle', x: 100, y: 100, width: 120, height: 80 },
        points: [[100, 125], [40, 125], [25, 155]],
        endpoint: 'start',
      },
      {
        target: { id: 'diamond', type: 'diamond', x: 100, y: 100, width: 120, height: 80 },
        points: [[40, 140], [70, 140], [100, 140]],
        endpoint: 'end',
      },
      {
        target: { id: 'ellipse', type: 'ellipse', x: 100, y: 100, width: 120, height: 80 },
        points: [[100, 140], [70, 140], [35, 210]],
        endpoint: 'start',
      },
    ];

    for (const testCase of cases) {
      const result = roundTrip(testCase.target, testCase.points, testCase.endpoint);
      expect(Math.abs(result.binding.focus)).toBeLessThanOrEqual(1);
      expect(result.binding.gap).toBeGreaterThanOrEqual(1);
      expect(distance(result.edge, result.recomputed), testCase.target.id).toBeLessThanOrEqual(1.01);
    }
  });

  it('uses the edge-through-shape ray direction for off-centre focus points', () => {
    const target: BindingGeometry = {
      id: 'existing-rectangle',
      type: 'rectangle',
      x: 200,
      y: 120,
      width: 140,
      height: 90,
    };
    const adjacent = { x: 150, y: 145 };
    const edge = { x: 200, y: 145 };
    const binding = calculateBinding({
      x: 0,
      y: 0,
      points: [[150, 145], [200, 145]],
    }, target, 'end');
    const focusPoint = determineFocusPoint(target, binding.focus, adjacent);

    expect(Math.abs(binding.focus)).toBeLessThanOrEqual(1);
    expect(focusPoint.x).toBeGreaterThan(target.x);
  });

  it.each([
    {
      name: 'hook into the left diamond vertex',
      target: { id: 'decision', type: 'diamond', x: 712.89, y: 194.1, width: 153.54, height: 113.82 },
      arrow: {
        x: 624.8,
        y: 249.8,
        points: [[0, 0], [84.28, 0.3]] as readonly [number, number][],
      },
      endpoint: 'end' as const,
    },
    {
      name: 'V out of the bottom diamond vertex',
      target: { id: 'decision', type: 'diamond', x: 712.89, y: 194.1, width: 153.54, height: 113.82 },
      arrow: {
        x: 791.4,
        y: 310.64,
        points: [[0, 0], [-3.4, 82.86], [-3.3, 116.76]] as readonly [number, number][],
      },
      endpoint: 'start' as const,
    },
  ])('converges vertex bindings without dropping them: $name', ({ target, arrow, endpoint }) => {
    const result = stabilizeBinding(arrow, target, endpoint);
    expect(result.binding).not.toBeNull();
    expect(result.movement).toBeLessThanOrEqual(0.5);
    expect(result.points).toHaveLength(arrow.points.length);
  });

  it.each(generatedAdapterCases())(
    'keeps generated $target.type $endpoint binding at angle $angle outside=$outside',
    ({ target, endpoint, points, origin, outside }) => {
      const arrow: BindingElement = {
        id: `arrow-${target.id}-${endpoint}-${outside}`,
        type: 'arrow',
        x: origin.x,
        y: origin.y,
        points,
        boundElements: null,
      };
      const bound = bindArrowEndpoint(arrow, target, endpoint);
      const binding = endpoint === 'start' ? bound.startBinding : bound.endBinding;
      expect(binding).not.toBeNull();
      expect(binding?.elementId).toBe(target.id);
      expect(binding?.gap).toBeGreaterThanOrEqual(1);
      const elements = synchronizeBindingMutuality([
        targetElement(target),
        bound,
      ]);
      const liveTarget = elements.find((element) => element.id === target.id)!;
      expect(liveTarget.boundElements).toContainEqual({
        id: arrow.id,
        type: 'arrow',
      });
      const boundPoints = bound.points ?? [];
      const edgeIndex = endpoint === 'start' ? 0 : boundPoints.length - 1;
      const adjacentIndex = endpoint === 'start' ? 1 : boundPoints.length - 2;
      const edgePoint = boundPoints[edgeIndex]!;
      const adjacentPoint = boundPoints[adjacentIndex]!;
      const edge = {
        x: bound.x + edgePoint[0],
        y: bound.y + edgePoint[1],
      };
      const adjacent = {
        x: bound.x + adjacentPoint[0],
        y: bound.y + adjacentPoint[1],
      };
      const center = {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      };
      const radial = {
        x: edge.x - center.x,
        y: edge.y - center.y,
      };
      const length = Math.hypot(radial.x, radial.y);
      const direction = { x: radial.x / length, y: radial.y / length };
      const radialGap = length - outlineRadius(target, direction);
      expect(radialGap).toBeGreaterThanOrEqual(-0.5);
      expect(radialGap).toBeLessThanOrEqual(6.5);
      expect(distance(edge, adjacent)).toBeGreaterThanOrEqual(10);
      const roundTrip = updateBoundPoint(
        bound,
        target,
        endpoint,
      );
      expect(distance(edge, roundTrip)).toBeLessThanOrEqual(0.5);
    },
  );

  it('keeps the reviewer vertex strokes bound through CanvasAdapter conversion', () => {
    const plan = recognizeDiagram({
      strokes: [
        {
          id: 'source',
          points: [
            { x: 470, y: 215 },
            { x: 625, y: 215 },
            { x: 625, y: 285 },
            { x: 470, y: 285 },
            { x: 470, y: 215 },
          ],
        },
        {
          id: 'decision',
          points: [
            { x: 790, y: 193 },
            { x: 867, y: 250 },
            { x: 790, y: 307 },
            { x: 713, y: 250 },
            { x: 790, y: 193 },
          ],
        },
        {
          id: 'destination',
          points: [
            { x: 739, y: 428 },
            { x: 901, y: 428 },
            { x: 901, y: 513 },
            { x: 739, y: 513 },
            { x: 739, y: 428 },
          ],
        },
        {
          id: 'hook-a',
          points: [
            { x: 624.3, y: 250.3 },
            { x: 628.3, y: 249.7 },
            { x: 631.9, y: 249.8 },
            { x: 640, y: 250.7 },
            { x: 656.7, y: 250.9 },
            { x: 672, y: 250.5 },
            { x: 688.4, y: 250.2 },
            { x: 704.6, y: 250.1 },
            { x: 709.6, y: 249.6 },
            { x: 704.6, y: 246.9 },
            { x: 700.8, y: 243.7 },
            { x: 697.2, y: 241 },
          ],
        },
        {
          id: 'v-b',
          points: [
            { x: 790.9, y: 310.1 },
            { x: 791.6, y: 315.5 },
            { x: 791.8, y: 320.6 },
            { x: 791.9, y: 325.6 },
            { x: 791.9, y: 331.1 },
            { x: 791.7, y: 336.3 },
            { x: 791.5, y: 341.4 },
            { x: 790.3, y: 347 },
            { x: 790.9, y: 352.1 },
            { x: 789.6, y: 357.5 },
            { x: 789.5, y: 362.2 },
            { x: 789.6, y: 367.2 },
            { x: 789.1, y: 372.4 },
            { x: 788.8, y: 377.8 },
            { x: 788.9, y: 383.3 },
            { x: 788.7, y: 388.4 },
            { x: 788, y: 393.5 },
            { x: 788.4, y: 398.2 },
            { x: 788.5, y: 403.3 },
            { x: 789.2, y: 409.3 },
            { x: 790, y: 414 },
            { x: 789.6, y: 419.7 },
            { x: 790.6, y: 424.4 },
            { x: 790.4, y: 430.3 },
            { x: 787.9, y: 427.3 },
            { x: 785.7, y: 425.7 },
            { x: 783.5, y: 423.1 },
            { x: 782.3, y: 420.6 },
            { x: 780.4, y: 417.8 },
            { x: 785.6, y: 420.5 },
            { x: 787.6, y: 425.8 },
            { x: 790.7, y: 429.9 },
            { x: 790.7, y: 427.6 },
            { x: 792.9, y: 425.2 },
            { x: 795.4, y: 423.1 },
            { x: 797.6, y: 420.3 },
            { x: 795.4, y: 423.1 },
            { x: 799.1, y: 417.7 },
          ],
        },
      ],
      texts: [],
    });
    const connectors = plan.items.filter((item) => item.kind === 'connector');
    expect(connectors).toHaveLength(2);

    let scene: readonly AdapterTestElement[] = [];
    const api = {
      setActiveTool: () => undefined,
      getSceneElementsIncludingDeleted: () => scene,
      getAppState: () => ({ selectedElementIds: {} }),
      getFiles: () => ({}),
      updateScene: ({ elements }: { elements: readonly AdapterTestElement[] }) => {
        scene = elements;
      },
    } as never;
    const adapter = new CanvasAdapter(api);
    const adapterInternals = adapter as unknown as {
      showPlan: (
        nextPlan: SuggestionPlan,
        currentElements: readonly never[],
      ) => void;
    };
    adapterInternals.showPlan(plan, []);

    const live = scene.filter((element) => element.isDeleted !== true);
    const byPlanId = new Map<string, AdapterTestElement>(
      live.flatMap((element): [string, AdapterTestElement][] => {
        const planItemId = element.customData?.planItemId;
        return typeof planItemId === 'string' ? [[planItemId, element]] : [];
      }),
    );
    const arrows = live.filter((element) => element.type === 'arrow');
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) {
      const points = arrow.points as readonly [number, number][];
      for (const endpoint of ['start', 'end'] as const) {
        const binding = arrow[`${endpoint}Binding`] as {
          elementId: string;
          focus: number;
          gap: number;
        } | null | undefined;
        if (!binding) {
          continue;
        }
        expect(binding.gap).toBeGreaterThanOrEqual(1);
        expect(Math.abs(binding.focus)).toBeLessThanOrEqual(1);
        const target = live.find((element) => element.id === binding.elementId)!;
        expect(target.boundElements).toContainEqual({ id: arrow.id, type: 'arrow' });
        const edgeIndex = endpoint === 'start' ? 0 : points.length - 1;
        const edge = points[edgeIndex]!;
        const adjacent = endpoint === 'start'
          ? points[1]!
          : points[points.length - 2]!;
        const recomputed = updateBoundPoint(
          {
            ...arrow,
            points,
            x: arrow.x as number,
            y: arrow.y as number,
          },
          target as unknown as BindingGeometry,
          endpoint,
        );
        expect(distance(
          { x: (arrow.x as number) + edge[0], y: (arrow.y as number) + edge[1] },
          recomputed,
        )).toBeLessThanOrEqual(0.5);
        expect(distance(
          { x: (arrow.x as number) + adjacent[0], y: (arrow.y as number) + adjacent[1] },
          recomputed,
        )).toBeGreaterThanOrEqual(10);
      }
    }

    for (const connector of connectors) {
      const converted = byPlanId.get(connector.id);
      expect(converted).toBeDefined();
      if (!converted || converted.type !== 'arrow') {
        continue;
      }
      for (const endpoint of ['start', 'end'] as const) {
        const ref = connector[endpoint];
        if (!ref || !('itemId' in ref)) {
          continue;
        }
        const target = byPlanId.get(ref.itemId);
        const binding = converted[`${endpoint}Binding`] as { elementId?: string } | null | undefined;
        if (binding) {
          expect(binding.elementId).toBe(target?.id);
        }
      }
    }
    const hook = connectors.find((item) => item.sourceIds.includes('hook-a'));
    const vertexExit = connectors.find((item) => item.sourceIds.includes('v-b'));
    expect(hook).toBeDefined();
    expect(vertexExit).toBeDefined();
    if (hook?.end && 'itemId' in hook.end && vertexExit?.start && 'itemId' in vertexExit.start) {
      const decision = byPlanId.get(hook.end.itemId);
      const hookElement = byPlanId.get(hook.id);
      const exitElement = byPlanId.get(vertexExit.id);
      expect((hookElement?.endBinding as { elementId?: string } | undefined)?.elementId)
        .toBe(decision?.id);
      expect((exitElement?.startBinding as { elementId?: string } | undefined)?.elementId)
        .toBe(decision?.id);
    }
  });

  it('removes one-sided arrow references while preserving mutual bindings', () => {
    const target: BindingGeometry = {
      id: 'target',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 120,
      height: 80,
    };
    const arrow = {
      id: 'arrow',
      type: 'arrow',
      x: 0,
      y: 140,
      points: [[0, 0], [100, 0]] as readonly [number, number][],
      boundElements: null,
    };
    const bound = bindArrowEndpoint(arrow, target, 'end');
    const elements = synchronizeBindingMutuality([
      {
        ...targetElement(target),
        boundElements: [
          { id: 'arrow', type: 'arrow' },
          { id: 'stale', type: 'arrow' },
          { id: 'label', type: 'text' },
        ],
      },
      { ...bound, endBinding: null },
    ]);
    const liveTarget = elements.find((element) => element.id === target.id)!;
    expect(liveTarget.boundElements).toEqual([{ id: 'label', type: 'text' }]);
  });
});

const targetElement = (target: BindingGeometry) => ({
  ...target,
  x: target.x,
  y: target.y,
  isDeleted: false,
  boundElements: null,
});
