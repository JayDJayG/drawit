import { describe, expect, it } from 'vitest';
import {
  applyElementSet,
  filterOutputElements,
  freedrawElementToStroke,
  getAbsoluteFreedrawPoints,
  getTargetFreedrawElements,
  isSourceVeil,
  markAsPreview,
  removePreviewElements,
  strokesToDrafts,
  updateSourceVeil,
  withSourceVeils,
} from '../src/canvas/excalidraw/scene-logic';
import {
  describePendingReview,
  formatSuggestionStatus,
  getPendingContextMenuAction,
  getPendingKeyAction,
  matchesExcalidrawKey,
  StrokeSuggestionEngine,
  type SuggestionOperation,
} from '../src/canvas/excalidraw/adapter-logic';
import type { CanvasElement, DrawitStroke } from '../src/canvas/excalidraw/types';
import type { SuggestionPlan } from '../src/core/suggestions';

const element = (
  id: string,
  overrides: Partial<CanvasElement> = {},
): CanvasElement => ({
  id,
  type: 'freedraw',
  x: 0,
  y: 0,
  width: 20,
  height: 10,
  angle: 0,
  strokeColor: '#123456',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 3,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 80,
  locked: false,
  isDeleted: false,
  version: 1,
  versionNonce: 2,
  updated: 3,
  points: [[0, 0], [20, 10]],
  ...overrides,
});

