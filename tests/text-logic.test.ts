import { describe, expect, it } from 'vitest';
import {
  consumedTextSourcesArePreserved,
  getElementText,
} from '../src/canvas/excalidraw/text-logic';

describe('Excalidraw text extraction', () => {
  it('prefers originalText over wrapped display text', () => {
    expect(getElementText({
      originalText: 'Fix entry',
      text: 'Fix<br/>entry',
    })).toBe('Fix entry');
  });

  it('preserves exactly one live copy of every consumed text source', () => {
    const source = {
      id: 'source-label',
      type: 'text',
      originalText: 'Load data',
      text: 'Load<br/>data',
    };
    expect(consumedTextSourcesArePreserved(
      ['source-label'],
      [source],
      [
        { ...source, isDeleted: true },
        {
          id: 'generated-label',
          type: 'text',
          originalText: 'Load data',
          text: 'Load<br/>data',
          customData: { sourceIds: ['source-label'] },
        },
      ],
    )).toBe(true);
    expect(consumedTextSourcesArePreserved(
      ['source-label'],
      [source],
      [{ ...source, isDeleted: true }],
    )).toBe(false);
  });
});
