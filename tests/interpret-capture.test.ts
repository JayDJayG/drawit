import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  resolveDeepSeekConfig,
  type DeepSeekConfig,
} from '../dev-server/interpret/config';
import {
  createInterpretCaptureWriter,
  type InterpretCaptureRecord,
} from '../dev-server/interpret/capture';
import {
  createInterpretRouteState,
  handleInterpretRequest,
  type InterpretRouteDeps,
} from '../dev-server/interpret/route';
import type {
  CompleteInterpretProvider,
  InterpretCompletion,
  InterpretRequest,
} from '../src/perception/interpret';
import { interpretDevServerPlugin } from '../dev-server/interpret/plugin';
import { validateInterpretResponse } from '../src/perception/interpret';

const TEST_KEY = `test-${randomUUID()}`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const servers: Server[] = [];
const tempFolders: string[] = [];
const scratchRoot = join(tmpdir(), 'drawit-interpret-agent');

const baseRequest: InterpretRequest = {
  lens: 'diagram',
  strokes: [{ id: 's1', points: [{ x: 0, y: 0 }, { x: 80, y: 40 }] }],
  texts: [],
  t0Plan: null,
};

const validPlan = JSON.stringify({
  version: 1,
  lens: 'diagram',
  tier: 't2',
  items: [{
    id: 'shape-1',
    kind: 'shape',
    shape: 'rectangle',
    x: 0,
    y: 0,
    width: 80,
    height: 40,
    sourceIds: ['s1'],
  }],
  unresolved: [],
});

const completion = (
  content = validPlan,
  finishReason: string | null = 'stop',
): InterpretCompletion => ({
  content,
  finishReason,
  model: 'deepseek-flash',
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
});

const invalidContent = JSON.stringify({
  version: 1,
  lens: 'diagram',
  tier: 't2',
  items: [{
    id: 'bad"\n',
    kind: 'shape',
    shape: 'rectangle',
    x: 0,
    y: 0,
    width: 80,
    height: 40,
    sourceIds: ['s1'],
  }, {
    id: 'bad"\n',
    kind: 'text',
    x: 0,
    y: 0,
    text: 'duplicate',
    sourceIds: ['s1'],
  }],
  unresolved: [],
});

const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const configFor = (
  baseUrl: string,
  capture: string | undefined = undefined,
): DeepSeekConfig => resolveDeepSeekConfig({
  DEEPSEEK_API_KEY: TEST_KEY,
  DEEPSEEK_BASE_URL: baseUrl,
  DEEPSEEK_IMAGES: 'false',
  ...(capture === undefined ? {} : { DRAWIT_INTERPRET_CAPTURE: capture }),
});

const requestBody = (request: unknown = baseRequest): string => {
  return JSON.stringify({ request });
};

const post = async (
  url: string,
  request: unknown = baseRequest,
): Promise<Response> => fetch(`${url}/api/interpret`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: requestBody(request),
});

