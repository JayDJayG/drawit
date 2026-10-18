import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterOutputElements, markAsPreview } from '../src/canvas/excalidraw/scene-logic';
import type { CanvasElement } from '../src/canvas/excalidraw/types';

describe('Excalidraw adapter output JSON round-trip', () => {
  it('restores sketch strokes while excluding pending previews', () => {
    // Vitest cannot import Excalidraw's browser entry because its open-color
    // JSON dependency is not transformed as an import-attribute module.
    // Serialize the exact adapter output envelope instead.
    const document = JSON.parse(
      readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rough-circle.excalidraw'), 'utf8'),
    ) as {
      elements: CanvasElement[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    };
    const source = document.elements[0];
    if (!source) {
      throw new Error('The rough-circle fixture has no source stroke.');
    }

    const preview = markAsPreview({
      ...source,
      id: 'pending-preview',
      type: 'ellipse',
      customData: undefined,
    }, [source.id]);
    const outputElements = filterOutputElements([
      ...document.elements,
      preview,
    ]);
    const serialized = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'drawit-adapter-test',
      elements: outputElements,
      appState: document.appState,
      files: document.files,
    });
    const restoredDocument = JSON.parse(serialized) as {
      elements: CanvasElement[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    };
    const restored = restoredDocument.elements;

    expect(restored.some((element) => element.customData?.drawit === 'preview')).toBe(false);
    expect(restored.some((element) => element.id === 'pending-preview')).toBe(false);

    const restoredSource = restored.find((element) => element.id === source.id);
    expect(restoredSource).toMatchObject({
      id: source.id,
      type: 'freedraw',
      strokeColor: source.strokeColor,
      strokeWidth: source.strokeWidth,
      opacity: source.opacity,
      strokeStyle: source.strokeStyle,
      locked: source.locked,
      points: source.points,
      pressures: source.pressures,
    });
  });
});
