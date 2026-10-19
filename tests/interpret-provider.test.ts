import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  getDeepSeekStatus,
  resolveDeepSeekConfig,
  type DeepSeekConfig,
} from '../dev-server/interpret/config';
import {
  createDeepSeekProvider,
  InterpretError,
} from '../dev-server/interpret/deepseek-provider';
import type { InterpretRequest } from '../src/perception/interpret';

const TEST_KEY = `test-${randomUUID()}`;

const request: InterpretRequest = {
  lens: 'diagram',
  strokes: [{ id: 's1', points: [{ x: 0, y: 0 }, { x: 40, y: 40 }] }],
  texts: [{ id: 't1', text: 'Start', x: 4, y: 4, width: 30, height: 12 }],
  t0Plan: null,
};

const validConfig = (
  overrides: Partial<DeepSeekConfig> = {},
): DeepSeekConfig => ({
  apiKey: TEST_KEY,
  model: 'deepseek-flash',
  baseUrl: 'http://127.0.0.1:43210/v1',
  images: false,
  capture: false,
  maxTokens: 16_384,
  timeoutMs: 60_000,
  thinking: 'disabled',
  reasoningEffort: 'high',
  configured: true,
  ...overrides,
});

const jsonResponse = (
  payload: unknown,
  status = 200,
): Response => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('DeepSeek configuration and provider', () => {
  it('parses the opt-in capture setting without exposing it in status', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      const config = resolveDeepSeekConfig({
        DEEPSEEK_API_KEY: TEST_KEY,
        DRAWIT_INTERPRET_CAPTURE: value,
      });
      expect(config.capture).toBe(true);
      expect(getDeepSeekStatus(config)).not.toHaveProperty('capture');
    }
    for (const value of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(resolveDeepSeekConfig({
        DEEPSEEK_API_KEY: TEST_KEY,
        ...(value === undefined ? {} : { DRAWIT_INTERPRET_CAPTURE: value }),
      }).capture).toBe(false);
    }
  });

  it('applies model, image, token, timeout and thinking defaults safely', () => {
    const config = resolveDeepSeekConfig({
      DEEPSEEK_API_KEY: TEST_KEY,
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:4000/v1/',
      DEEPSEEK_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_IMAGES: 'true',
      DEEPSEEK_MAX_TOKENS: 'not-a-number',
      DEEPSEEK_TIMEOUT_MS: '0',
      DEEPSEEK_THINKING: 'enabled',
      DEEPSEEK_REASONING_EFFORT: 'max',
    });
    expect(config).toMatchObject({
      model: 'deepseek-v4-pro',
      baseUrl: 'http://127.0.0.1:4000/v1',
      images: false,
      maxTokens: 16_384,
      timeoutMs: 60_000,
      thinking: 'enabled',
      reasoningEffort: 'max',
      configured: true,
    });
  });

  it('rejects unsafe base URLs without silently changing the host', () => {
    for (const [baseUrl, expectedBaseUrl] of [
      ['http://example.test', 'http://example.test'],
      ['invalid-base-url', 'invalid-base-url'],
      ['ftp://example.test/path/', 'ftp://example.test/path'],
      ['https://example.test/path?key=value', 'https://example.test/path'],
      ['https://example.test/path#fragment', 'https://example.test/path'],
      ['not a URL', 'not a URL'],
      ['https://example.test/path?', 'https://example.test/path'],
      ['https://example.test/path#', 'https://example.test/path'],
    ]) {
      const config = resolveDeepSeekConfig({
        DEEPSEEK_API_KEY: TEST_KEY,
        DEEPSEEK_BASE_URL: baseUrl,
      });
      expect(config.configured).toBe(false);
      expect(config.baseUrl).toBe(expectedBaseUrl);
      expect(config.reason).toBeTruthy();
    }
  });

  it('uses the default base URL when the configured value is blank', () => {
    expect(resolveDeepSeekConfig({
      DEEPSEEK_API_KEY: TEST_KEY,
      DEEPSEEK_BASE_URL: '   ',
    }).baseUrl).toBe('https://api.deepseek.com');
  });

  it('sends the OpenAI-compatible request with optional image and thinking settings', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const provider = createDeepSeekProvider(
      validConfig({
        baseUrl: 'https://deepseek.test/v1',
        images: true,
        thinking: 'enabled',
        reasoningEffort: 'low',
        maxTokens: 2048,
      }),
      async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return jsonResponse({
          model: 'deepseek-flash',
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"version":1}' },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        });
      },
    );

    const completion = await provider.complete({
      ...request,
      image: 'data:image/png;base64,iVBORw0KGgo=',
    }, {});
    expect(capturedUrl).toBe('https://deepseek.test/v1/chat/completions');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.redirect).toBe('error');
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      response_format: { type: 'json_object' },
      max_tokens: 2048,
      stream: false,
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(body.messages[1].content).toEqual(expect.arrayContaining([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]));
    expect(completion).toMatchObject({
      content: '{"version":1}',
      finishReason: 'stop',
      model: 'deepseek-flash',
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
  });

  it('omits images and reasoning effort when disabled', async () => {
    let capturedBody: Record<string, any> | undefined;
    const provider = createDeepSeekProvider(
      validConfig({ thinking: 'disabled', images: false }),
      async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          choices: [{ finish_reason: null, message: { content: '{}' } }],
        });
      },
    );
    await provider.interpret({
      ...request,
      image: 'data:image/png;base64,iVBORw0KGgo=',
    }, {});
    expect(capturedBody?.thinking).toEqual({ type: 'disabled' });
    expect(capturedBody?.reasoning_effort).toBeUndefined();
    expect(capturedBody?.messages[1].content).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' }),
    ]));
  });

  it('maps upstream statuses and redacts the configured key', async () => {
    for (const [status, code] of [
      [400, 'upstream-rejected'],
      [401, 'auth'],
      [402, 'balance'],
      [422, 'upstream-rejected'],
      [429, 'rate-limited'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ] as const) {
      const provider = createDeepSeekProvider(
        validConfig(),
        async () => jsonResponse({
          error: { message: `bad ${TEST_KEY} from upstream` },
        }, status),
      );
      await expect(provider.complete(request, {})).rejects.toSatisfy((error: unknown) => {
        return error instanceof InterpretError
          && error.code === code
          && !error.message.includes(TEST_KEY)
          && error.message.includes('[redacted]');
      });
    }
  });

  it('reports empty, truncated, timeout, abort and network failures distinctly', async () => {
    const emptyProvider = createDeepSeekProvider(
      validConfig(),
      async () => jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '' } }],
      }),
    );
    await expect(emptyProvider.complete(request, {})).rejects.toMatchObject({
      code: 'empty-answer',
    });

    const truncatedProvider = createDeepSeekProvider(
      validConfig(),
      async () => jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: '{}' } }],
      }),
    );
    await expect(truncatedProvider.complete(request, {})).rejects.toMatchObject({
      code: 'truncated',
    });

    const timeoutProvider = createDeepSeekProvider(
      validConfig({ timeoutMs: 5 }),
      async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    );
    await expect(timeoutProvider.complete(request, {})).rejects.toMatchObject({
      code: 'timeout',
    });

    const abortController = new AbortController();
    const abortProvider = createDeepSeekProvider(
      validConfig(),
      async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    );
    const aborted = abortProvider.complete(request, { signal: abortController.signal });
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' });

    const networkProvider = createDeepSeekProvider(
      validConfig(),
      async () => {
        throw new Error('local stub failed');
      },
    );
    await expect(networkProvider.complete(request, {})).rejects.toMatchObject({
      code: 'network',
    });
  });
});
