import type { SuggestionBounds } from '../../core/suggestions';

export type MermaidNodeKind = 'rectangle' | 'roundedRectangle' | 'diamond' | 'ellipse';

export type MermaidNode = {
  id: string;
  kind: MermaidNodeKind;
  bounds: SuggestionBounds;
  label?: string;
};

export type MermaidEdgeDirection = 'forward' | 'backward' | 'both' | 'none';

export type MermaidEdge = {
  id: string;
  from?: string;
  to?: string;
  direction: MermaidEdgeDirection;
  label?: string;
};

export type MermaidContainer = {
  id: string;
  title?: string;
  children: string[];
};

export type DiagramModel = {
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  containers?: MermaidContainer[];
};

export type MermaidOutput = {
  code: string;
  unboundArrows: number;
};

export const generateMermaid = (model: DiagramModel): MermaidOutput => {
  const nodes = [...model.nodes].sort(compareNodes);
  const nodeIds = new Map<string, string>();
  nodes.forEach((node, index) => nodeIds.set(node.id, `n${index + 1}`));
  const orientation = chooseOrientation(nodes, model.edges);
  const lines = [`flowchart ${orientation}`];
  const containers = normalizeContainers(model.containers ?? [], nodeIds);
  const containedBy = new Map<string, MermaidContainer>();
  const containerNodeIds = new Map<string, string>();
  for (const container of containers) {
    containerNodeIds.set(container.id, container.id);
    for (const child of container.children) {
      containedBy.set(child, container);
    }
  }

  const emittedNodes = new Set<string>();
  for (const container of containers) {
    const title = container.title
      ?? nodes.find((node) => node.id === container.id)?.label
      ?? 'Group';
    lines.push(`subgraph ${container.mermaidId}[${quoteLabel(escapeMermaidLabel(title))}]`);
    for (const childId of container.children) {
      const child = nodes.find((candidate) => candidate.id === childId);
      if (!child) {
        continue;
      }
      lines.push(`  ${renderNode(child, nodeIds.get(child.id) ?? child.id)}`);
      emittedNodes.add(child.id);
    }
    lines.push('end');
    emittedNodes.add(container.id);
  }
  for (const node of nodes) {
    if (emittedNodes.has(node.id)) {
      continue;
    }
    const container = containedBy.get(node.id);
    if (container) {
      continue;
    }
    lines.push(renderNode(node, nodeIds.get(node.id) ?? node.id));
    emittedNodes.add(node.id);
  }

  let unboundArrows = 0;
  for (const edge of [...model.edges].sort((first, second) => first.id.localeCompare(second.id))) {
    const from = edge.from
      ? containerNodeIds.get(edge.from) ?? nodeIds.get(edge.from)
      : undefined;
    const to = edge.to
      ? containerNodeIds.get(edge.to) ?? nodeIds.get(edge.to)
      : undefined;
    if (!from || !to) {
      unboundArrows += 1;
      continue;
    }
    lines.push(renderEdge(from, to, edge));
  }

  return {
    code: `${lines.join('\n')}\n`,
    unboundArrows,
  };
};

export const escapeMermaidLabel = (value: string): string => {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br/>')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '&quot;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/\|/g, '&#124;')
    .replace(/#/g, '&#35;')
    .replace(/;/g, '&#59;')
    .trim();
  if (!normalized) {
    return ' ';
  }
  return normalized;
};

const renderNode = (node: MermaidNode, id: string): string => {
  const label = node.label ? escapeMermaidLabel(node.label) : '';
  const safeLabel = needsQuotedLabel(label) ? quoteLabel(label) : label || ' ';
  switch (node.kind) {
    case 'roundedRectangle':
      return `${id}(${safeLabel})`;
    case 'diamond':
      return `${id}{${safeLabel}}`;
    case 'ellipse':
      return `${id}((${safeLabel}))`;
    case 'rectangle':
    default:
      return `${id}[${safeLabel}]`;
  }
};

const renderEdge = (
  from: string,
  to: string,
  edge: MermaidEdge,
): string => {
  const label = edge.label ? escapeMermaidLabel(edge.label) : '';
  const labelled = label ? `|${label}|` : '';
  switch (edge.direction) {
    case 'backward':
      return `${to} -->${labelled} ${from}`;
    case 'both':
      return `${from} <--${labelled}> ${to}`;
    case 'none':
      return `${from} ---${labelled} ${to}`;
    case 'forward':
    default:
      return `${from} -->${labelled} ${to}`;
  }
};

const quoteLabel = (label: string): string => `"${label}"`;

const needsQuotedLabel = (label: string): boolean => {
  return /(^|\s)end($|\s)/i.test(label)
    || /[\[\]{}|#;]/.test(label)
    || label.includes('<br/>')
    || label.includes('&quot;')
    || label.includes('"');
};

const compareNodes = (first: MermaidNode, second: MermaidNode): number => {
  return first.bounds.y - second.bounds.y
    || first.bounds.x - second.bounds.x
    || first.id.localeCompare(second.id);
};

const chooseOrientation = (
  nodes: readonly MermaidNode[],
  edges: readonly MermaidEdge[],
): 'TD' | 'LR' => {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  let horizontal = 0;
  let vertical = 0;
  for (const edge of edges) {
    const from = edge.from ? nodeMap.get(edge.from) : undefined;
    const to = edge.to ? nodeMap.get(edge.to) : undefined;
    if (!from || !to) {
      continue;
    }
    const dx = Math.abs((to.bounds.x + to.bounds.width / 2) - (from.bounds.x + from.bounds.width / 2));
    const dy = Math.abs((to.bounds.y + to.bounds.height / 2) - (from.bounds.y + from.bounds.height / 2));
    if (dx > dy) {
      horizontal += 1;
    } else {
      vertical += 1;
    }
  }
  return horizontal > vertical ? 'LR' : 'TD';
};

const normalizeContainers = (
  containers: readonly MermaidContainer[],
  nodeIds: ReadonlyMap<string, string>,
): NormalizedMermaidContainer[] => {
  return containers
    .map((container, index) => ({
      id: container.id,
      title: container.title,
      mermaidId: `c${index + 1}`,
      children: container.children
        .filter((child) => nodeIds.has(child))
        .map((child) => child),
    }))
    .filter((container) => container.children.length > 0);
};

type NormalizedMermaidContainer = MermaidContainer & {
  mermaidId: string;
};
