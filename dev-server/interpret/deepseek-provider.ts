import {
  buildInterpretPrompt,
  type CompleteInterpretProvider,
  type InterpretCompletion,
  type InterpretRequest,
  type InterpretUsage,
} from '../../src/perception/interpret';
import type { DeepSeekConfig } from './config';

export type InterpretErrorCode =
  | 'auth'
  | 'balance'
  | 'rate-limited'
  | 'upstream-rejected'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'empty-answer'
  | 'truncated'
  | 'invalid-answer';

export class InterpretError extends Error {
  readonly code: InterpretErrorCode;
  readonly status?: number;

  constructor(
    code: InterpretErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'InterpretError';
    this.code = code;
    this.status = status;
  }
}

export type DeepSeekProvider = CompleteInterpretProvider;

export const createDeepSeekProvider = (
  config: DeepSeekConfig,
  fetchImpl: typeof fetch = fetch,
): DeepSeekProvider => {
  const provider: DeepSeekProvider = {
    id: 'deepseek',
    capabilities: {
      images: config.images,
      jsonMode: true,
    },
    async complete(request, options = {}) {
      return completeRequest(config, request, options.signal, fetchImpl);
    },
    async interpret(request, options = {}) {
      const completion = await provider.complete(request, options);
      return completion.content;
    },
  };
  return provider;
};

const completeRequest = async (
  config: DeepSeekConfig,
  request: InterpretRequest,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<InterpretCompletion> => {
  if (signal?.aborted) {
    throw new InterpretError('cancelled', 'Interpret was cancelled.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  try {
    const response = await fetchImpl(
      makeCompletionsUrl(config.baseUrl),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages: buildInterpretPrompt(request, {
            images: config.images,
            jsonMode: true,
          }),
          response_format: { type: 'json_object' },
          max_tokens: config.maxTokens,
          stream: false,
          thinking: { type: config.thinking },
          ...(config.thinking === 'enabled'
            ? { reasoning_effort: config.reasoningEffort }
            : {}),
        }),
        redirect: 'error',
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw await upstreamError(response, config.apiKey);
    }

    const payload = await readJson(response);
    const choice = getFirstChoice(payload);
    const finishReason = typeof choice?.finish_reason === 'string'
      ? choice.finish_reason
      : null;
    if (finishReason === 'length') {
      throw new InterpretError(
        'truncated',
        'DeepSeek truncated the JSON answer. Try again with a smaller drawing.',
      );
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new InterpretError(
        'empty-answer',
        'DeepSeek returned an empty answer. Try again.',
      );
    }
    return {
      content,
      finishReason,
      usage: isUsage(payload?.usage) ? payload.usage : undefined,
      model: typeof payload?.model === 'string' ? payload.model : config.model,
    };
  } catch (error) {
    if (error instanceof InterpretError) {
      throw error;
    }
    if (timedOut) {
      throw new InterpretError(
        'timeout',
        'DeepSeek took too long to answer. Try again.',
      );
    }
    if (signal?.aborted || controller.signal.aborted) {
      throw new InterpretError('cancelled', 'Interpret was cancelled.');
    }
    throw new InterpretError(
      'network',
      'The DeepSeek request could not be completed. Check the local server and try again.',
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
};

const makeCompletionsUrl = (baseUrl: string): string => {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
};

const upstreamError = async (
  response: Response,
  apiKey: string,
): Promise<InterpretError> => {
  const payload = await readJson(response).catch(() => undefined);
  const upstreamMessage = typeof payload?.error?.message === 'string'
    ? redactSecret(payload.error.message, apiKey).slice(0, 200)
    : '';
  const suffix = upstreamMessage ? ` ${upstreamMessage}` : '';
  switch (response.status) {
    case 401:
      return new InterpretError('auth', `DeepSeek rejected the API key.${suffix}`, 401);
    case 402:
      return new InterpretError('balance', `DeepSeek account balance is empty.${suffix}`, 402);
    case 429:
      return new InterpretError('rate-limited', `DeepSeek is rate-limiting requests. Try again later.${suffix}`, 429);
    case 400:
    case 422:
      return new InterpretError('upstream-rejected', `DeepSeek rejected the request.${suffix}`, response.status);
    case 500:
    case 503:
      return new InterpretError('unavailable', `DeepSeek is temporarily unavailable.${suffix}`, response.status);
    default:
      return new InterpretError('network', `DeepSeek returned an unexpected status (${response.status}).${suffix}`, response.status);
  }
};

const readJson = async (response: Response): Promise<any> => {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InterpretError(
      'invalid-answer',
      'DeepSeek returned a response that was not valid JSON.',
    );
  }
};

const getFirstChoice = (payload: any): any => {
  return Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
};

const isUsage = (value: unknown): value is InterpretUsage => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const redactSecret = (value: string, secret: string): string => {
  if (!secret) {
    return value;
  }
  return value.split(secret).join('[redacted]');
};
