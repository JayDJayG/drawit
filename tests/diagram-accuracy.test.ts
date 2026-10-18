import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { recognizeDiagram } from '../src/perception/t0';
import type {
  ConnectorSuggestionItem,
  ShapeSuggestionItem,
  SuggestionPlan,
} from '../src/core/suggestions';

type FixtureDocument = {
  elements: FixtureElement[];
};

const sameShapeKind = (actual: string, expected: string): boolean => {
  if (
    (actual === 'rectangle' || actual === 'roundedRectangle')
    && (expected === 'rectangle' || expected === 'roundedRectangle')
  ) {
    return true;
  }
  return actual === expected;
};

type FixtureElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: [number, number][];
  text?: string;
};

type ExpectedNode = {
  id: string;
  kind: string;
  sourceIds: string[];
  label?: string;
};

type ExpectedEdge = {
  from: string;
  to: string;
  direction: string;
  label?: string;
};

type ExpectedContainer = {
  sourceIds: string[];
  children: string[][];
  title?: string;
};

type ExpectedFixture = {
  split: 'dev' | 'holdout';
  seed: number;
  negative?: boolean;
  nodes: ExpectedNode[];
  edges: ExpectedEdge[];
  containers: ExpectedContainer[];
};

type LoadedFixture = {
  name: string;
  expected: ExpectedFixture;
  input: Parameters<typeof recognizeDiagram>[0];
};

const fixtureRoot = join(process.cwd(), 'tests', 'fixtures', 'diagram');

describe('seeded diagram accuracy', () => {
  it('meets node, edge and container thresholds on dev and holdout', () => {
    const all = loadFixtures();
    const benchmark = benchmarkThirtyStrokeFlowchart(all);
    const reports = (['dev', 'holdout'] as const).map((split) => {
      const fixtures = all.filter((fixture) => fixture.expected.split === split);
      const metrics = fixtures.map(evaluateFixture);
      return aggregateReport(split, metrics, benchmark);
    });

    reports.forEach((report) => console.log(formatAccuracyReport(report)));
    for (const report of reports) {
      expect(report.nodes.precision).toBeGreaterThanOrEqual(0.9);
      expect(report.nodes.recall).toBeGreaterThanOrEqual(0.9);
      expect(report.edges.precision).toBeGreaterThanOrEqual(0.9);
      expect(report.edges.recall).toBeGreaterThanOrEqual(0.9);
      expect(report.containers.precision).toBeGreaterThanOrEqual(0.9);
      expect(report.containers.recall).toBeGreaterThanOrEqual(0.9);
    }
  });
});

type Counts = { truePositive: number; predicted: number; expected: number };
type FixtureMetrics = {
  name: string;
  nodes: Counts;
  edges: Counts;
  containers: Counts;
  kindMatrix: Record<string, number>;
  elapsedMs: number;
};

type AggregateReport = {
  split: string;
  fixtures: number;
  nodes: Counts & { precision: number; recall: number };
  edges: Counts & { precision: number; recall: number };
  containers: Counts & { precision: number; recall: number };
  kindMatrix: Record<string, number>;
  timing: { p50: number; p95: number };
};

const loadFixtures = (): LoadedFixture[] => {
  const fixtures: LoadedFixture[] = [];
  for (const split of ['dev', 'holdout'] as const) {
    const directory = join(fixtureRoot, split);
    const names = readdirSync(directory)
      .filter((name) => name.endsWith('.excalidraw'))
      .sort();
    for (const name of names) {
      const document = JSON.parse(
        readFileSync(join(directory, name), 'utf8'),
      ) as FixtureDocument;
      const expected = JSON.parse(
        readFileSync(join(directory, name.replace('.excalidraw', '.expected.json')), 'utf8'),
      ) as ExpectedFixture;
      const strokeIds = new Set(
        document.elements.filter((element) => element.type === 'freedraw').map((element) => element.id),
      );
      fixtures.push({
        name,
        expected,
        input: {
          strokes: document.elements
            .filter((element) => element.type === 'freedraw')
            .map((element) => ({
              id: element.id,
              points: absolutePoints(element),
            })),
          texts: document.elements
            .filter((element) => element.type === 'text')
            .map((element) => ({
              id: element.id,
              text: element.text ?? '',
              x: element.x,
              y: element.y,
              width: element.width,
              height: element.height,
            })),
        },
      });
      void strokeIds;
    }
  }
  return fixtures;
};

