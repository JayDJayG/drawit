import type { NodeRef, SuggestionBounds, SuggestionPoint } from '../suggestions';
import type {
  DiagramSceneGraph,
  StructureEdge,
  StructureNode,
} from './types';

export const boundsCenter = (bounds: SuggestionBounds): SuggestionPoint => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

export const boundsContains = (
  outer: SuggestionBounds,
  inner: SuggestionBounds,
  tolerance = 0,
): boolean => {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
};

export const pointInBounds = (
  point: SuggestionPoint,
  bounds: SuggestionBounds,
  tolerance = 0,
): boolean => {
  return point.x >= bounds.x - tolerance
    && point.x <= bounds.x + bounds.width + tolerance
    && point.y >= bounds.y - tolerance
    && point.y <= bounds.y + bounds.height + tolerance;
};

export const distanceToBounds = (
  point: SuggestionPoint,
  bounds: SuggestionBounds,
): number => {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
};

export const buildContainment = (
  nodes: readonly StructureNode[],
): StructureNode[] => {
  const result = nodes.map((node) => ({
    ...node,
    children: [] as NodeRef[],
  }));

  for (const outer of result) {
    const children = result
      .filter((inner) => {
        if (inner === outer || !boundsContains(outer.bounds, inner.bounds, 1)) {
          return false;
        }
        return inner.bounds.width * inner.bounds.height
          < outer.bounds.width * outer.bounds.height;
      })
      .sort((first, second) => {
        return first.bounds.width * first.bounds.height
          - second.bounds.width * second.bounds.height;
      });

    for (const child of children) {
      const hasSmallerContainer = result.some((candidate) => {
        return candidate !== outer
          && candidate !== child
          && boundsContains(outer.bounds, candidate.bounds, 1)
          && boundsContains(candidate.bounds, child.bounds, 1)
          && candidate.bounds.width * candidate.bounds.height
            < outer.bounds.width * outer.bounds.height
          && candidate.bounds.width * candidate.bounds.height
            > child.bounds.width * child.bounds.height;
      });
      if (!hasSmallerContainer) {
        outer.children.push(child.ref);
      }
    }
  }

  return result;
};

export const alignNodes = (
  nodes: readonly StructureNode[],
  tolerance = 12,
): StructureNode[] => {
  const result = nodes.map((node) => ({
    ...node,
    bounds: { ...node.bounds },
    children: [...node.children],
  }));

  for (let firstIndex = 0; firstIndex < result.length; firstIndex += 1) {
    const first = result[firstIndex];
    if (!first) {
      continue;
    }
    const firstCenter = boundsCenter(first.bounds);
    for (let secondIndex = firstIndex + 1; secondIndex < result.length; secondIndex += 1) {
      const second = result[secondIndex];
      if (!second || second.kind !== first.kind) {
        continue;
      }
      const secondCenter = boundsCenter(second.bounds);
      const rowTolerance = Math.max(
        tolerance,
        Math.min(first.bounds.height, second.bounds.height) * 0.15,
      );
      const columnTolerance = Math.max(
        tolerance,
        Math.min(first.bounds.width, second.bounds.width) * 0.15,
      );

      if (Math.abs(firstCenter.y - secondCenter.y) <= rowTolerance) {
        const y = (firstCenter.y + secondCenter.y) / 2;
        first.bounds.y = y - first.bounds.height / 2;
        second.bounds.y = y - second.bounds.height / 2;
      }
      if (Math.abs(firstCenter.x - secondCenter.x) <= columnTolerance) {
        const x = (firstCenter.x + secondCenter.x) / 2;
        first.bounds.x = x - first.bounds.width / 2;
        second.bounds.x = x - second.bounds.width / 2;
      }
    }
  }

  return result;
};

export const makeSceneGraph = (
  nodes: readonly StructureNode[],
  edges: readonly StructureEdge[],
): DiagramSceneGraph => ({
  nodes: buildContainment(alignNodes(nodes)),
  edges: edges.map((edge) => ({
    ...edge,
    points: edge.points.map((point) => ({ ...point })),
  })),
});

export const refKey = (ref: NodeRef): string => {
  return 'itemId' in ref ? `item:${ref.itemId}` : `elementId:${ref.elementId}`;
};
