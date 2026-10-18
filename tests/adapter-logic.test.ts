import { describe, expect, it } from 'vitest';
import {
  applyElementSet,
  filterOutputElements,
  freedrawElementToStroke,
  getAbsoluteFreedrawPoints,
  getTargetFreedrawElements,
  markAsPreview,
  removePreviewElements,
  strokesToDrafts,
} from '../src/canvas/excalidraw/scene-logic';
import {
  formatSuggestionStatus,
  getPendingContextMenuAction,
  getPendingKeyAction,
  matchesExcalidrawKey,
  StrokeSuggestionEngine,
} from '../src/canvas/excalidraw/adapter-logic';
import type { CanvasElement, DrawitStroke } from '../src/canvas/excalidraw/types';

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
});
