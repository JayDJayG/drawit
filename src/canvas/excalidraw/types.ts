import type { Point } from '../../core/geometry/drawing-improvement-engine';
import type { InterpretSceneInput } from '../../perception/interpret';

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
  | 'dismissed';

export type CanvasAdapterState = {
  status: string;
  statusKind: SuggestionStatus;
  hasPendingSuggestion: boolean;
  canSuggest: boolean;
  canSuggestDiagram: boolean;
  canExport: boolean;
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
  snapshot: ModelSceneSnapshot;
};
