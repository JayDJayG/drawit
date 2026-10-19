import { describe, expect, it } from 'vitest';
import type {
  ConnectorSuggestionItem,
  SuggestionPlan,
} from '../src/core/suggestions';
import {
  aliasInterpretRequest,
  buildInterpretRequest,
  INTERPRET_PROMPT_EXAMPLE,
  INTERPRET_PLAN_LIMITS,
  DEFAULT_INTERPRET_LIMITS,
  INTERPRET_BODY_LIMIT_BYTES,
  layoutSetOfMark,
  validateT0Plan,
  validateInterpretResponse,
  type InterpretRequest,
} from '../src/perception/interpret';
import { groundConnectorEndpoints } from '../src/perception/interpret/grounding';

const aliasedRequest = (): InterpretRequest => ({
  lens: 'diagram',
  strokes: [
    { id: 's1', points: [{ x: 10, y: 10 }, { x: 140, y: 80 }] },
    { id: 's2', points: [{ x: 140, y: 40 }, { x: 220, y: 40 }] },
    { id: 's3', points: [{ x: 24, y: 24 }, { x: 80, y: 40 }] },
    { id: 's4', points: [{ x: 40, y: 42 }, { x: 48, y: 42 }] },
    { id: 's5', points: [{ x: 48, y: 42 }, { x: 56, y: 42 }] },
  ],
  texts: [{ id: 't1', text: 'Start', x: 30, y: 30, width: 50, height: 20 }],
  t0Plan: null,
});

