import { describe, expect, it } from 'vitest';
import {
  createInterpretController,
  type InterpretClientController,
  type InterpretClientTransport,
} from '../src/dev/interpret-client';
import type {
  ModelInput,
  ModelSceneSnapshot,
} from '../src/canvas/excalidraw/types';
import type { CanvasAdapter } from '../src/canvas/excalidraw/CanvasAdapter';
import {
  formatSuggestionPreviewStatus,
  type SuggestionPlan,
} from '../src/core/suggestions';
import type { InterpretStatusResponse } from '../src/dev/interpret-client';
import { DEFAULT_INTERPRET_LIMITS } from '../src/perception/interpret';
import { validatePostedRequest } from '../dev-server/interpret/route';

const plan = {
  version: 1,
  lens: 'diagram',
  tier: 't2',
  items: [{
    id: 'shape-1',
    kind: 'shape',
    shape: 'rectangle',
    x: 0,
    y: 0,
    width: 80,
    height: 40,
    sourceIds: ['s1'],
    reason: 'The stroke is a box.',
  }],
  unresolved: [],
};

const status: InterpretStatusResponse = {
  configured: true,
  provider: 'deepseek',
  model: 'deepseek-flash',
  images: false,
  jsonMode: true,
};

class FakeAdapter {
  readonly input: ModelInput;
  readonly statuses: string[] = [];
  readonly shownPlans: unknown[] = [];
  readonly shownOptions: unknown[] = [];
  cancellationHandler?: (reason: 'escape' | 'superseded' | 'scene-changed') => void;
  dismissCount = 0;

  constructor(input?: ModelInput) {
    this.input = input ?? {
      input: {
        lens: 'diagram',
        strokes: [{ id: 'real-stroke', points: [{ x: 0, y: 0 }, { x: 80, y: 40 }] }],
        texts: [],
        t0Plan: null,
      },
      snapshot: {
        elementIds: ['real-element'],
        versions: { 'real-element': 1 },
      },
    };
  }

  getModelInput(): ModelInput {
    return this.input;
  }

  dismissPreview(): void {
    this.dismissCount += 1;
  }

  setModelStatus(message: string): void {
    this.statuses.push(message);
  }

  isModelSnapshotCurrent(_snapshot: ModelSceneSnapshot): boolean {
    return true;
  }

  showModelPlan(nextPlan: unknown, _snapshot?: unknown, options?: unknown): { shown: true } {
    this.shownPlans.push(nextPlan);
    this.shownOptions.push(options);
    return { shown: true };
  }

  setModelCancellationHandler(
    handler: ((reason: 'escape' | 'superseded' | 'scene-changed') => void) | undefined,
  ): void {
    this.cancellationHandler = handler;
  }

  triggerCancellation(reason: 'escape' | 'superseded' | 'scene-changed'): void {
    this.cancellationHandler?.(reason);
  }
}

const adapterAsCanvas = (adapter: FakeAdapter): CanvasAdapter => {
  return adapter as unknown as CanvasAdapter;
};