describe('Excalidraw adapter scene logic', () => {
  it('converts a rotated freedraw element to absolute scene coordinates', () => {
    const rotated = element('rotated', {
      x: 100,
      y: 50,
      points: [[0, 0], [10, 0]],
      angle: Math.PI / 2,
    });

    expect(getAbsoluteFreedrawPoints(rotated)).toEqual([
      { x: 105, y: 45 },
      { x: 105, y: 55 },
    ]);
    expect(freedrawElementToStroke(rotated)?.points).toEqual([
      { x: 105, y: 45 },
      { x: 105, y: 55 },
    ]);
  });

  it('prefers selected freedraw elements and otherwise uses the last freedraw', () => {
    const first = element('first');
    const second = element('second', { type: 'rectangle' });
    const last = element('last');
    const elements = [first, second, last];

    expect(getTargetFreedrawElements(elements, { first: true }).map(({ id }) => id))
      .toEqual(['first']);
    expect(getTargetFreedrawElements(elements, {}).map(({ id }) => id))
      .toEqual(['last']);
    expect(getTargetFreedrawElements(elements, { second: true }).map(({ id }) => id))
      .toEqual([]);
  });

  it('marks preview elements with the required non-authoring metadata', () => {
    const preview = markAsPreview(element('preview'), ['source-a', 'source-b']);

    expect(preview.strokeStyle).toBe('dashed');
    expect(preview.locked).toBe(true);
    expect(preview.customData).toEqual({
      drawit: 'preview',
      sourceIds: ['source-a', 'source-b'],
    });
  });

  it('creates native drafts with source styling', () => {
    const stroke: DrawitStroke = {
      sourceId: 'source-a',
      points: [{ x: 10, y: 20 }, { x: 50, y: 20 }],
      color: '#abcdef',
      width: 5,
      opacity: 42,
      angle: 0,
    };

    expect(strokesToDrafts([stroke], 'straightened', stroke.points)).toEqual([{
      kind: 'line',
      sourceIds: ['source-a'],
      points: stroke.points,
      style: { color: '#abcdef', width: 5, opacity: 42 },
    }]);
  });

  it('removes previews and marks sources deleted in one apply element set', () => {
    const source = element('source');
    const other = element('other');
    const preview = markAsPreview(element('preview', { type: 'line' }), ['source']);
    const native = element('native', { type: 'line', customData: { drawit: 'native' } });

    const applied = applyElementSet(
      [source, other, preview],
      ['source'],
      [native],
      (current) => ({
        ...current,
        isDeleted: true,
        version: current.version + 1,
      }),
    );

    expect(applied.map(({ id }) => id)).toEqual(['source', 'other', 'native']);
    expect(applied[0]?.isDeleted).toBe(true);
    expect(applied[0]?.version).toBe(2);
    expect(applied.some((candidate) => candidate.id === 'preview')).toBe(false);
    expect(filterOutputElements(applied).map(({ id }) => id)).toEqual(['other', 'native']);
  });

  it('dismisses previews without changing authoring elements', () => {
    const source = element('source');
    const preview = markAsPreview(element('preview'), ['source']);

    expect(removePreviewElements([source, preview])).toEqual([source]);
  });

  it('reports a distinct empty-target status', () => {
    const result = new StrokeSuggestionEngine().suggest([]);

    expect(result.kind).toBe('nothing-to-improve');
    expect(formatSuggestionStatus(result)).toEqual({
      text: 'Nothing to improve yet — draw a stroke first.',
      kind: 'nothing-to-improve',
    });
  });

  it('reports when an active selection has no freehand strokes', () => {
    const result = new StrokeSuggestionEngine().suggest([], 'selection');

    expect(result.kind).toBe('no-freehand-selection');
    expect(formatSuggestionStatus(result)).toEqual({
      text: 'The selection has no freehand strokes — select a stroke, or clear the selection to use the last one.',
      kind: 'no-freehand-selection',
    });
  });

  it('names the last stroke when the fallback target is used', () => {
    const result = new StrokeSuggestionEngine().suggest([{
      sourceId: 'last',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 1 }],
      color: '#000',
      width: 2,
      opacity: 100,
      angle: 0,
    }], 'last');

    expect(result.kind).toBe('ready');
    expect(formatSuggestionStatus(result).text)
      .toContain('cleaned the last stroke.');
  });

  it('keeps the preview for bare modifiers and zoom chords', () => {
    expect(getPendingKeyAction({
      key: 'Alt',
      code: 'AltLeft',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }, false)).toBe('keep');
    expect(getPendingKeyAction({
      key: '=',
      code: 'Equal',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }, false)).toBe('keep');
  });

  it('dismisses before modified Enter or Escape reaches Excalidraw', () => {
    expect(getPendingKeyAction({
      key: 'Enter',
      code: 'Enter',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }, false)).toBe('dismiss');
    expect(getPendingKeyAction({
      key: 'Escape',
      code: 'Escape',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }, false)).toBe('dismiss');
  });

  it('dismisses modifier shortcuts without blocking them, except Ctrl+Z', () => {
    expect(getPendingKeyAction({
      key: '©',
      code: 'KeyC',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    }, false)).toBe('dismiss');
    expect(getPendingKeyAction({
      key: 'z',
      code: 'KeyZ',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }, false)).toBe('dismiss-and-block');
    expect(getPendingKeyAction({
      key: 'z',
      code: 'KeyZ',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    }, false)).toBe('dismiss');
  });

  it('mirrors Excalidraw undo matching across keyboard layouts', () => {
    const undoEvents = [
      ['z', 'KeyZ'],
      ['z', 'KeyY'],
      ['z', 'KeyW'],
      ['я', 'KeyZ'],
    ] as const;

    for (const [key, code] of undoEvents) {
      expect(getPendingKeyAction({
        key,
        code,
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }, false)).toBe('dismiss-and-block');
    }

    expect(getPendingKeyAction({
      key: 'z',
      code: 'KeyZ',
      altKey: true,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }, false)).toBe('dismiss-and-block');
    expect(getPendingKeyAction({
      key: 'y',
      code: 'KeyZ',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }, false)).toBe('dismiss');
    expect(getPendingKeyAction({
      key: 'z',
      code: 'KeyZ',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    }, false)).toBe('dismiss');
  });

  it('matches Excalidraw physical shortcuts on non-Latin layouts', () => {
    expect(matchesExcalidrawKey({ key: 'я', code: 'KeyY' }, 'y')).toBe(true);
    expect(matchesExcalidrawKey({ key: 'γ', code: 'KeyZ' }, 'z')).toBe(true);
  });

  it('dismisses a pending preview before opening a context menu', () => {
    expect(getPendingContextMenuAction(true)).toBe('dismiss');
    expect(getPendingContextMenuAction(false)).toBe('keep');
  });

  it('fades freedraw sources with locked veils in the canvas colour', () => {
    const stroke = element('stroke');
    const box = element('box', { type: 'rectangle' });
    const other = element('other');
    const veiled = withSourceVeils(
      [stroke, box, other],
      [{ id: 'item-1', sourceIds: ['stroke', 'box'] }],
      '#fafafa',
    );

    expect(veiled.map(({ id }) => id)).toEqual(['stroke', 'stroke-drawit-veil', 'box', 'other']);
    expect(veiled[0]).toBe(stroke);
    expect(veiled[1]).toMatchObject({
      type: 'freedraw',
      points: stroke.points,
      strokeColor: '#fafafa',
      opacity: 72,
      locked: true,
      customData: {
        drawit: 'preview',
        role: 'veil',
        sourceIds: ['stroke'],
        planItemIds: ['item-1'],
      },
    });
    expect(isSourceVeil(veiled[1]!)).toBe(true);
    expect(removePreviewElements(veiled)).toEqual([stroke, box, other]);
    expect(filterOutputElements(veiled).map(({ id }) => id)).toEqual(['stroke', 'box', 'other']);
  });

  it('clears a veil only when every suggestion item for its stroke is excluded', () => {
    const stroke = element('stroke');
    const items = [
      { id: 'item-1', sourceIds: ['stroke'] },
      { id: 'item-2', sourceIds: ['stroke'] },
    ];
    const veil = withSourceVeils([stroke], items, '#ffffff')[1]!;

    expect(updateSourceVeil(veil, new Set(['item-1'])).opacity).toBe(72);
    expect(updateSourceVeil(veil, new Set(['item-1', 'item-2'])).opacity).toBe(0);
    expect(withSourceVeils([stroke], items, '#ffffff', new Set(['item-1', 'item-2']))[1]?.opacity)
      .toBe(0);
    expect(updateSourceVeil(stroke, new Set(['item-1']))).toBe(stroke);
  });
});

