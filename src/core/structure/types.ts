import type {
  NodeRef,
  SuggestionBounds,
  SuggestionPoint,
} from '../suggestions';

export type StructureNodeKind = 'rectangle' | 'roundedRectangle' | 'diamond' | 'ellipse';

export type StructureNode = {
  ref: NodeRef;
  kind: StructureNodeKind;
  bounds: SuggestionBounds;
  sourceIds: string[];
  label?: string;
  children: NodeRef[];
};

export type StructureEdge = {
  id: string;
  points: SuggestionPoint[];
  start: NodeRef | null;
  end: NodeRef | null;
  startArrowhead: 'arrow' | null;
  endArrowhead: 'arrow' | null;
  sourceIds: string[];
  label?: string;
};

export type DiagramSceneGraph = {
  nodes: StructureNode[];
  edges: StructureEdge[];
};