const waitFor = async (
  predicate: () => boolean,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) {
      throw new Error('Timed out waiting for the controller.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const deferredTransport = () => {
  const signals: AbortSignal[] = [];
  const requests: unknown[] = [];
  const resolvers: Array<(value: { ok: true; plan: unknown; model: string; latencyMs: number; usage: null }) => void> = [];
  const transport: InterpretClientTransport = {
    getStatus: async () => status,
    interpret: async (request, signal) => {
      requests.push(request);
      if (signal) {
        signals.push(signal);
      }
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  return { transport, signals, requests, resolvers };
};

const answer = () => ({
  ok: true as const,
  plan,
  model: 'deepseek-flash',
  latencyMs: 12,
  usage: null,
});

describe('development Interpret controller', () => {
  it('aborts the current request for scene cancellation and ignores its late answer', async () => {
    const adapter = new FakeAdapter();
    const { transport, signals, resolvers } = deferredTransport();
    const controller = createInterpretController(adapterAsCanvas(adapter), {
      transport,
    });
    const pending = controller.start();
    await waitFor(() => signals.length === 1);
    adapter.triggerCancellation('scene-changed');
    expect(signals[0]?.aborted).toBe(true);
    expect(controller.getState().busy).toBe(false);
    resolvers[0]?.(answer());
    await pending;
    expect(adapter.shownPlans).toHaveLength(0);
    expect(adapter.statuses.at(-1)).toContain('The drawing changed while Interpret was working');
  });

  it('supersedes an older Interpret request and only shows the current answer', async () => {
    const adapter = new FakeAdapter();
    const { transport, signals, resolvers } = deferredTransport();
    const controller: InterpretClientController = createInterpretController(
      adapterAsCanvas(adapter),
      { transport },
    );
    const first = controller.start();
    await waitFor(() => signals.length === 1);
    const second = controller.start();
    await waitFor(() => signals.length === 2);
    expect(signals[0]?.aborted).toBe(true);
    resolvers[0]?.(answer());
    resolvers[1]?.(answer());
    await Promise.all([first, second]);
    expect(adapter.shownPlans).toHaveLength(1);
    expect(controller.getState().busy).toBe(false);
  });

  it('lets Esc, Y and Shift+Y use the same cancellation owner', async () => {
    const adapter = new FakeAdapter();
    const { transport, signals, resolvers } = deferredTransport();
    const controller = createInterpretController(adapterAsCanvas(adapter), { transport });

    const first = controller.start();
    await waitFor(() => signals.length === 1);
    controller.cancel();
    expect(signals[0]?.aborted).toBe(true);
    resolvers[0]?.(answer());
    await first;

    const second = controller.start();
    await waitFor(() => signals.length === 2);
    adapter.triggerCancellation('scene-changed');
    expect(signals[1]?.aborted).toBe(true);
    resolvers[1]?.(answer());
    await second;

    const third = controller.start();
    await waitFor(() => signals.length === 3);
    adapter.triggerCancellation('scene-changed');
    expect(signals[2]?.aborted).toBe(true);
    resolvers[2]?.(answer());
    await third;
    expect(adapter.dismissCount).toBe(3);
  });

  it('uses fixed messages for escape, supersession and scene changes', async () => {
    const adapter = new FakeAdapter();
    const { transport, signals, resolvers } = deferredTransport();
    const controller = createInterpretController(adapterAsCanvas(adapter), { transport });

    const first = controller.start();
    await waitFor(() => signals.length === 1);
    adapter.triggerCancellation('escape');
    expect(adapter.statuses.at(-1)).toBe('Interpret cancelled.');
    resolvers[0]?.(answer());
    await first;

    const second = controller.start();
    await waitFor(() => signals.length === 2);
    const beforeSupersession = adapter.statuses.length;
    adapter.triggerCancellation('superseded');
    expect(adapter.statuses).toHaveLength(beforeSupersession);
    resolvers[1]?.(answer());
    await second;

    const third = controller.start();
    await waitFor(() => signals.length === 3);
    adapter.triggerCancellation('scene-changed');
    expect(adapter.statuses.at(-1)).toBe(
      'The drawing changed while Interpret was working. Press Interpret again.',
    );
    resolvers[2]?.(answer());
    await third;
  });

  it('caps the request before transport and drops an oversized T0 plan', async () => {
    const strokes = Array.from({ length: 128 }, (_, index) => ({
      id: `native-stroke-${index + 1}`,
      points: Array.from({ length: index === 0 ? 300 : 40 }, (_, point) => ({
        x: index * 2 + point,
        y: point,
      })),
    }));
    const t0Plan = {
      version: 1,
      lens: 'diagram',
      tier: 't0',
      items: Array.from({ length: 45 }, (_, index) => ({
        id: `native-item-${index + 1}`,
        kind: 'stroke',
        primitive: 'line',
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        sourceIds: [`native-stroke-${index + 1}`],
      })),
      unresolved: [],
    };
    const adapter = new FakeAdapter({
      input: {
        lens: 'diagram',
        strokes,
        texts: [{
          id: 'native-text',
          text: 'x'.repeat(5000),
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        }],
        t0Plan: t0Plan as never,
      },
      snapshot: { elementIds: [], versions: {} },
    });
    const { transport, requests, resolvers } = deferredTransport();
    const controller = createInterpretController(adapterAsCanvas(adapter), { transport });
    const pending = controller.start();
    await waitFor(() => requests.length === 1);
    resolvers[0]?.(answer());
    await pending;

    expect(requests).toHaveLength(1);
    const request = requests[0] as {
      strokes: Array<{ points: unknown[] }>;
      texts: Array<{ text: string }>;
      t0Plan: unknown;
    };
    expect(Math.max(...request.strokes.map((stroke) => stroke.points.length))).toBeLessThanOrEqual(
      DEFAULT_INTERPRET_LIMITS.maxPointsPerStroke,
    );
    expect(request.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0))
      .toBeLessThanOrEqual(DEFAULT_INTERPRET_LIMITS.maxTotalPoints);
    expect(request.texts[0]?.text.length).toBe(DEFAULT_INTERPRET_LIMITS.maxTextLength);
    expect(request.t0Plan).toBeNull();
    expect(validatePostedRequest({ request })).toMatchObject({ t0Plan: null });
  });

  it.each([
    ['strokes', {
      strokes: Array.from({ length: 129 }, (_, index) => ({
        id: `stroke-${index}`,
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      })),
    }],
    ['texts', {
      texts: Array.from({ length: 65 }, (_, index) => ({
        id: `text-${index}`,
        text: 'x',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      })),
    }],
  ])('shows the fixed scope message for too many %s without transport', async (_kind, input) => {
    const scope = input as {
      strokes?: ModelInput['input']['strokes'];
      texts?: ModelInput['input']['texts'];
    };
    const adapter = new FakeAdapter({
      input: {
        lens: 'diagram',
        strokes: scope.strokes ?? [],
        texts: scope.texts ?? [],
        t0Plan: null,
      },
      snapshot: { elementIds: [], versions: {} },
    });
    let calls = 0;
    const transport: InterpretClientTransport = {
      getStatus: async () => {
        calls += 1;
        return status;
      },
      interpret: async () => {
        calls += 1;
        return answer();
      },
    };
    const controller = createInterpretController(adapterAsCanvas(adapter), { transport });
    await controller.start();
    expect(calls).toBe(0);
    expect(adapter.statuses.at(-1)).toBe(
      'Interpret works on up to 128 strokes and 64 text boxes. Select part of the drawing and press Interpret again.',
    );
  });

  it('grounds connector endpoints before unaliasing the model plan', async () => {
    const adapter = new FakeAdapter({
      input: {
        lens: 'diagram',
        strokes: [
          {
            id: 'real-shaft',
            points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
          },
          {
            id: 'real-head',
            points: [{ x: 95, y: -5 }, { x: 100, y: 0 }],
          },
        ],
        texts: [],
        t0Plan: null,
      },
      snapshot: { elementIds: [], versions: {} },
    });
    const cornerPlan = {
      version: 1,
      lens: 'diagram' as const,
      tier: 't2' as const,
      items: [{
        id: 'connector-1',
        kind: 'connector' as const,
        points: [[0, 20], [100, 20]] as [number, number][],
        start: null,
        end: null,
        startArrowhead: null,
        endArrowhead: 'arrow' as const,
        sourceIds: ['s1', 's2'],
        reason: 'A directed connector.',
      }],
      unresolved: [],
    };
    const transport: InterpretClientTransport = {
      getStatus: async () => status,
      interpret: async () => ({
        ok: true,
        plan: cornerPlan,
        model: 'deepseek-flash',
        latencyMs: 12,
        usage: null,
      }),
    };
    const controller = createInterpretController(
      adapterAsCanvas(adapter),
      { transport },
    );

    await controller.start();

    expect(adapter.shownPlans[0]).toMatchObject({
      items: [{
        id: 'connector-1',
        points: [[0, 0], [100, 0]],
        sourceIds: ['real-shaft', 'real-head'],
      }],
    });
  });

  it('tidies and binds the captured horizontal arrow to native nodes idempotently', async () => {
    const adapter = new FakeAdapter({
      input: {
        lens: 'diagram',
        strokes: [{
          id: 's1',
          points: [{ x: 824.94, y: 993.67 }, { x: 957.17, y: 992.56 }],
        }],
        texts: [],
        t0Plan: null,
      },
      nativeNodes: [
        {
          id: 'native-shape-2',
          kind: 'ellipse',
          bounds: { x: 620, y: 910, width: 204, height: 165 },
        },
        {
          id: 'native-shape-3',
          kind: 'diamond',
          bounds: { x: 982, y: 905, width: 200, height: 190 },
        },
      ],
      snapshot: { elementIds: [], versions: {} },
    });
    const modelPlan = {
      version: 1,
      lens: 'diagram' as const,
      tier: 't2' as const,
      items: [{
        id: 'connector-1',
        kind: 'connector' as const,
        points: [
          [824.94, 993.67],
          [897.17, 993.67],
          [919.39, 990.33],
          [927.17, 994.78],
          [951.61, 995.89],
          [970.5, 1007],
          [983.83, 1003.67],
        ] as [number, number][],
        start: null,
        end: null,
        startArrowhead: null,
        endArrowhead: 'arrow' as const,
        sourceIds: ['s1'],
      }],
      unresolved: [],
    };
    const transport: InterpretClientTransport = {
      getStatus: async () => status,
      interpret: async () => ({
        ok: true,
        plan: modelPlan,
        model: 'deepseek-flash',
        latencyMs: 12,
        usage: null,
        dropped: 2,
      }),
    };
    const controller = createInterpretController(
      adapterAsCanvas(adapter),
      { transport },
    );

    await controller.start();
    await controller.start();

    expect(adapter.shownPlans).toHaveLength(2);
    expect(adapter.shownPlans[0]).toEqual(adapter.shownPlans[1]);
    const shown = adapter.shownPlans[0] as {
      items: Array<{
        points: Array<[number, number]>;
        start: unknown;
        end: unknown;
      }>;
    };
    const edge = shown.items[0]!;
    expect(edge.start).toEqual({ elementId: 'native-shape-2' });
    expect(edge.end).toEqual({ elementId: 'native-shape-3' });
    expect(edge.points).toHaveLength(2);
    expect(edge.points[0]?.[0]).toBe(824.94);
    expect(edge.points[0]?.[1]).toBeCloseTo(994.78, 1);
    expect(edge.points[1]?.[0]).toBeGreaterThanOrEqual(983);
    expect(edge.points[1]?.[0]).toBeLessThanOrEqual(988);
    expect(edge.points[1]?.[1]).toBeCloseTo(994.78, 1);
    expect(adapter.shownOptions).toEqual([
      { label: 'Interpret', skipped: 2 },
      { label: 'Interpret', skipped: 2 },
    ]);
  });

  it('keeps singular and plural skipped wording through preview toggles', () => {
    const rejected = new Set<string>();
    const format = (skipped: number) => formatSuggestionPreviewStatus(
      plan as unknown as SuggestionPlan,
      rejected,
      'Interpret',
      skipped,
    );

    expect(format(1)).toContain('(1 suggestion skipped).');
    expect(format(2)).toContain('(2 suggestions skipped).');
    expect(format(0)).not.toContain('skipped');

    const beforeToggle = format(1);
    rejected.add('shape-1');
    const whileRejected = format(1);
    rejected.delete('shape-1');
    const afterRestore = format(1);
    expect(whileRejected).toContain('(1 suggestion skipped).');
    expect(afterRestore).toBe(beforeToggle);
  });

  it('axis-snaps a model-bound connector and fits only the inside rectangle end', async () => {
    const adapter = new FakeAdapter({
      input: {
        lens: 'diagram',
        strokes: [
          {
            id: 's1',
            points: [
              { x: 550, y: 664 },
              { x: 791, y: 664 },
              { x: 791, y: 779 },
              { x: 550, y: 779 },
              { x: 550, y: 664 },
            ],
          },
          {
            id: 's2',
            points: [{ x: 678, y: 767 }, { x: 696, y: 905 }],
          },
          {
            id: 's3',
            points: [{ x: 722, y: 910 }, { x: 824, y: 1075 }],
          },
        ],
        texts: [],
        t0Plan: null,
      },
      snapshot: { elementIds: [], versions: {} },
    });
    const modelPlan = {
      version: 1,
      lens: 'diagram' as const,
      tier: 't2' as const,
      items: [
        {
          id: 'shape-1',
          kind: 'shape' as const,
          shape: 'rectangle' as const,
          x: 550,
          y: 664,
          width: 241,
          height: 115,
          sourceIds: ['s1'],
        },
        {
          id: 'shape-2',
          kind: 'shape' as const,
          shape: 'ellipse' as const,
          x: 620,
          y: 910,
          width: 204,
          height: 165,
          sourceIds: ['s3'],
        },
        {
          id: 'connector-1',
          kind: 'connector' as const,
          points: [[678, 767], [696, 905]] as [number, number][],
          start: { itemId: 'shape-1' },
          end: { itemId: 'shape-2' },
          startArrowhead: null,
          endArrowhead: 'arrow' as const,
          sourceIds: ['s2'],
        },
      ],
      unresolved: [],
    };
    const transport: InterpretClientTransport = {
      getStatus: async () => status,
      interpret: async () => ({
        ok: true,
        plan: modelPlan,
        model: 'deepseek-flash',
        latencyMs: 12,
        usage: null,
      }),
    };
    const controller = createInterpretController(
      adapterAsCanvas(adapter),
      { transport },
    );

    await controller.start();

    expect(adapter.shownPlans[0]).toMatchObject({
      items: [
        {},
        {},
        {
          points: [
            [expect.closeTo(687, 0.5), expect.closeTo(779, 0.5)],
            [expect.closeTo(687, 0.5), 905],
          ],
          start: { itemId: 'shape-1' },
          end: { itemId: 'shape-2' },
        },
      ],
    });
  });
});
