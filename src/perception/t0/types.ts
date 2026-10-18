import type { SuggestionBounds, SuggestionPoint } from '../../core/suggestions';

export type T0Stroke = {
  id: string;
  points: SuggestionPoint[];
};

export type T0Text = {
  id: string;
  text: string;
  containerId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type T0NativeNode = {
  id: string;
  kind: 'rectangle' | 'roundedRectangle' | 'diamond' | 'ellipse';
  bounds: SuggestionBounds;
};

export type T0DiagramInput = {
  strokes: T0Stroke[];
  texts: T0Text[];
  nativeNodes?: T0NativeNode[];
};
