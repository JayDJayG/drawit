export type SuggestionPlanVersion = 1;

export type SuggestionLens = 'stroke' | 'diagram';
export type SuggestionTier = 't0' | 't2';

export type SuggestionPoint = {
  x: number;
  y: number;
};

export type SuggestionBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type NodeRef =
  | { itemId: string }
  | { elementId: string };

export type ItemBase = {
  id: string;
  sourceIds: string[];
  confidence?: number;
  reason?: string;
};

export type StrokePrimitive = 'line' | 'curve' | 'ellipse' | 'rectangle' | 'freedraw';

export type StrokeSuggestionItem = ItemBase & {
  kind: 'stroke';
  primitive: StrokePrimitive;
  points?: SuggestionPoint[];
  bounds?: SuggestionBounds;
};

export type ShapeSuggestionItem = ItemBase & {
  kind: 'shape';
  shape: 'rectangle' | 'roundedRectangle' | 'diamond' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  children?: string[];
};

export type ConnectorSuggestionItem = ItemBase & {
  kind: 'connector';
  points: [number, number][];
  start: NodeRef | null;
  end: NodeRef | null;
  startArrowhead: 'arrow' | null;
  endArrowhead: 'arrow' | null;
  label?: string;
};

export type TextSuggestionItem = ItemBase & {
  kind: 'text';
  x: number;
  y: number;
  text: string;
};

export type SuggestionItem =
  | StrokeSuggestionItem
  | ShapeSuggestionItem
  | ConnectorSuggestionItem
  | TextSuggestionItem;

export type UnresolvedSuggestion = {
  sourceIds: string[];
  reason: string;
};

export type SuggestionPlan = {
  version: SuggestionPlanVersion;
  lens: SuggestionLens;
  tier: SuggestionTier;
  items: SuggestionItem[];
  unresolved: UnresolvedSuggestion[];
};

export type SuggestionItemKind = SuggestionItem['kind'];
