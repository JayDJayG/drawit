import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
  resolveDeepSeekConfig,
  type DeepSeekConfig,
} from '../dev-server/interpret/config';
import {
  createInterpretRouteState,
  handleInterpretRequest,
  isLoopbackAddress,
  validateSecurity,
  type InterpretRouteDeps,
} from '../dev-server/interpret/route';
import type {
  CompleteInterpretProvider,
  InterpretCompletion,
  InterpretRequest,
} from '../src/perception/interpret';

const TEST_KEY = `test-${randomUUID()}`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const servers: Server[] = [];

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
    confidence: 0.9,
    reason: 'The stroke forms a box.',
  }],
  unresolved: [],
});

const completion = (content = validPlan): InterpretCompletion => ({
  content,
  finishReason: 'stop',
  model: 'deepseek-flash',
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
});

const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for the local test server.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const configFor = (baseUrl: string, apiKey = TEST_KEY): DeepSeekConfig => (
  resolveDeepSeekConfig({
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_IMAGES: 'false',
  })
);

const requestBody = (request: unknown = baseRequest) => JSON.stringify({ request });

const post = async (
  url: string,
  body: unknown = baseRequest,
  headers: Record<string, string> = {},
): Promise<Response> => fetch(`${url}/api/interpret`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...headers,
  },
  body: requestBody(body),
});

const rawStatus = async (
  url: string,
  headers: Record<string, string>,
): Promise<number> => {
  const parsed = new URL(`${url}/api/interpret/status`);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
};

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

