import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type {
  GetManualChunk,
  GetModuleInfo,
  OutputBundle,
  OutputChunk,
} from 'rollup';
import { defineConfig, type Plugin } from 'vite';
import {
  buildGeneratedFontLookup,
  findFiles,
  isExcludedFontPath,
  lookupGeneratedFont,
} from './scripts/generated-assets';
import { interpretDevServerPlugin } from './dev-server/interpret/plugin';

const productionContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "connect-src 'self'",
  "font-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

const root = process.cwd();
const subsetRoot = /[\\/]subset-(?:worker|shared)\.chunk\.js$/;
const generatedFontRoot = resolve(
  root,
  'node_modules',
  '@excalidraw',
  'excalidraw',
  'dist',
  'prod',
  'fonts',
);
const noticesPath = resolve(root, 'THIRD_PARTY_NOTICES.md');

let subsetGroups: Map<string, string> | undefined;

const computeSubsetGroups = (
  getModuleInfo: GetModuleInfo,
  startId: string,
): Map<string, string> => {
  const seen = new Set<string>();
  const stack = [startId];
  const roots: string[] = [];

  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    const info = getModuleInfo(id);
    if (!info) {
      continue;
    }

    if (subsetRoot.test(id)) {
      roots.push(id);
    }

    stack.push(
      ...info.importedIds,
      ...info.dynamicallyImportedIds,
      ...info.importers,
      ...info.dynamicImporters,
    );
  }

  if (roots.length === 0) {
    throw new Error(
      'Excalidraw subset modules not found; check the font-subset chunking in vite.config.ts',
    );
  }

  const closure = new Set<string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const id = queue.pop();
    if (!id || closure.has(id)) {
      continue;
    }

    closure.add(id);
    queue.push(...(getModuleInfo(id)?.importedIds ?? []));
  }

  const groups = new Map<string, string>();
  for (const id of closure) {
    const importers = getModuleInfo(id)?.importers ?? [];
    groups.set(
      id,
      importers.some((importer) => !closure.has(importer))
        ? 'excalidraw-subset-runtime'
        : 'excalidraw-subset',
    );
  }

  return groups;
};

const manualChunks: GetManualChunk = (id, { getModuleInfo }) => {
  subsetGroups ??= computeSubsetGroups(getModuleInfo, id);
  return subsetGroups.get(id);
};

const assertSubsetChunkIsolation = (
  bundle: OutputBundle,
  error: (message: string) => never,
) => {
  const chunks = Object.values(bundle).filter(
    (entry): entry is OutputChunk => entry.type === 'chunk',
  );
  const subsetWorkerChunk = chunks.find((chunk) => {
    return Object.keys(chunk.modules).some((id) => subsetRoot.test(id));
  });

  if (!subsetWorkerChunk) {
    error(
      'Excalidraw subset worker chunk was not emitted; check the font-subset chunking in vite.config.ts',
    );
  }

  const visited = new Set<string>();
  const queue = [...subsetWorkerChunk.imports];
  const allowedNames = new Set([
    'excalidraw-subset',
    'excalidraw-subset-runtime',
  ]);

  if (
    subsetWorkerChunk.isEntry
    || !allowedNames.has(subsetWorkerChunk.name)
  ) {
    error(
      `Excalidraw subset worker is in an unexpected chunk: ${subsetWorkerChunk.name}`,
    );
  }

  while (queue.length > 0) {
    const fileName = queue.pop();
    if (!fileName || visited.has(fileName)) {
      continue;
    }

    visited.add(fileName);
    const importedChunk = bundle[fileName];
    if (!importedChunk || importedChunk.type !== 'chunk') {
      error(
        `Excalidraw subset worker imports a missing or non-chunk file: ${fileName}`,
      );
    }

    if (
      importedChunk.isEntry
      || !allowedNames.has(importedChunk.name)
    ) {
      error(
        `Excalidraw subset worker statically imports ${importedChunk.name} (${fileName}); only excalidraw-subset and excalidraw-subset-runtime are allowed`,
      );
    }

    queue.push(...importedChunk.imports);
  }
};

const generatedAssetsPlugin = (): Plugin => ({
  name: 'drawit-generated-assets',
  configureServer(server) {
    const fontLookup = buildGeneratedFontLookup(generatedFontRoot);
    const base = server.config.base.endsWith('/')
      ? server.config.base
      : `${server.config.base}/`;

    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const fontsPrefix = `${base}fonts/`;

      if (pathname.startsWith(fontsPrefix)) {
        const filePath = lookupGeneratedFont(
          fontLookup,
          pathname.slice(fontsPrefix.length),
        );
        if (!filePath) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', 'font/woff2');
        response.end(readFileSync(filePath));
        return;
      }

      if (pathname === `${base}THIRD_PARTY_NOTICES.md`) {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        response.end(readFileSync(noticesPath));
        return;
      }

      next();
    });
  },
  generateBundle() {
    if (!existsSync(generatedFontRoot)) {
      this.error(`Excalidraw font assets were not found at ${generatedFontRoot}`);
    }
    if (!existsSync(noticesPath)) {
      this.error(`Third-party notices were not found at ${noticesPath}`);
    }

    for (const filePath of findFiles(generatedFontRoot)) {
      const relativePath = relative(generatedFontRoot, filePath).replaceAll('\\', '/');
      if (isExcludedFontPath(relativePath)) {
        continue;
      }

      this.emitFile({
        type: 'asset',
        fileName: `fonts/${relativePath}`,
        source: readFileSync(filePath),
      });
    }

    this.emitFile({
      type: 'asset',
      fileName: 'THIRD_PARTY_NOTICES.md',
      source: readFileSync(noticesPath),
    });
  },
});

const subsetChunkGuardPlugin = (): Plugin => ({
  name: 'drawit-subset-chunk-guard',
  buildStart() {
    subsetGroups = undefined;
  },
  generateBundle(_options, bundle) {
    assertSubsetChunkIsolation(bundle, (message) => this.error(message));
  },
});

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    interpretDevServerPlugin(),
    generatedAssetsPlugin(),
    subsetChunkGuardPlugin(),
    {
      name: 'drawit-production-csp',
      transformIndexHtml(html: string) {
        if (mode !== 'production') {
          return html;
        }

        return {
          html,
          tags: [{
            tag: 'meta',
            injectTo: 'head',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: productionContentSecurityPolicy,
            },
          }],
        };
      },
    },
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
}));
