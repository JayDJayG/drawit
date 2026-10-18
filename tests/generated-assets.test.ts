import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGeneratedFontLookup,
  lookupGeneratedFont,
} from '../scripts/generated-assets';

describe('development generated-asset lookup', () => {
  const fontRoot = join(
    process.cwd(),
    'node_modules',
    '@excalidraw',
    'excalidraw',
    'dist',
    'prod',
    'fonts',
  );
  const fontLookup = buildGeneratedFontLookup(fontRoot);

  it('resolves a real font path without constructing a path from the request', () => {
    expect(lookupGeneratedFont(
      fontLookup,
      'Assistant/Assistant-Regular.woff2',
    )).toBe(join(fontRoot, 'Assistant', 'Assistant-Regular.woff2'));
  });

  it.each([
    '%5C%5C%3F%5CC:%5CWindows%5Cwin.ini',
    '///localhost/c$/Windows/win.ini',
    'D:%5Cx',
    '..%5C..%5Cpackage.json',
    '%E0%A4%A',
    '/src/fonts/x',
  ])('rejects unsafe or malformed path %s', (requestPath) => {
    expect(lookupGeneratedFont(fontLookup, requestPath)).toBeUndefined();
  });
});