describe('Interpret development route', () => {
  afterAll(async () => {
    await Promise.all(servers.map((server) => close(server)));
  });

  it('serves a validated success and re-reads configuration for status', async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_req, res) => {
      upstreamRequests += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'deepseek-flash',
        choices: [{ finish_reason: 'stop', message: { content: validPlan } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }));
    });
    const upstreamUrl = await listen(upstream);
    let configured = false;
    const logs: string[] = [];
    const app = await routeServer({
      loadConfig: () => configured
        ? configFor(upstreamUrl)
        : configFor(upstreamUrl, ''),
      logger: { info: (message) => logs.push(message) },
    });

    const before = await fetch(`${app.url}/api/interpret/status`);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      configured: false,
      provider: 'deepseek',
      jsonMode: true,
    });
    expect(JSON.stringify(await (await fetch(`${app.url}/api/interpret/status`)).json()))
      .not.toContain(TEST_KEY);

    configured = true;
    const response = await post(app.url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      plan: { tier: 't2', items: [{ id: 'shape-1' }] },
      model: 'deepseek-flash',
      latencyMs: expect.any(Number),
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
    expect(upstreamRequests).toBe(1);
    expect(logs.join('\n')).not.toContain(TEST_KEY);
    expect(logs.some((line) => line.includes('status=200') && line.includes('promptTokens=12'))).toBe(true);
  });

  it('enforces host, method, content type, origin and fetch-site checks', async () => {
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1'),
    });
    expect(await rawStatus(app.url, { Host: 'evil.example:4173' })).toBe(403);

    const wrongMethod = await fetch(`${app.url}/api/interpret`, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);

    const wrongContentType = await fetch(`${app.url}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(wrongContentType.status).toBe(415);

    const badOrigin = await post(app.url, baseRequest, { Origin: 'http://evil.example:4173' });
    expect(badOrigin.status).toBe(403);

    const badFetchSite = await post(app.url, baseRequest, { 'Sec-Fetch-Site': 'cross-site' });
    expect(badFetchSite.status).toBe(403);
  });

  it('allows only loopback remote addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.42.1.9')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.20')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);

    const request = (remoteAddress: string | undefined) => ({
      socket: { remoteAddress },
      headers: { host: 'localhost:4173' },
    }) as never;
    expect(validateSecurity(request('192.168.1.20'))?.status).toBe(403);
    expect(validateSecurity(request('::ffff:192.168.1.20'))?.status).toBe(403);
    expect(validateSecurity(request(undefined))?.status).toBe(403);
    expect(validateSecurity(request('127.0.0.1'))).toBeUndefined();
    expect(validateSecurity(request('::1'))).toBeUndefined();
    expect(validateSecurity(request('::ffff:127.0.0.1'))).toBeUndefined();
  });

  it('returns a generic JSON 500 when configuration loading fails', async () => {
    const logs: string[] = [];
    const app = await routeServer({
      loadConfig: () => {
        throw new Error('private config detail');
      },
      logger: { info: (message) => logs.push(message) },
    });
    const statusResponse = await fetch(`${app.url}/api/interpret/status`);
    expect(statusResponse.status).toBe(500);
    expect(await statusResponse.json()).toEqual({
      ok: false,
      code: 'internal',
      message: 'The local Interpret route failed. Check the terminal and try again.',
    });
    const postResponse = await post(app.url);
    expect(postResponse.status).toBe(500);
    expect(await postResponse.json()).toMatchObject({
      code: 'internal',
      message: 'The local Interpret route failed. Check the terminal and try again.',
    });
    expect(logs.join('\n')).not.toContain('private config detail');
  });

  it('rejects oversized and malformed bodies without a 500', async () => {
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1'),
    });
    const oversized = await fetch(`${app.url}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: { intent: 'x'.repeat(2 * 1024 * 1024) } }),
    });
    expect(oversized.status).toBe(413);

    const malformedJson = await fetch(`${app.url}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(malformedJson.status).toBe(400);

    const cases = [
      { ...baseRequest, strokes: [{ id: 'real-stroke', points: baseRequest.strokes[0]!.points }] },
      { ...baseRequest, strokes: [...baseRequest.strokes, { id: 's1', points: [] }] },
      { ...baseRequest, image: 'https://example.test/image.png' },
      { ...baseRequest, image: PNG.replace('iVBORw0KGgo=', 'aGVsbG8=') },
      {
        ...baseRequest,
        texts: Array.from({ length: 65 }, (_, index) => ({
          id: `t${index + 1}`,
          text: 'x',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        })),
      },
      { ...baseRequest, intent: 42 },
    ];
    for (const value of cases) {
      const response = await post(app.url, value);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('bad-request');
    }
  });

  it('returns not-configured before contacting the upstream', async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_req, res) => {
      upstreamRequests += 1;
      res.end();
    });
    const upstreamUrl = await listen(upstream);
    const app = await routeServer({
      loadConfig: () => configFor(upstreamUrl, ''),
    });
    const response = await post(app.url);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'not-configured',
      message: 'Add DEEPSEEK_API_KEY to .env.local, then press Interpret again.',
    });
    expect(upstreamRequests).toBe(0);
  });

  it('serializes only one upstream call and releases the busy slot', async () => {
    let release!: () => void;
    let providerCalls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: CompleteInterpretProvider = {
      id: 'stub',
      capabilities: { images: false, jsonMode: true },
      complete: async () => {
        providerCalls += 1;
        await gate;
        return completion();
      },
      interpret: async () => validPlan,
    };
    const app = await routeServer({
      loadConfig: () => configFor('http://127.0.0.1:1'),
      createProvider: () => provider,
    });
    const first = post(app.url);
    await waitFor(() => providerCalls === 1);
    const second = await post(app.url);
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe('busy');
    release();
    expect((await first).status).toBe(200);
    const third = await post(app.url);
    expect(third.status).toBe(200);
  });

  it('maps an invalid upstream answer to invalid-answer and aborts on disconnect', async () => {
    const invalidUpstream = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ version: 1, lens: 'diagram', tier: 't2', items: [], unresolved: [{ sourceIds: ['s1'], reason: 'x'.repeat(141) }] }) },
        }],
      }));
    });
    const invalidUrl = await listen(invalidUpstream);
    const invalidApp = await routeServer({
      loadConfig: () => configFor(invalidUrl),
    });
    const invalid = await post(invalidApp.url);
    expect(invalid.status).toBe(422);
    const invalidPayload = await invalid.json();
    expect(invalidPayload.code).toBe('invalid-answer');
    expect(invalidPayload.message).toMatch(/^DeepSeek's answer didn't fit the drawing/);
    expect(invalidPayload.message.length).toBeLessThanOrEqual(300);

    let upstreamAborted = false;
    let upstreamStarted = false;
    const slowUpstream = createServer((req, res) => {
      upstreamStarted = true;
      req.once('aborted', () => {
        upstreamAborted = true;
      });
      setTimeout(() => {
        if (!res.destroyed) {
          res.end(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: validPlan } }],
          }));
        }
      }, 500);
    });
    const slowUrl = await listen(slowUpstream);
    const slowApp = await routeServer({
      loadConfig: () => configFor(slowUrl),
    });
    const client = new AbortController();
    const pending = fetch(`${slowApp.url}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
      signal: client.signal,
    });
    await waitFor(() => upstreamStarted);
    client.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => upstreamAborted);
    const afterCancel = await post(slowApp.url);
    expect(afterCancel.status).toBe(200);
  });
});
