import { loadEnv, type Plugin, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { resolveDeepSeekConfig } from './config';
import { createDeepSeekProvider } from './deepseek-provider';
import {
  createInterpretRouteState,
  handleInterpretRequest,
} from './route';

export const interpretDevServerPlugin = (): Plugin => ({
  name: 'drawit-interpret-dev-server',
  apply: 'serve',
  config(userConfig, { mode }) {
    const root = userConfig.root ?? process.cwd();
    const envDir = typeof userConfig.envDir === 'string'
      ? resolve(root, userConfig.envDir)
      : resolve(root);
    const envFiles = [
      '.env',
      '.env.local',
      `.env.${mode}`,
      `.env.${mode}.local`,
    ].map((file) => resolve(envDir, file));
    // Ignore env edits so Vite does not reload the page and erase the drawing.
    return {
      server: {
        watch: {
          ignored: envFiles,
        },
      },
    };
  },
  configureServer(server: ViteDevServer) {
    const state = createInterpretRouteState();
    const base = normalizeBase(server.config.base);
    const rootPath = `${base}/api/interpret`.replace(/\/{2,}/g, '/');
    const statusPath = `${rootPath}/status`;
    const deps = {
      state,
      loadConfig: () => resolveDeepSeekConfig(
        loadEnv(server.config.mode, server.config.envDir, ''),
      ),
      createProvider: createDeepSeekProvider,
      logger: {
        info: (message: string) => server.config.logger.info(message),
      },
    };

    server.middlewares.use((request, response, next) => {
      const pathname = getPathname(request.url);
      if (pathname !== rootPath && pathname !== statusPath) {
        next();
        return;
      }
      void handleInterpretRequest(request, response, deps).catch(() => {
        server.config.logger.error('drawit interpret route failed');
        if (!response.headersSent && !response.destroyed) {
          const body = JSON.stringify({
            ok: false,
            code: 'internal',
            message: 'The local Interpret route failed. Check the terminal and try again.',
          });
          response.statusCode = 500;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
          response.end(body);
          return;
        }
        if (!response.destroyed) {
          response.destroy();
        }
      });
    });
  },
});

const normalizeBase = (value: string): string => {
  if (!value || value === '/') {
    return '';
  }
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, '');
};

const getPathname = (value: string | undefined): string => {
  try {
    return new URL(value ?? '/', 'http://localhost').pathname;
  } catch {
    return '';
  }
};