const routeServer = async (
  deps: Omit<InterpretRouteDeps, 'state'>,
) => {
  const state = createInterpretRouteState();
  const server = createServer((req, res) => {
    void handleInterpretRequest(req, res, { ...deps, state });
  });
  return {
    server,
    url: await listen(server),
  };
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for the local capture test.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const makeCaptureRecord = (
  overrides: Partial<InterpretCaptureRecord> = {},
): InterpretCaptureRecord => ({
  version: 1,
  capturedAt: '2026-10-19T17:30:12.345Z',
  outcome: { status: 200, code: 'ok' },
  latencyMs: 123,
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  finishReason: 'stop',
  model: 'deepseek-flash',
  settings: {
    model: 'deepseek-flash',
    images: false,
    thinking: 'disabled',
    reasoningEffort: 'high',
    maxTokens: 16_384,
    timeoutMs: 60_000,
  },
  request: baseRequest,
  rawContent: validPlan,
  plan: JSON.parse(validPlan),
  ...overrides,
});

const makeTempFolder = async (): Promise<string> => {
  await mkdir(scratchRoot, { recursive: true });
  const folder = await mkdtemp(join(scratchRoot, 'capture-'));
  tempFolders.push(folder);
  return folder;
};

describe('Interpret diagnostics and capture', () => {
  afterAll(async () => {
    await Promise.all(servers.map((server) => close(server)));
  });

  afterEach(async () => {
    await Promise.all(tempFolders.splice(0).map((folder) => rm(folder, {
      recursive: true,
      force: true,
    })));
  });

  it('logs bounded JSON-escaped validation details and sanitized finish reasons', async () => {
    const logs: string[] = [];
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1'),
      createProvider: (): CompleteInterpretProvider => ({
        id: 'stub',
        capabilities: { images: false, jsonMode: true },
        complete: async () => completion(invalidContent, 'Stop!\n'),
        interpret: async () => invalidContent,
      }),
      logger: { info: (message) => logs.push(message) },
    });

    const response = await post(app.url);
    expect(response.status).toBe(422);
    const errors = validateInterpretResponse(invalidContent, baseRequest);
    expect(errors.ok).toBe(false);
    const line = logs.find((entry) => entry.includes('code=invalid-answer'));
    expect(line).toBeDefined();
    expect(line).toContain(`errors=${errors.ok ? 0 : errors.errors.length}`);
    expect(line).toContain(
      `detail=${JSON.stringify(errors.ok ? '' : errors.errors.slice(0, 3).join('; ').slice(0, 240))}`,
    );
    expect(line).toContain('finish=stop');
    expect(line?.includes('\n')).toBe(false);
  });

  it('captures only successful and invalid provider content when enabled', async () => {
    const records: InterpretCaptureRecord[] = [];
    const seenRequests: InterpretRequest[] = [];
    let call = 0;
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1', 'yes'),
      createProvider: (): CompleteInterpretProvider => ({
        id: 'stub',
        capabilities: { images: false, jsonMode: true },
        complete: async (request) => {
          seenRequests.push(request);
          call += 1;
          return call === 1
            ? completion()
            : completion(invalidContent, 'stop');
        },
        interpret: async () => validPlan,
      }),
      capture: (record) => {
        records.push(record);
      },
    });
    const request = { ...baseRequest, image: PNG };

    expect((await post(app.url, request)).status).toBe(200);
    await waitFor(() => records.length === 1);
    expect((await post(app.url, request)).status).toBe(422);
    await waitFor(() => records.length === 2);

    expect(records[0]).toMatchObject({
      version: 1,
      outcome: { status: 200, code: 'ok' },
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      finishReason: 'stop',
      model: 'deepseek-flash',
      rawContent: validPlan,
      plan: JSON.parse(validPlan),
      settings: {
        model: 'deepseek-flash',
        images: false,
        thinking: 'disabled',
        reasoningEffort: 'high',
        maxTokens: 16_384,
        timeoutMs: 60_000,
      },
    });
    expect(records[0]?.request).toEqual(seenRequests[0]);
    expect(records[0]?.request.image).toBe(PNG);

    expect(records[1]).toMatchObject({
      outcome: {
        status: 422,
        code: 'invalid-answer',
        errors: expect.any(Array),
      },
      rawContent: invalidContent,
    });
    expect(Object.hasOwn(records[1]!, 'plan')).toBe(false);
    expect(records[1]?.outcome.errors?.length).toBeGreaterThan(0);
    expect(records[1]?.outcome.errors?.length).toBeLessThanOrEqual(50);
    expect(records[1]?.request).toEqual(seenRequests[1]);
    expect(JSON.stringify(records)).not.toContain(TEST_KEY);
  });

  it('does not call capture when disabled or when the provider fails', async () => {
    for (const setting of [undefined, '0', 'false']) {
      const records: InterpretCaptureRecord[] = [];
      const app = await routeServer({
        loadConfig: () => configFor('http://127.0.0.1:1', setting),
        createProvider: (): CompleteInterpretProvider => ({
          id: 'stub',
          capabilities: { images: false, jsonMode: true },
          complete: async () => completion(),
          interpret: async () => validPlan,
        }),
        capture: (record) => {
          records.push(record);
        },
      });
      expect((await post(app.url)).status).toBe(200);
      expect(records).toHaveLength(0);
    }

    const records: InterpretCaptureRecord[] = [];
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1', 'on'),
      createProvider: (): CompleteInterpretProvider => ({
        id: 'stub',
        capabilities: { images: false, jsonMode: true },
        complete: async () => {
          throw new Error('provider failed');
        },
        interpret: async () => validPlan,
      }),
      capture: (record) => {
        records.push(record);
      },
    });
    expect((await post(app.url)).status).toBe(502);
    expect(records).toHaveLength(0);
  });

  it('round-trips the exact captured request through route validation', async () => {
    const records: InterpretCaptureRecord[] = [];
    const seenRequests: InterpretRequest[] = [];
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1', 'true'),
      createProvider: (): CompleteInterpretProvider => ({
        id: 'stub',
        capabilities: { images: false, jsonMode: true },
        complete: async (request) => {
          seenRequests.push(request);
          return completion();
        },
        interpret: async () => validPlan,
      }),
      capture: (record) => {
        records.push(record);
      },
    });
    const request = { ...baseRequest, image: PNG };

    expect((await post(app.url, request)).status).toBe(200);
    await waitFor(() => records.length === 1);
    expect((await post(app.url, records[0]!.request)).status).toBe(200);
    expect(seenRequests[1]).toEqual(records[0]!.request);
  });

  it('writes LF JSON, adds collision suffixes, and retains newest JSON files', async () => {
    const root = await makeTempFolder();
    const captureDir = join(root, 'nested', 'interpret-captures');
    const writer = createInterpretCaptureWriter(captureDir);
    const record = makeCaptureRecord();

    await writer(record);
    await writer(record);
    const firstFiles = (await readdir(captureDir)).sort();
    expect(firstFiles).toEqual([
      '20261019T173012345Z-ok-2.json',
      '20261019T173012345Z-ok.json',
    ]);
    expect((await readFile(join(captureDir, firstFiles[0]!))).toString())
      .not.toContain('\r\n');

    for (let index = 0; index < 52; index += 1) {
      await writeFile(
        join(captureDir, `20260101T000000${String(index).padStart(3, '0')}Z-ok.json`),
        '{}\n',
      );
    }
    await writeFile(join(captureDir, 'keep.txt'), 'keep');
    await writer(record);
    const retained = await readdir(captureDir);
    expect(retained.filter((name) => name.endsWith('.json'))).toHaveLength(50);
    expect(retained).toContain('keep.txt');
  });

  it('keeps the response successful and logs a bounded write failure', async () => {
    const root = await makeTempFolder();
    const blockedPath = join(root, 'blocked');
    await writeFile(blockedPath, 'not a directory');
    const logs: string[] = [];
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1', 'on'),
      createProvider: (): CompleteInterpretProvider => ({
        id: 'stub',
        capabilities: { images: false, jsonMode: true },
        complete: async () => completion(),
        interpret: async () => validPlan,
      }),
      capture: createInterpretCaptureWriter(blockedPath),
      logger: { info: (message) => logs.push(message) },
    });

    expect((await post(app.url)).status).toBe(200);
    await waitFor(() => logs.some((line) => line.includes('capture failed')));
    expect(logs.filter((line) => line.includes('capture failed'))).toHaveLength(1);
    expect(logs.find((line) => line.includes('capture failed')))
      .toMatch(/^drawit interpret capture failed code=(EEXIST|ENOTDIR)$/);
  });

  it('ignores the capture directory in the Vite watcher', () => {
    const plugin = interpretDevServerPlugin();
    const configHook = plugin.config;
    expect(typeof configHook).toBe('function');
    if (typeof configHook !== 'function') {
      return;
    }
    const root = join(process.cwd(), 'capture-plugin-root');
    const callConfigHook = configHook as unknown as (
      userConfig: { root: string },
      env: { mode: string },
    ) => { server?: { watch?: { ignored?: unknown } } };
    const result = callConfigHook({ root }, { mode: 'development' });
    const ignored = result?.server?.watch?.ignored;
    expect(ignored).toEqual(expect.arrayContaining([
      join(root, '.drawit', 'interpret-captures'),
    ]));
  });

  it('creates no record for a rejected request', async () => {
    const records: InterpretCaptureRecord[] = [];
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1', 'on'),
      capture: (record) => {
        records.push(record);
      },
    });
    const response = await fetch(`${app.url}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: { lens: 'wrong' } }),
    });
    expect(response.status).toBe(400);
    expect(records).toHaveLength(0);
  });
});
