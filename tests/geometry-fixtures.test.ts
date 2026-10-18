import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DrawingImprovementEngine,
  type Point,
  type Stroke,
} from '../src/core/geometry/drawing-improvement-engine';
import {
  freedrawElementToStroke,
} from '../src/canvas/excalidraw/scene-logic';
import type { CanvasElement } from '../src/canvas/excalidraw/types';
import { StrokeSuggestionEngine } from '../src/canvas/excalidraw/adapter-logic';

type Fixture = {
  elements: CanvasElement[];
};

const fixture = (name: string): Fixture => {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', name), 'utf8'),
  ) as Fixture;
};

const fixtureStroke = (name: string): Point[] => {
  const [element] = fixture(name).elements;
  if (!element) {
    throw new Error(`Fixture ${name} has no element.`);
  }
  return freedrawElementToStroke(element)?.points ?? [];
};

describe('geometry improvement fixtures', () => {
  const engine = new DrawingImprovementEngine();

  it.each([
    ['wobbly-line.excalidraw', 'straightened'],
    ['curve.excalidraw', 'smoothed'],
    ['rough-circle.excalidraw', 'circled'],
    ['already-clean.excalidraw', 'unchanged'],
  ] as const)('%s produces %s', (name, expectedMode) => {
    const result = engine.improve(fixtureStroke(name));
    expect(result.mode).toBe(expectedMode);
  });

  it('fits the four-stroke box fixture to a rectangle', () => {
    const strokes: Stroke[] = fixture('four-stroke-box.excalidraw').elements.map((element, id) => ({
      id,
      points: freedrawElementToStroke(element)?.points ?? [],
    }));

    const result = engine.improveGroup(strokes);

    expect(result.mode).toBe('rectangle');
    expect(result.replacements).toHaveLength(4);
    expect(result.replacements.every((replacement) => replacement.points.length === 2)).toBe(true);
  });

  it('rejects the four-stroke non-box fixture', () => {
    const strokes: Stroke[] = fixture('four-stroke-not-box.excalidraw').elements.map((element, id) => ({
      id,
      points: freedrawElementToStroke(element)?.points ?? [],
    }));

    expect(engine.improveGroup(strokes).mode).toBe('unchanged');
  });

  it('reports adapter statuses for clean strokes and non-box groups', () => {
    const suggestionEngine = new StrokeSuggestionEngine();
    const cleanStroke = freedrawElementToStroke(fixture('already-clean.excalidraw').elements[0]);
    const nonBoxStrokes = fixture('four-stroke-not-box.excalidraw').elements
      .map((element, index) => ({
        sourceId: `source-${index}`,
        points: freedrawElementToStroke(element)?.points ?? [],
        color: '#000',
        width: 2,
        opacity: 100,
        angle: 0,
      }));

    expect(cleanStroke).toBeDefined();
    expect(suggestionEngine.suggest([{
      sourceId: 'clean',
      points: cleanStroke?.points ?? [],
      color: '#000',
      width: 2,
      opacity: 100,
      angle: 0,
    }]).kind).toBe('already-clean');
    expect(suggestionEngine.suggest(nonBoxStrokes).kind).toBe('not-a-box');
  });
});