describe('Interpret pure helpers', () => {
  it('aliases source and T0 item IDs without leaking real IDs', () => {
    const request: InterpretRequest = {
      lens: 'diagram',
      strokes: [
        { id: 'real-stroke-a', points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] },
        { id: 'real-stroke-b', points: [{ x: 20, y: 20 }, { x: 40, y: 20 }] },
      ],
      texts: [{ id: 'real-text-a', text: 'Start', x: 2, y: 2, width: 20, height: 12 }],
      t0Plan: {
        version: 1,
        lens: 'diagram',
        tier: 't0',
        items: [
          {
            id: 'shape-real-stroke-a',
            kind: 'shape',
            shape: 'rectangle',
            x: 0,
            y: 0,
            width: 20,
            height: 20,
            sourceIds: ['real-stroke-a'],
            children: [],
          },
          {
            id: 'connector-real-stroke-b',
            kind: 'connector',
            points: [[20, 10], [40, 10]],
            start: { itemId: 'shape-real-stroke-a' },
            end: { elementId: 'native-shape' },
            startArrowhead: null,
            endArrowhead: 'arrow',
            sourceIds: ['real-stroke-b'],
          },
        ],
        unresolved: [{ sourceIds: ['real-text-a'], reason: 'leave it alone' }],
      },
    };
    const aliased = aliasInterpretRequest(request);
    const serialized = JSON.stringify(aliased.request);
    expect(serialized).not.toContain('real-stroke-a');
    expect(serialized).not.toContain('real-stroke-b');
    expect(serialized).not.toContain('real-text-a');
    expect(serialized).not.toContain('native-shape');
    expect(aliased.request.t0Plan?.items[0]?.id).toBe('p1');
    const connector = aliased.request.t0Plan?.items[1];
    expect(connector?.kind).toBe('connector');
    if (connector?.kind === 'connector') {
      expect(connector.start).toEqual({ itemId: 'p1' });
      expect(connector.end).toBeNull();
    }
  });

  it('validates and cleans shared T0 plans', () => {
    const request = aliasedRequest();
    const result = validateT0Plan({
      version: 1,
      lens: 'diagram',
      tier: 't0',
      items: [{
        id: 'p1',
        kind: 'shape',
        shape: 'rectangle',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        sourceIds: ['s1'],
        unknown: 'removed',
      }],
      unresolved: [],
    }, request.strokes, request.texts);
    expect(result).toEqual({
      ok: true,
      plan: {
        version: 1,
        lens: 'diagram',
        tier: 't0',
        items: [{
          id: 'p1',
          kind: 'shape',
          shape: 'rectangle',
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          sourceIds: ['s1'],
        }],
        unresolved: [],
      },
    });
    expect(validateT0Plan({
      version: 1,
      lens: 'diagram',
      tier: 't0',
      items: [{
        id: 'p1',
        kind: 'shape',
        shape: 'rectangle',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        sourceIds: ['s99'],
      }],
      unresolved: [],
    }, request.strokes, request.texts).ok).toBe(false);
  });

  it('validates the embedded prompt example', () => {
    expect(validateInterpretResponse(
      INTERPRET_PROMPT_EXAMPLE,
      aliasedRequest(),
    )).toMatchObject({ ok: true });
    const connector = INTERPRET_PROMPT_EXAMPLE.items.find(
      (item) => item.id === 'connector-1',
    );
    expect(connector).toMatchObject({
      label: 'Yes',
      sourceIds: ['s2', 's4'],
    });
    const note = INTERPRET_PROMPT_EXAMPLE.items.find(
      (item) => item.id === 'text-1',
    );
    expect(note).toMatchObject({ sourceIds: ['s5'] });
  });

  it('grounds corner endpoints to the largest connector shaft', () => {
    const request = createGroundingRequest();
    const plan = createPlan([
      createConnector('connector-1', [[440, 189], [559, 244]], ['s36', 's37']),
      createConnector(
        'connector-2',
        [[739, 244], [899, 189]],
        ['s38', 's39', 's40', 's41', 's42', 's43', 's44'],
        { label: 'YES' },
      ),
    ]);
    const grounded = groundConnectorEndpoints(plan, request);
    expect(grounded.items[0]).toMatchObject({
      points: [[445.85, 243.99], [559, 244]],
    });
    expect(grounded.items[1]).toMatchObject({
      points: [[739, 244], [894.12, 245.58]],
    });
  });

  it('leaves grounded, ambiguous, and short connectors unchanged', () => {
    const request = createGroundingRequest();
    const plan = createPlan([
      createConnector('connector-1', [[441, 245], [554, 245]], ['s36', 's37']),
      createConnector('connector-2', [[740, 244], [894, 245]], ['s38', 's39', 's40']),
      createConnector('connector-3', [[650, 319], [649, 424]], ['s45', 's46', 's47', 's48']),
    ]);
    expect(groundConnectorEndpoints(plan, request)).toEqual(plan);

    const ambiguousRequest: InterpretRequest = {
      lens: 'diagram',
      strokes: [
        { id: 'shaft', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { id: 'other', points: [{ x: 0, y: 10 }, { x: 80, y: 10 }] },
      ],
      texts: [],
      t0Plan: null,
    };
    const ambiguous = createPlan([
      createConnector('ambiguous', [[0, 20], [100, 20]], ['shaft', 'other']),
    ]);
    expect(groundConnectorEndpoints(ambiguous, ambiguousRequest)).toEqual(ambiguous);

    const shortRequest: InterpretRequest = {
      lens: 'diagram',
      strokes: [{ id: 'short', points: [{ x: 0, y: 0 }, { x: 19, y: 0 }] }],
      texts: [],
      t0Plan: null,
    };
    const short = createPlan([
      createConnector('short', [[0, 20], [19, 20]], ['short']),
    ]);
    expect(groundConnectorEndpoints(short, shortRequest)).toEqual(short);

    const pointRequest: InterpretRequest = {
      lens: 'diagram',
      strokes: [{ id: 'point', points: [{ x: 0, y: 0 }] }],
      texts: [],
      t0Plan: null,
    };
    const pointOnly = createPlan([
      createConnector('point-only', [[0, 20], [10, 20]], ['point']),
    ]);
    expect(groundConnectorEndpoints(pointOnly, pointRequest)).toEqual(pointOnly);
  });

  it('does not ground to a cursive label longer than the shaft', () => {
    const request: InterpretRequest = {
      lens: 'diagram',
      strokes: [
        {
          id: 'shaft',
          points: [{ x: 0, y: 100 }, { x: 60, y: 100 }],
        },
        {
          id: 'label',
          points: [
            { x: 0, y: 80 },
            { x: 10, y: 60 },
            { x: 20, y: 80 },
            { x: 30, y: 60 },
            { x: 40, y: 80 },
            { x: 50, y: 60 },
            { x: 60, y: 80 },
            { x: 70, y: 60 },
            { x: 80, y: 80 },
            { x: 90, y: 60 },
            { x: 100, y: 80 },
          ],
        },
      ],
      texts: [],
      t0Plan: null,
    };
    const plan = createPlan([
      createConnector('labelled', [[0, 100], [60, 100]], ['shaft', 'label']),
    ]);

    expect(groundConnectorEndpoints(plan, request)).toEqual(plan);
  });

  it('still grounds a one-stroke arrow with a head', () => {
    const request: InterpretRequest = {
      lens: 'diagram',
      strokes: [{
        id: 'arrow',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 88, y: -7 },
          { x: 100, y: 0 },
          { x: 88, y: 7 },
        ],
      }],
      texts: [],
      t0Plan: null,
    };
    const plan = createPlan([
      createConnector('arrow-connector', [[0, 30], [100, 1]], ['arrow']),
    ]);

    expect(groundConnectorEndpoints(plan, request).items[0]).toMatchObject({
      points: [[0, 0], [100, 1]],
    });
  });

  it('orients endpoints, preserves interior points, and is idempotent', () => {
    const request = createGroundingRequest();
    const reversed = createPlan([
      createConnector('connector-1', [[559, 300], [440, 189]], ['s36', 's37']),
    ]);
    const grounded = groundConnectorEndpoints(reversed, request);
    expect(grounded.items[0]).toMatchObject({
      points: [[554, 245.67], [445.85, 243.99]],
    });

    const multiPointRequest: InterpretRequest = {
      lens: 'diagram',
      strokes: [
        { id: 'shaft', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { id: 'head', points: [{ x: 95, y: -5 }, { x: 100, y: 0 }] },
      ],
      texts: [],
      t0Plan: null,
    };
    const multiPoint = createPlan([
      createConnector('multi', [[-10, 20], [50, 7], [110, 20]], ['shaft', 'head']),
    ]);
    const groundedMultiPoint = groundConnectorEndpoints(multiPoint, multiPointRequest);
    expect(groundedMultiPoint.items[0]).toMatchObject({
      points: [[0, 0], [50, 7], [100, 0]],
    });
    expect(groundConnectorEndpoints(groundedMultiPoint, multiPointRequest))
      .toEqual(groundedMultiPoint);

    const nonConnectorPlan = createPlan([
      {
        id: 'shape',
        kind: 'shape',
        shape: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        sourceIds: ['s36'],
      },
      ...reversed.items,
      {
        id: 'note',
        kind: 'text',
        x: 20,
        y: 20,
        text: 'note',
        sourceIds: ['s37'],
      },
    ]);
    const groundedPlan = groundConnectorEndpoints(nonConnectorPlan, request);
    expect(groundedPlan.items[0]).toEqual(nonConnectorPlan.items[0]);
    expect(groundedPlan.items[2]).toEqual(nonConnectorPlan.items[2]);
  });

  it('strips unknown fields and enforces geometry and metadata limits', () => {
    const response = {
      version: 1,
      lens: 'diagram',
      tier: 't2',
      items: [{
        id: 'line',
        kind: 'stroke',
        primitive: 'line',
        points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
        sourceIds: ['s1'],
        html: '<script>',
        confidence: 0.7,
        reason: 'clean',
      }],
      unresolved: [{ sourceIds: ['s2'], reason: 'uncertain' }],
      image: 'should be stripped',
    };
    const result = validateInterpretResponse(response, aliasedRequest());
    expect(result).toEqual({
      ok: true,
      plan: {
        version: 1,
        lens: 'diagram',
        tier: 't2',
        items: [{
          id: 'line',
          kind: 'stroke',
          primitive: 'line',
          points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
          sourceIds: ['s1'],
          confidence: 0.7,
          reason: 'clean',
        }],
        unresolved: [{ sourceIds: ['s2'], reason: 'uncertain' }],
      },
    });

    const badConfidence = structuredClone(response);
    badConfidence.items[0].confidence = 2;
    expect(validateInterpretResponse(badConfidence, aliasedRequest()).ok).toBe(false);

    const badReason = structuredClone(response);
    badReason.items[0].reason = 'x'.repeat(141);
    expect(validateInterpretResponse(badReason, aliasedRequest()).ok).toBe(false);

    const wrongAxis = structuredClone(response);
    wrongAxis.items[0].points = [{ x: 10, y: 9999 }, { x: 20, y: 9999 }];
    expect(validateInterpretResponse(wrongAxis, aliasedRequest()).ok).toBe(false);
  });

  it('requires renderable fields for every stroke primitive', () => {
    const primitives = [
      ['line', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
      ['curve', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
      ['freedraw', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
      ['ellipse', { bounds: { x: 1, y: 1, width: 10, height: 10 } }],
      ['rectangle', { bounds: { x: 1, y: 1, width: 10, height: 10 } }],
    ] as const;
    for (const [primitive, fields] of primitives) {
      const response = {
        version: 1,
        lens: 'diagram',
        tier: 't2',
        items: [{
          id: primitive,
          kind: 'stroke',
          primitive,
          sourceIds: ['s1'],
          ...fields,
        }],
        unresolved: [{ sourceIds: ['s2'], reason: 'not used' }],
      };
      expect(validateInterpretResponse(response, aliasedRequest()).ok).toBe(true);
    }
    const missing = {
      version: 1,
      lens: 'diagram',
      tier: 't2',
      items: [{
        id: 'bad',
        kind: 'stroke',
        primitive: 'rectangle',
        sourceIds: ['s1'],
      }],
      unresolved: [{ sourceIds: ['s2'], reason: 'not used' }],
    };
    expect(validateInterpretResponse(missing, aliasedRequest()).ok).toBe(false);
  });

  it('keeps a maximal plan within the output budget', () => {
    const strokes = Array.from({ length: 40 }, (_, index) => ({
      id: `s${index + 1}`,
      points: Array.from({ length: 9 }, (_, point) => ({
        x: index * 10 + point,
        y: point,
      })),
    }));
    const plan = {
      version: 1,
      lens: 'diagram',
      tier: 't2',
      items: strokes.map((stroke, index) => ({
        id: `item-${index + 1}`,
        kind: 'stroke' as const,
        primitive: 'freedraw' as const,
        points: Array.from({ length: 9 }, (_, point) => ({
          x: index * 10 + point,
          y: point,
        })),
        sourceIds: [stroke.id],
        confidence: 0.5,
        reason: 'A compact valid suggestion.',
      })),
      unresolved: [],
    };
    const result = validateInterpretResponse(plan, {
      lens: 'diagram',
      strokes,
      texts: [],
      t0Plan: null,
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(plan).length / 3).toBeLessThanOrEqual(0.8 * 16_384);
    expect(plan.items.length).toBe(INTERPRET_PLAN_LIMITS.maxItems);
  });

  it('keeps a worst-case capped request below the serialized body limit', () => {
    const dataUrlPrefix = 'data:image/png;base64,';
    const signature = 'iVBORw0KGgo=';
    const availableImageChars = DEFAULT_INTERPRET_LIMITS.maxImageLength - dataUrlPrefix.length;
    const imagePayloadLength = availableImageChars - (availableImageChars % 4);
    const input = {
      lens: 'diagram' as const,
      strokes: Array.from({ length: DEFAULT_INTERPRET_LIMITS.maxStrokes }, (_, index) => ({
        id: `s${index + 1}`,
        points: Array.from({ length: DEFAULT_INTERPRET_LIMITS.maxPointsPerStroke }, (_, point) => ({
          x: point,
          y: index,
        })),
      })),
      texts: Array.from({ length: DEFAULT_INTERPRET_LIMITS.maxTexts }, (_, index) => ({
        id: `t${index + 1}`,
        text: '\u0000'.repeat(DEFAULT_INTERPRET_LIMITS.maxTextLength),
        x: index,
        y: index,
        width: 10,
        height: 10,
      })),
      t0Plan: null,
      intent: '\u0000'.repeat(DEFAULT_INTERPRET_LIMITS.maxIntentLength),
      image: `${dataUrlPrefix}${signature}${'A'.repeat(
        imagePayloadLength - signature.length,
      )}`,
    };
    const request = buildInterpretRequest(input, DEFAULT_INTERPRET_LIMITS);
    const encodedBytes = Buffer.byteLength(JSON.stringify({ request }), 'utf8');
    expect(request.image?.length).toBeLessThanOrEqual(DEFAULT_INTERPRET_LIMITS.maxImageLength);
    expect(request.texts.reduce((sum, text) => sum + text.text.length, 0))
      .toBe(DEFAULT_INTERPRET_LIMITS.maxTotalTextLength);
    expect(encodedBytes).toBeLessThanOrEqual(INTERPRET_BODY_LIMIT_BYTES);
  });

  it('lays out marks for every source inside the image bounds', () => {
    const layout = layoutSetOfMark({
      strokes: [{
        id: 's1',
        points: [{ x: -5000, y: 0 }, { x: 5000, y: 8000 }],
      }],
      texts: [{
        id: 't1',
        text: 'Label',
        x: 1000,
        y: 2000,
        width: 300,
        height: 100,
      }],
    });
    expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(1024);
    expect(layout.marks.map((mark) => mark.id).sort()).toEqual(['s1', 't1']);
    for (const mark of layout.marks) {
      expect(mark.x).toBeGreaterThanOrEqual(0);
      expect(mark.y).toBeGreaterThanOrEqual(0);
      expect(mark.x + mark.width).toBeLessThanOrEqual(layout.width);
      expect(mark.y + mark.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('keeps marks off handwriting, connectors, typed text and other marks', () => {
    const layout = layoutSetOfMark({
      strokes: [
        {
          id: 's1',
          points: [
            { x: 40, y: 30 },
            { x: 160, y: 30 },
            { x: 160, y: 100 },
            { x: 40, y: 100 },
            { x: 40, y: 30 },
          ],
        },
        {
          id: 's2',
          points: [{ x: 90, y: 60 }, { x: 102, y: 60 }],
        },
        {
          id: 's3',
          points: [{ x: 160, y: 65 }, { x: 250, y: 65 }],
        },
        {
          id: 's4',
          points: [
            { x: 250, y: 30 },
            { x: 370, y: 30 },
            { x: 370, y: 100 },
            { x: 250, y: 100 },
            { x: 250, y: 30 },
          ],
        },
        {
          id: 's5',
          points: [{ x: 295, y: 60 }, { x: 307, y: 60 }],
        },
        {
          id: 's6',
          points: [{ x: 100, y: 160 }, { x: 112, y: 164 }],
        },
      ],
      texts: [{
        id: 't1',
        text: 'Typed note',
        x: 180,
        y: 140,
        width: 80,
        height: 20,
      }],
    });
    const strokeSegments = layout.strokes.flatMap((stroke) => {
      const segments: Array<[
        { x: number; y: number },
        { x: number; y: number },
      ]> = [];
      for (let index = 1; index < stroke.points.length; index += 1) {
        const start = stroke.points[index - 1];
        const end = stroke.points[index];
        if (start && end) {
          segments.push([start, end]);
        }
      }
      return segments;
    });
    const expand = (value: Rect, margin: number): Rect => ({
      x: value.x - margin,
      y: value.y - margin,
      width: value.width + margin * 2,
      height: value.height + margin * 2,
    });
    const segmentIntersects = (
      start: { x: number; y: number },
      end: { x: number; y: number },
      value: Rect,
    ) => {
      const expanded = expand(value, 2);
      let lower = 0;
      let upper = 1;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      for (const [p, q] of [
        [-dx, start.x - expanded.x],
        [dx, expanded.x + expanded.width - start.x],
        [-dy, start.y - expanded.y],
        [dy, expanded.y + expanded.height - start.y],
      ]) {
        if (Math.abs(p) < Number.EPSILON) {
          if (q < 0) {
            return false;
          }
          continue;
        }
        const ratio = q / p;
        if (p < 0) {
          if (ratio > upper) {
            return false;
          }
          lower = Math.max(lower, ratio);
        } else {
          if (ratio < lower) {
            return false;
          }
          upper = Math.min(upper, ratio);
        }
      }
      return true;
    };
    const overlaps = (one: Rect, two: Rect) => {
      return one.x < two.x + two.width
        && one.x + one.width > two.x
        && one.y < two.y + two.height
        && one.y + one.height > two.y;
    };
    const bounds = (points: readonly { x: number; y: number }[]): Rect => {
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return {
        x,
        y,
        width: Math.max(...xs) - x,
        height: Math.max(...ys) - y,
      };
    };
    const sourceBounds = new Map<string, Rect>([
      ...layout.strokes.map((stroke) => [stroke.id, bounds(stroke.points)] as const),
      ...layout.texts.map((text) => [text.id, {
        x: text.x,
        y: text.y,
        width: text.width,
        height: text.height,
      }] as const),
    ]);
    const markRect = (mark: typeof layout.marks[number]): Rect => ({
      x: mark.x,
      y: mark.y,
      width: mark.width,
      height: mark.height,
    });
    for (const mark of layout.marks) {
      const markValue = markRect(mark);
      expect(strokeSegments.some(([start, end]) => segmentIntersects(start, end, markValue)))
        .toBe(false);
      expect(layout.texts.some((text) => overlaps(markValue, {
        x: text.x,
        y: text.y,
        width: text.width,
        height: text.height,
      }))).toBe(false);
      const source = sourceBounds.get(mark.id);
      expect(source).toBeDefined();
      if (source) {
        const horizontal = Math.max(
          source.x - (mark.x + mark.width),
          mark.x - (source.x + source.width),
          0,
        );
        const vertical = Math.max(
          source.y - (mark.y + mark.height),
          mark.y - (source.y + source.height),
          0,
        );
        expect(Math.hypot(horizontal, vertical)).toBeLessThanOrEqual(120);
      }
    }
    for (let first = 0; first < layout.marks.length; first += 1) {
      for (let second = first + 1; second < layout.marks.length; second += 1) {
        expect(overlaps(markRect(layout.marks[first]), markRect(layout.marks[second])))
          .toBe(false);
      }
    }
  });

  it('keeps a seeded maximum-scope layout deterministic and in bounds', () => {
    const request = createDenseSetOfMarkRequest();
    const first = layoutSetOfMark(request);
    const second = layoutSetOfMark(request);

    expect(first.marks).toHaveLength(192);
    expect(second.marks).toEqual(first.marks);
    for (const mark of first.marks) {
      expect(mark.x).toBeGreaterThanOrEqual(0);
      expect(mark.y).toBeGreaterThanOrEqual(0);
      expect(mark.x + mark.width).toBeLessThanOrEqual(first.width);
      expect(mark.y + mark.height).toBeLessThanOrEqual(first.height);
    }
  });
});

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const createDenseSetOfMarkRequest = (): InterpretRequest => {
  let state = 0x51f15e;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const strokes = Array.from({ length: 128 }, (_, index) => {
    let x = random() * 600;
    let y = random() * 400;
    return {
      id: `s${index + 1}`,
      points: Array.from({ length: 32 }, (_, pointIndex) => {
        if (pointIndex > 0) {
          x += random() * 40 - 20;
          y += random() * 40 - 20;
        }
        return { x, y };
      }),
    };
  });
  const texts = Array.from({ length: 64 }, (_, index) => ({
    id: `t${index + 1}`,
    text: `Text ${index + 1}`,
    x: random() * 600,
    y: random() * 400,
    width: 60,
    height: 20,
  }));
  return {
    lens: 'diagram',
    strokes,
    texts,
    t0Plan: null,
  };
};

const createConnector = (
  id: string,
  points: [number, number][],
  sourceIds: string[],
  extra: Partial<ConnectorSuggestionItem> = {},
): ConnectorSuggestionItem => ({
  id,
  kind: 'connector',
  points,
  start: null,
  end: null,
  startArrowhead: null,
  endArrowhead: 'arrow',
  sourceIds,
  ...extra,
});

const createPlan = (
  items: SuggestionPlan['items'],
): SuggestionPlan => ({
  version: 1,
  lens: 'diagram',
  tier: 't2',
  items,
  unresolved: [],
});

const createGroundingRequest = (): InterpretRequest => ({
  lens: 'diagram',
  strokes: [
    {
      id: 's36',
      points: [{ x: 445.85, y: 243.99 }, { x: 554, y: 245.67 }],
    },
    {
      id: 's37',
      points: [{ x: 537, y: 236 }, { x: 545, y: 245 }, { x: 554, y: 254 }],
    },
    {
      id: 's38',
      points: [{ x: 745.97, y: 244.08 }, { x: 894.12, y: 245.58 }],
    },
    {
      id: 's39',
      points: [{ x: 877, y: 235 }, { x: 886, y: 245 }, { x: 877, y: 255 }],
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `s${40 + index}`,
      points: [
        { x: 797 + index * 10, y: 209 },
        { x: 803 + index * 10, y: 215 },
      ],
    })),
    {
      id: 's45',
      points: [{ x: 651.67, y: 318.37 }, { x: 648.93, y: 424.06 }],
    },
    {
      id: 's46',
      points: [{ x: 640, y: 415 }, { x: 649, y: 424 }],
    },
    { id: 's47', points: [{ x: 630, y: 300 }, { x: 640, y: 300 }] },
    { id: 's48', points: [{ x: 640, y: 300 }, { x: 650, y: 300 }] },
  ],
  texts: [],
  t0Plan: null,
});
