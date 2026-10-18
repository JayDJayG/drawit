import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const findFiles = (directory: string): string[] => {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findFiles(path) : [path];
  });
};

export const isExcludedFontPath = (fontPath: string): boolean => {
  return fontPath
    .split(/[\\/]/)
    .some((part) => part.toLowerCase().includes('liberation'));
};

export const buildGeneratedFontLookup = (
  fontRoot: string,
): Map<string, string> => {
  return new Map(
    findFiles(fontRoot)
      .map((filePath) => ({
        filePath,
        relativePath: relative(fontRoot, filePath).replaceAll('\\', '/'),
      }))
      .filter(({ relativePath }) => !isExcludedFontPath(relativePath))
      .map(({ filePath, relativePath }) => [relativePath, filePath]),
  );
};

export const lookupGeneratedFont = (
  fontLookup: ReadonlyMap<string, string>,
  encodedRequestPath: string,
): string | undefined => {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedRequestPath);
  } catch {
    return undefined;
  }

  const normalizedPath = decodedPath.replaceAll('\\', '/');
  if (
    normalizedPath.startsWith('/')
    || /^[A-Za-z]:/.test(normalizedPath)
    || normalizedPath.split('/').some((part) => part === '..')
  ) {
    return undefined;
  }

  return fontLookup.get(normalizedPath);
};
