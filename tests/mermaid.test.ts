// @vitest-environment jsdom

import mermaid from 'mermaid';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  escapeMermaidLabel,
  generateMermaid,
} from '../src/lenses/diagram/mermaid';

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
});

describe('Mermaid diagram export', () => {
  it('orders nodes, chooses orientation, and renders all edge directions', () => {
    const output = generateMermaid({
      nodes: [
        { id: 'b', kind: 'rectangle', bounds: { x: 0, y: 100, width: 80, height: 40 }, label: 'Second' },
        { id: 'a', kind: 'diamond', bounds: { x: 0, y: 0, width: 80, height: 40 }, label: 'First' },
        { id: 'c', kind: 'ellipse', bounds: { x: 160, y: 100, width: 80, height: 40 }, label: 'Third' },
      ],
      edges: [
        { id: 'forward', from: 'a', to: 'b', direction: 'forward' },
        { id: 'backward', from: 'b', to: 'c', direction: 'backward' },
        { id: 'both', from: 'a', to: 'c', direction: 'both', label: 'yes' },
        { id: 'none', from: 'b', to: 'c', direction: 'none' },
        { id: 'missing', from: 'a', to: 'missing', direction: 'forward' },
        { id: 'half-bound', from: 'a', direction: 'forward' },
      ],
    });

    expect(output.code).toContain('flowchart LR');
    expect(output.code).toContain('n1{First}');
    expect(output.code).toContain('n2[Second]');
    expect(output.code).toContain('n3((Third))');
    expect(output.code).toContain('n1 --> n2');
    expect(output.code).toContain('n3 --> n2');
    expect(output.code).toContain('n1 <--|yes|> n3');
    expect(output.code).toContain('n2 --- n3');
    expect(output.unboundArrows).toBe(2);
  });

  it('escapes labels and parses the generated syntax', async () => {
    const label = 'end [x] {y} | # ; "quoted"\nnext';
    expect(escapeMermaidLabel(label)).toContain('<br/>');
    const output = generateMermaid({
      nodes: [
        {
          id: 'outer',
          kind: 'roundedRectangle',
          bounds: { x: 0, y: 0, width: 240, height: 160 },
          label,
        },
        {
          id: 'inner',
          kind: 'rectangle',
          bounds: { x: 20, y: 50, width: 80, height: 40 },
          label: 'Child',
        },
      ],
      edges: [{
        id: 'edge',
        from: 'outer',
        to: 'inner',
        direction: 'forward',
        label,
      }],
      containers: [{ id: 'outer', title: label, children: ['inner'] }],
    });

    expect(output.code).toContain('subgraph c1[');
    expect(output.code).toContain('n2[Child]');
    await expect(mermaid.parse(output.code)).resolves.toBeTruthy();
  });
});
