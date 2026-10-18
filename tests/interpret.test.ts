import { describe, expect, it } from 'vitest';
import {
  MockInterpretProvider,
  buildInterpretPrompt,
  buildInterpretRequest,
  validateInterpretResponse,
  type InterpretRequest,
} from '../src/perception/interpret';

const request = (): InterpretRequest => buildInterpretRequest({
  lens: 'diagram',
  strokes: [{
    id: 'stroke-a',
    points: [
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 110, y: 70 },
    ],
  }, {
    id: 'stroke-b',
    points: [{ x: 160, y: 40 }, { x: 240, y: 40 }],
  }],
  texts: [{
    id: 'text-a',
    text: 'Start',
    x: 30,
    y: 25,
    width: 40,
    height: 20,
  }],
  intent: 'Keep this as a simple flowchart',
});

const validResponse = () => ({
  version: 1,
  lens: 'diagram',
  tier: 't2',
  items: [{
    id: 'shape-a',
    kind: 'shape',
    shape: 'rectangle',
    x: 10,
    y: 10,
    width: 100,
    height: 60,
    label: 'Start',
    sourceIds: ['stroke-a', 'text-a'],
  }, {
    id: 'edge-b',
    kind: 'connector',
    points: [[110, 40], [160, 40]],
    start: { itemId: 'shape-a' },
    end: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    sourceIds: ['stroke-b'],
  }],
  unresolved: [],
});

describe('Interpret seam', () => {
  it('builds a bounded, rounded request and a provider-neutral prompt', () => {
    const bounded = buildInterpretRequest({
      ...request(),
      strokes: Array.from({ length: 4 }, (_, index) => ({
        id: `s${index}`,
        points: Array.from({ length: 10 }, (_, point) => ({ x: point, y: index })),
      })),
    }, {
      maxStrokes: 2,
      maxPointsPerStroke: 4,
      maxTotalPoints: 5,
      maxTextLength: 3,
      maxImageLength: 2,
    });
    expect(bounded.strokes).toHaveLength(2);
    expect(bounded.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)).toBeLessThanOrEqual(5);
    expect(bounded.texts[0]?.text).toBe('Sta');
    expect(bounded.image).toBeUndefined();

    const messages = buildInterpretPrompt({
      ...request(),
      image: 'data:image/png;base64,AA==',
    }, { images: true, jsonMode: true });
    expect(messages[0]?.content).toContain('return actionable suggestions');
    expect(messages[0]?.content).toContain('Never invent IDs');
    expect(messages[0]?.content).toContain('json');
    expect(messages[1]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' }),
    ]));
  });

  it('accepts a strict valid plan and rejects malformed references', () => {
    const input = request();
    expect(validateInterpretResponse(JSON.stringify(validResponse()), input)).toEqual({
      ok: true,
      plan: validResponse(),
    });

    const unknownId = structuredClone(validResponse());
    unknownId.items[0].sourceIds = ['invented'];
    expect(validateInterpretResponse(unknownId, input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('unknown source')]),
    });

    const duplicateSources = structuredClone(validResponse());
    duplicateSources.items[1].sourceIds = ['text-a'];
    expect(validateInterpretResponse(duplicateSources, input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('belongs to both')]),
    });

    const badReference = structuredClone(validResponse());
    badReference.items[1].start = { itemId: 'missing' };
    expect(validateInterpretResponse(badReference, input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('does not resolve')]),
    });

    const farAway = structuredClone(validResponse());
    farAway.items[0].x = 50_000;
    expect(validateInterpretResponse(farAway, input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('outside the request bounds')]),
    });
  });

  it('handles empty and invalid mock responses deterministically', async () => {
    const input = request();
    const valid = await new MockInterpretProvider('valid').interpret(input, {});
    expect(validateInterpretResponse(valid, input).ok).toBe(true);
    expect(validateInterpretResponse(
      await new MockInterpretProvider('empty').interpret(input, {}),
      input,
    )).toMatchObject({ ok: false, errors: ['response was empty'] });
    expect(validateInterpretResponse(
      await new MockInterpretProvider('invalid').interpret(input, {}),
      input,
    )).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('unknown source')]),
    });
  });
});