const evaluateFixture = (fixture: LoadedFixture): FixtureMetrics => {
  const start = performance.now();
  const plan = recognizeDiagram(fixture.input);
  if (fixture.expected.negative) {
    expect(plan.items.filter((item) => item.kind === 'shape' || item.kind === 'connector'), fixture.name)
      .toHaveLength(0);
  }
  const elapsedMs = performance.now() - start;
  const strokeIds = new Set(fixture.input.strokes.map((stroke) => stroke.id));
  const nodeMatches = matchNodes(plan, fixture.expected.nodes, strokeIds);
  const edgeMatches = matchEdges(plan, fixture.expected.edges, fixture.expected.nodes, strokeIds);
  const containerMatches = matchContainers(plan, fixture.expected.containers, fixture.expected.nodes, strokeIds);
  const kindMatrix: Record<string, number> = {};
  for (const expected of fixture.expected.nodes) {
    const recognized = plan.items
      .filter((item) => item.kind === 'shape')
      .find((item) => sameSourceStrokes(item.sourceIds, expected.sourceIds, strokeIds));
    const key = `${expected.kind}->${recognized?.kind === 'shape' ? recognized.shape : 'missing'}`;
    kindMatrix[key] = (kindMatrix[key] ?? 0) + 1;
  }
  return {
    name: fixture.name,
    nodes: nodeMatches,
    edges: edgeMatches,
    containers: containerMatches,
    kindMatrix,
    elapsedMs,
  };
};

const matchNodes = (
  plan: SuggestionPlan,
  expected: readonly ExpectedNode[],
  strokeIds: ReadonlySet<string>,
): Counts => {
  const predicted = plan.items.filter((item): item is ShapeSuggestionItem => item.kind === 'shape');
  let truePositive = 0;
  const used = new Set<string>();
  for (const node of expected) {
    const match = predicted.find((item) => {
      return !used.has(item.id)
        && sameShapeKind(item.shape, node.kind)
        && sameSourceStrokes(item.sourceIds, node.sourceIds, strokeIds)
        && normalizeText(item.label) === normalizeText(node.label);
    });
    if (match) {
      truePositive += 1;
      used.add(match.id);
    }
  }
  return { truePositive, predicted: predicted.length, expected: expected.length };
};

const matchEdges = (
  plan: SuggestionPlan,
  expected: readonly ExpectedEdge[],
  expectedNodes: readonly ExpectedNode[],
  strokeIds: ReadonlySet<string>,
): Counts => {
  const predicted = plan.items.filter((item): item is ConnectorSuggestionItem => item.kind === 'connector');
  const nodeByItemId = new Map(
    plan.items
      .filter((item): item is ShapeSuggestionItem => item.kind === 'shape')
      .map((item) => [item.id, item]),
  );
  let truePositive = 0;
  const used = new Set<string>();
  for (const edge of expected) {
    const from = expectedNodes.find((node) => node.id === edge.from);
    const to = expectedNodes.find((node) => node.id === edge.to);
    const match = predicted.find((item) => {
      if (used.has(item.id)) {
        return false;
      }
      const start = item.start && 'itemId' in item.start ? nodeByItemId.get(item.start.itemId) : undefined;
      const end = item.end && 'itemId' in item.end ? nodeByItemId.get(item.end.itemId) : undefined;
      return Boolean(from && to && start && end)
        && sameSourceStrokes(start?.sourceIds ?? [], from?.sourceIds ?? [], strokeIds)
        && sameSourceStrokes(end?.sourceIds ?? [], to?.sourceIds ?? [], strokeIds)
        && edgeDirection(item.startArrowhead, item.endArrowhead) === edge.direction
        && normalizeText(item.label) === normalizeText(edge.label);
    });
    if (match) {
      truePositive += 1;
      used.add(match.id);
    }
  }
  return { truePositive, predicted: predicted.length, expected: expected.length };
};

const matchContainers = (
  plan: SuggestionPlan,
  expected: readonly ExpectedContainer[],
  expectedNodes: readonly ExpectedNode[],
  strokeIds: ReadonlySet<string>,
): Counts => {
  const predicted = plan.items.filter((item): item is ShapeSuggestionItem => {
    return item.kind === 'shape' && (item.children?.length ?? 0) > 0;
  });
  let truePositive = 0;
  const used = new Set<string>();
  for (const container of expected) {
    const match = predicted.find((item) => {
      if (used.has(item.id) || !sameSourceStrokes(item.sourceIds, container.sourceIds, strokeIds)) {
        return false;
      }
      const shapeItem = item;
      const children = (shapeItem.children ?? [])
        .map((childId) => plan.items.find((candidate) => candidate.id === childId))
        .filter((child): child is ShapeSuggestionItem => child?.kind === 'shape')
        .map((child) => child.sourceIds.filter((id) => strokeIds.has(id)).sort().join('|'))
        .sort();
      const expectedChildren = container.children
        .map((child) => child.filter((id) => strokeIds.has(id)).sort().join('|'))
        .sort();
      return JSON.stringify(children) === JSON.stringify(expectedChildren)
        && normalizeText(shapeItem.label) === normalizeText(container.title);
    });
    if (match) {
      truePositive += 1;
      used.add(match.id);
    }
  }
  void expectedNodes;
  return { truePositive, predicted: predicted.length, expected: expected.length };
};

