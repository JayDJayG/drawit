import {
  DrawingImprovementEngine,
  type GroupImprovementResult,
  type ImprovementMode,
  type Stroke as GeometryStroke,
} from '../../core/geometry/drawing-improvement-engine';
import {
  rectangleDraft,
  strokesToDrafts,
} from './scene-logic';
import type {
  DrawitStroke,
  NativeElementDraft,
} from './types';

export type SuggestionOperation =
  | {
      kind: 'stroke';
      sourceIds: string[];
      drafts: NativeElementDraft[];
      mode: Exclude<ImprovementMode, 'unchanged'>;
      removedPoints: number;
      target: 'selection' | 'last';
    }
  | {
      kind: 'group';
      sourceIds: string[];
      drafts: NativeElementDraft[];
      mode: 'rectangle';
      removedPoints: number;
      target: 'selection' | 'last';
    };

export type SuggestionTarget = 'selection' | 'last' | 'none';

export type SuggestionResult =
  | {
      kind: 'ready';
      operation: SuggestionOperation;
    }
  | {
      kind: 'already-clean';
      operation?: undefined;
    }
  | {
      kind: 'not-a-box';
      operation?: undefined;
    }
  | {
      kind: 'nothing-to-improve';
      operation?: undefined;
    }
  | {
      kind: 'no-freehand-selection';
      operation?: undefined;
    };

export class StrokeSuggestionEngine {
  private readonly geometry = new DrawingImprovementEngine();

  suggest(
    strokes: readonly DrawitStroke[],
    target: SuggestionTarget = 'last',
  ): SuggestionResult {
    if (strokes.length === 0) {
      return target === 'selection'
        ? { kind: 'no-freehand-selection' }
        : { kind: 'nothing-to-improve' };
    }

    if (strokes.length === 1) {
      return this.suggestStroke(strokes[0], target === 'selection' ? 'selection' : 'last');
    }

    return this.suggestGroup(strokes, target === 'selection' ? 'selection' : 'last');
  }

  private suggestStroke(
    stroke: DrawitStroke,
    target: 'selection' | 'last',
  ): SuggestionResult {
    const result = this.geometry.improve(stroke.points);

    if (result.mode === 'unchanged') {
      return { kind: 'already-clean' };
    }

    return {
      kind: 'ready',
      operation: {
        kind: 'stroke',
        sourceIds: [stroke.sourceId],
        drafts: strokesToDrafts(
          [stroke],
          result.mode,
          result.points,
        ),
        mode: result.mode,
        removedPoints: result.removedPoints,
        target,
      },
    };
  }

  private suggestGroup(
    strokes: readonly DrawitStroke[],
    target: 'selection' | 'last',
  ): SuggestionResult {
    const geometryStrokes: GeometryStroke[] = strokes.map((stroke, index) => ({
      id: index,
      points: stroke.points.map((point) => ({ ...point })),
    }));
    const result: GroupImprovementResult = this.geometry.improveGroup(geometryStrokes);

    if (result.mode !== 'rectangle') {
      return { kind: 'not-a-box' };
    }

    const replacementPoints = result.replacements.flatMap((replacement) => {
      return replacement.points;
    });

    return {
      kind: 'ready',
      operation: {
        kind: 'group',
        sourceIds: strokes.map((stroke) => stroke.sourceId),
        drafts: rectangleDraft(strokes, replacementPoints),
        mode: 'rectangle',
        removedPoints: result.removedPoints,
        target,
      },
    };
  }
}

export const formatSuggestionStatus = (
  result: SuggestionResult,
): {
  text: string;
  kind:
    | 'ready'
    | 'already-clean'
    | 'nothing-to-improve'
    | 'no-freehand-selection'
    | 'not-a-box';
} => {
  if (result.kind === 'nothing-to-improve') {
    return {
      text: 'Nothing to improve yet — draw a stroke first.',
      kind: 'nothing-to-improve',
    };
  }

  if (result.kind === 'no-freehand-selection') {
    return {
      text: 'The selection has no freehand strokes — select a stroke, or clear the selection to use the last one.',
      kind: 'no-freehand-selection',
    };
  }

  if (result.kind === 'already-clean') {
    return {
      text: 'Already clean — no improvement is needed for the target.',
      kind: 'already-clean',
    };
  }

  if (result.kind === 'not-a-box') {
    return {
      text: 'Not a box — select four straight-ish strokes that form a box.',
      kind: 'not-a-box',
    };
  }

  const removed = result.operation.removedPoints > 0
    ? ` Simplified ${result.operation.removedPoints} noisy points.`
    : '';

  const target = result.operation.target === 'last'
    ? 'the last stroke'
    : 'the selected stroke';
  return {
    text: `Suggestion ready — ${result.operation.kind === 'group' ? 'fit the selection to a rectangle.' : `cleaned ${target}.`}${removed} Apply or dismiss it.`,
    kind: 'ready',
  };
};

export type PendingKeyAction =
  | 'apply'
  | 'dismiss-and-block'
  | 'dismiss'
  | 'keep'
  | 'none';

export type PendingContextMenuAction = 'dismiss' | 'keep';

export const getPendingContextMenuAction = (
  hasPendingSuggestion: boolean,
): PendingContextMenuAction => {
  return hasPendingSuggestion ? 'dismiss' : 'keep';
};

type PendingKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

const keyCodeMap = new Map([
  ['y', 'KeyY'],
  ['z', 'KeyZ'],
]);

const isLatinChar = (key: string): boolean => /^[a-z]$/.test(key.toLowerCase());

export const matchesExcalidrawKey = (
  event: Pick<PendingKeyEvent, 'code' | 'key'>,
  key: string,
): boolean => {
  const normalizedKey = event.key.toLowerCase();
  if (normalizedKey === key) {
    return true;
  }

  const code = keyCodeMap.get(key);
  return Boolean(code && !isLatinChar(normalizedKey) && event.code === code);
};

const bareModifierKeys = new Set([
  'Control',
  'Meta',
  'Alt',
  'AltGraph',
  'Shift',
]);

const zoomCodes = new Set([
  'Equal',
  'NumpadAdd',
  'Minus',
  'NumpadSubtract',
  'Digit0',
  'Numpad0',
]);

export const getPendingKeyAction = (
  event: PendingKeyEvent,
  editingText: boolean,
): PendingKeyAction => {
  if (editingText) {
    return 'none';
  }

  const hasControlModifier = event.ctrlKey || event.metaKey;
  const hasCommandModifier = hasControlModifier || event.altKey;

  if (!hasCommandModifier) {
    if (event.key === 'Enter') {
      return 'apply';
    }

    if (event.key === 'Escape') {
      return 'dismiss-and-block';
    }

    return 'none';
  }

  if (bareModifierKeys.has(event.key)) {
    return 'keep';
  }

  const isZoom = hasControlModifier
    && !event.altKey
    && zoomCodes.has(event.code);
  if (isZoom) {
    return 'keep';
  }

  const isUndo = hasControlModifier
    && !event.shiftKey
    && matchesExcalidrawKey(event, 'z');
  return isUndo ? 'dismiss-and-block' : 'dismiss';
};