describe('review bar description', () => {
  const strokePlan: SuggestionPlan = {
    version: 1,
    lens: 'stroke',
    tier: 't0',
    items: [{
      id: 'stroke-1',
      kind: 'stroke',
      primitive: 'line',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      sourceIds: ['a'],
    }],
    unresolved: [],
  };
  const strokeOperation = (
    mode: 'smoothed' | 'straightened' | 'circled',
    target: 'selection' | 'last',
    removedPoints: number,
  ): SuggestionOperation => ({
    kind: 'stroke',
    sourceIds: ['a'],
    drafts: [],
    mode,
    removedPoints,
    target,
    plan: strokePlan,
  });

  it('names the stroke change and the strokes it replaces', () => {
    const review = (operation: SuggestionOperation) => describePendingReview({
      plan: strokePlan,
      rejectedItemIds: new Set(),
      operation,
    });

    expect(review(strokeOperation('straightened', 'last', 0))).toEqual({
      title: 'Straighter line',
      detail: 'Your last stroke',
      includedCount: 1,
      totalCount: 1,
    });
    expect(review(strokeOperation('smoothed', 'selection', 1)).detail)
      .toBe('Your selected stroke · 1 noisy point removed');
    expect(review(strokeOperation('circled', 'last', 5))).toMatchObject({
      title: 'Rounder circle',
      detail: 'Your last stroke · 5 noisy points removed',
    });
    expect(review({
      kind: 'group',
      sourceIds: ['a', 'b', 'c', 'd'],
      drafts: [],
      mode: 'rectangle',
      removedPoints: 0,
      target: 'selection',
      plan: strokePlan,
    })).toMatchObject({
      title: 'Neater rectangle',
      detail: 'Your selected strokes',
    });
  });

  it('summarises the included diagram items and what was skipped', () => {
    const plan: SuggestionPlan = {
      version: 1,
      lens: 'diagram',
      tier: 't0',
      items: [
        { id: 'box-1', kind: 'shape', shape: 'rectangle', x: 0, y: 0, width: 80, height: 40, label: 'Start', sourceIds: ['s1'] },
        { id: 'box-2', kind: 'shape', shape: 'rectangle', x: 200, y: 0, width: 80, height: 40, sourceIds: ['s2'] },
        {
          id: 'arrow-1',
          kind: 'connector',
          points: [[80, 20], [200, 20]],
          start: { itemId: 'box-1' },
          end: { itemId: 'box-2' },
          startArrowhead: null,
          endArrowhead: 'arrow',
          sourceIds: ['s3'],
        },
      ],
      unresolved: [{ sourceIds: ['s4'], reason: 'Not a shape.' }],
    };

    expect(describePendingReview({ plan, rejectedItemIds: new Set() })).toEqual({
      title: 'Diagram',
      detail: '2 shapes, 1 arrow, 1 label, 1 stroke left as drawn',
      includedCount: 3,
      totalCount: 3,
    });
    expect(describePendingReview({
      plan,
      rejectedItemIds: new Set(['box-2']),
      label: 'Interpret',
      skipped: 2,
    })).toEqual({
      title: 'Interpret',
      detail: '1 shape, 1 arrow, 1 label, 1 stroke left as drawn · 2 skipped',
      includedCount: 2,
      totalCount: 3,
    });
    expect(describePendingReview({
      plan,
      rejectedItemIds: new Set(['box-1', 'box-2', 'arrow-1']),
    })).toMatchObject({
      detail: 'No changes, 1 stroke left as drawn',
      includedCount: 0,
    });
  });
});