const aggregateReport = (
  split: string,
  metrics: readonly FixtureMetrics[],
  benchmark: readonly number[],
): AggregateReport => {
  const combine = (key: 'nodes' | 'edges' | 'containers') => {
    const counts = metrics.reduce((sum, metric) => ({
      truePositive: sum.truePositive + metric[key].truePositive,
      predicted: sum.predicted + metric[key].predicted,
      expected: sum.expected + metric[key].expected,
    }), { truePositive: 0, predicted: 0, expected: 0 });
    return {
      ...counts,
      precision: ratio(counts.truePositive, counts.predicted),
      recall: ratio(counts.truePositive, counts.expected),
    };
  };
  const kindMatrix: Record<string, number> = {};
  metrics.forEach((metric) => Object.entries(metric.kindMatrix).forEach(([key, value]) => {
    kindMatrix[key] = (kindMatrix[key] ?? 0) + value;
  }));
  const timing = [...benchmark].sort((first, second) => first - second);
  return {
    split,
    fixtures: metrics.length,
    nodes: combine('nodes'),
    edges: combine('edges'),
    containers: combine('containers'),
    kindMatrix,
    timing: {
      p50: percentile(timing, 0.5),
      p95: percentile(timing, 0.95),
    },
  };
};

const formatAccuracyReport = (report: AggregateReport): string => {
  const metric = (value: { precision: number; recall: number }) => {
    return `precision=${value.precision.toFixed(3)} recall=${value.recall.toFixed(3)}`;
  };
  return [
    `DIAGRAM_ACCURACY ${report.split} fixtures=${report.fixtures}`,
    `  nodes ${metric(report.nodes)} tp=${report.nodes.truePositive}/${report.nodes.expected} predicted=${report.nodes.predicted}`,
    `  edges ${metric(report.edges)} tp=${report.edges.truePositive}/${report.edges.expected} predicted=${report.edges.predicted}`,
    `  containers ${metric(report.containers)} tp=${report.containers.truePositive}/${report.containers.expected} predicted=${report.containers.predicted}`,
    `  confusion ${JSON.stringify(report.kindMatrix)}`,
    `  timing (dense flowchart) p50=${report.timing.p50.toFixed(3)}ms p95=${report.timing.p95.toFixed(3)}ms`,
  ].join('\n');
};

const benchmarkThirtyStrokeFlowchart = (fixtures: readonly LoadedFixture[]): number[] => {
  const input = fixtures.find((fixture) => (
    !fixture.expected.negative && fixture.input.strokes.length >= 30
  ))?.input ?? fixtures[0]?.input;
  if (!input) {
    return [];
  }
  return Array.from({ length: 25 }, () => {
    const start = performance.now();
    recognizeDiagram(input);
    return performance.now() - start;
  });
};

const absolutePoints = (element: FixtureElement): { x: number; y: number }[] => {
  return (element.points ?? []).map(([x, y]) => ({ x: element.x + x, y: element.y + y }));
};

const sameSourceStrokes = (
  actual: readonly string[],
  expected: readonly string[],
  strokeIds: ReadonlySet<string>,
): boolean => {
  return JSON.stringify(actual.filter((id) => strokeIds.has(id)).sort())
    === JSON.stringify([...expected].filter((id) => strokeIds.has(id)).sort());
};

const normalizeText = (value: string | undefined): string => {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
};

const edgeDirection = (
  start: 'arrow' | null,
  end: 'arrow' | null,
): string => {
  if (start && end) {
    return 'both';
  }
  if (start) {
    return 'backward';
  }
  if (end) {
    return 'forward';
  }
  return 'none';
};

const ratio = (numerator: number, denominator: number): number => {
  return denominator === 0 ? 1 : numerator / denominator;
};

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.floor((values.length - 1) * fraction));
  return values[index] ?? 0;
};
