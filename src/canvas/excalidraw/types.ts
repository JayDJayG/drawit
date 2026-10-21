import type { Point } from '../../core/geometry/drawing-improvement-engine';
import type { InterpretSceneInput } from '../../perception/interpret';
import type { T0NativeNode } from '../../perception/t0';

export type { Point };

export type CanvasElementType =
  | 'freedraw'
  | 'line'
  | 'arrow'
  | 'diamond'
  | 'ellipse'
  | 'rectangle'
  | 'text'
  | 'other';

export type CanvasElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  roughness: number;
  opacity: number;
  locked: boolean;
  isDeleted: boolean;
  version: number;
  versionNonce: number;
  updated: number;
  index?: string | null;
  customData?: Record<string, unknown>;
  points?: readonly [number, number][];
  pressures?: readonly number[];
  simulatePressure?: boolean;
  lastCommittedPoint?: readonly [number, number] | null;
  [key: string]: unknown;
};

export type CanvasAppState = {
  selectedElementIds: Readonly<Record<string, true>>;
  openDialog?: { name: string } | null;
  openMenu?: string | null;
  editingTextElement?: unknown | null;
  activeTool?: {
    type: string;
  };
};

export type DrawitStroke = {
  sourceId: string;
  points: Point[];
  color: string;
  width: number;
  opacity: number;
  angle: number;
};

export type NativeElementKind = 'line' | 'ellipse' | 'rectangle' | 'freedraw';

export type NativeElementDraft = {
  kind: NativeElementKind;
  sourceIds: string[];
  points?: Point[];
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  style: {
    color: string;
    width: number;
    opacity: number;
  };
};

export type SuggestionStatus =
  | 'idle'
  | 'ready'
  | 'already-clean'
  | 'nothing-to-improve'
  | 'no-freehand-selection'
  | 'not-a-box'
  | 'applied'
  | 'dismissed'
  | 'error';

/** A rectangle in CSS pixels, relative to the top-left corner of the canvas. */
export type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PendingReview = {
  title: string;
  detail: string;
  includedCount: number;
  totalCount: number;
  /** Where the preview and its source strokes are drawn; may lie partly off screen. */
  anchor?: ViewportRect;
};

export type CanvasAdapterState = {
  status: string;
  statusKind: SuggestionStatus;
  /** Increases whenever the status is set, even when the text repeats. */
  statusId: number;
  review?: PendingReview;
  hasPendingSuggestion: boolean;
  canSuggest: boolean;
  canSuggestDiagram: boolean;
  canExport: boolean;
  /** True while the last applied suggestion is still the latest change to the drawing. */
  canUndo: boolean;
  /** True while one of Excalidraw's own menus, popups or dialogs is open. */
  excalidrawUiOpen: boolean;
  mermaidCode?: string;
  mermaidUnboundArrows?: number;
  selectedStrokeCount: number;
};

export type ModelSceneSnapshot = {
  elementIds: string[];
  versions: Record<string, number>;
};

export type ModelInput = {
  input: InterpretSceneInput;
  nativeNodes?: T0NativeNode[];
  snapshot: ModelSceneSnapshot;
};
