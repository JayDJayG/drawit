import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildInterpretRequest,
  DEFAULT_INTERPRET_LIMITS,
  INTERPRET_BODY_LIMIT_BYTES,
  validateT0Plan,
  validateInterpretResponse,
  type CompleteInterpretProvider,
  type InterpretRequest,
  type InterpretUsage,
} from '../../src/perception/interpret';
import {
  getDeepSeekStatus,
  NO_KEY_MESSAGE,
  type DeepSeekConfig,
} from './config';
import {
  createDeepSeekProvider,
  InterpretError,
  type InterpretErrorCode,
} from './deepseek-provider';
import type {
  InterpretCaptureRecord,
  InterpretCaptureWriter,
} from './capture';
import type { SuggestionPlan } from '../../src/core/suggestions';

export type InterpretRouteLogger = {
  info: (message: string) => void;
};

export type InterpretRouteState = {
  busy: boolean;
};

export type InterpretRouteDeps = {
  loadConfig: () => DeepSeekConfig;
  createProvider?: (config: DeepSeekConfig) => CompleteInterpretProvider;
  logger?: InterpretRouteLogger;
  capture?: InterpretCaptureWriter;
  now?: () => number;
  state?: InterpretRouteState;
};

export const createInterpretRouteState = (): InterpretRouteState => ({
  busy: false,
});

const fallbackStates = new WeakMap<object, InterpretRouteState>();

export const handleInterpretRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  deps: InterpretRouteDeps,
): Promise<void> => {
  const startedAt = deps.now?.() ?? Date.now();
  const logger = deps.logger ?? { info: () => undefined };

  const respond = (
    status: number,
    code: InterpretErrorCode | 'bad-request' | 'forbidden' | 'method-not-allowed' | 'unsupported-media-type' | 'payload-too-large' | 'busy' | 'not-configured' | 'ok',
    message: string,
    usage?: InterpretUsage,
    logOptions?: InterpretLogOptions,
  ) => {
    logRequest(logger, startedAt, deps.now, status, code, usage, logOptions);
    sendJson(res, status, {
      ok: code === 'ok',
      ...(code === 'ok'
        ? {}
        : { code, message }),
    });
  };

  const rejectSecurity = validateSecurity(req);
  if (rejectSecurity) {
    respond(rejectSecurity.status, rejectSecurity.code, rejectSecurity.message);
    return;
  }
  const endpoint = endpointFromUrl(req.url);
  const state = deps.state
    ?? getFallbackState(deps);

  if (endpoint === 'status') {
    if (req.method !== 'GET') {
      respond(405, 'method-not-allowed', 'Use GET for Interpret status.');
      return;
    }
    let config: DeepSeekConfig;
    try {
      config = deps.loadConfig();
    } catch {
      sendInternalError(res, logger, startedAt, deps.now);
      return;
    }
    logRequest(logger, startedAt, deps.now, 200, 'ok');
    sendJson(res, 200, getDeepSeekStatus(config));
    return;
  }

  if (endpoint !== 'interpret') {
    respond(404, 'bad-request', 'The Interpret route was not found.');
    return;
  }

  if (req.method !== 'POST') {
    respond(405, 'method-not-allowed', 'Use POST to interpret a drawing.');
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    respond(415, 'unsupported-media-type', 'Interpret requests must use application/json.');
    return;
  }

  const bodyResult = await readJsonBody(req);
  if (bodyResult.kind === 'too-large') {
    respond(413, 'payload-too-large', 'The Interpret request is too large.');
    return;
  }
  if (bodyResult.kind === 'aborted') {
    logRequest(logger, startedAt, deps.now, 499, 'cancelled');
    return;
  }
  if (bodyResult.kind === 'error') {
    respond(400, 'bad-request', 'The Interpret request body could not be read.');
    return;
  }

  let config: DeepSeekConfig;
  let request: InterpretRequest;
  try {
    config = deps.loadConfig();
  } catch {
    sendInternalError(res, logger, startedAt, deps.now);
    return;
  }
  try {
    request = validatePostedRequest(bodyResult.value);
  } catch (error) {
    respond(400, 'bad-request', error instanceof Error ? error.message : 'The Interpret request was invalid.');
    return;
  }

  if (!config.configured) {
    respond(503, 'not-configured', config.reason ?? NO_KEY_MESSAGE);
    return;
  }
  if (state.busy) {
    respond(429, 'busy', 'Another Interpret request is still running. Wait for it to finish or cancel it.');
    return;
  }

  state.busy = true;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      state.busy = false;
    }
  };
  const controller = new AbortController();
  let disconnected = false;
  let timedOut = false;
  const onClose = () => {
    if (!res.writableFinished) {
      disconnected = true;
      release();
      controller.abort();
    }
  };
  res.once('close', onClose);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  try {
    const provider = (deps.createProvider ?? createDeepSeekProvider)(config);
    const completion = await provider.complete(request, {
      signal: controller.signal,
    });
    if (disconnected) {
      return;
    }
    const validation = validateInterpretResponse(completion.content, request);
    if (!validation.ok) {
      const latencyMs = requestLatency(startedAt, deps.now);
      respond(
        422,
        'invalid-answer',
        formatValidationMessage(validation.errors),
        completion.usage,
        {
          errors: validation.errors,
          finishReason: completion.finishReason,
          latencyMs,
        },
      );
      if (config.capture) {
        scheduleCapture(
          logger,
          deps.capture,
          createCaptureRecord(
            config,
            request,
            completion,
            latencyMs,
            { status: 422, code: 'invalid-answer', errors: validation.errors },
            deps.now,
          ),
        );
      }
      return;
    }
    const latencyMs = requestLatency(startedAt, deps.now);
    logRequest(
      logger,
      startedAt,
      deps.now,
      200,
      'ok',
      completion.usage,
      { finishReason: completion.finishReason, latencyMs },
    );
    sendJson(res, 200, {
      ok: true,
      plan: validation.plan,
      model: completion.model || config.model,
      latencyMs,
      usage: completion.usage ?? null,
    });
    if (config.capture) {
      scheduleCapture(
        logger,
        deps.capture,
        createCaptureRecord(
          config,
          request,
          completion,
          latencyMs,
          { status: 200, code: 'ok' },
          deps.now,
          validation.plan,
        ),
      );
    }
  } catch (error) {
    if (disconnected) {
      logRequest(logger, startedAt, deps.now, 499, 'cancelled');
      return;
    }
    const interpreted = error instanceof InterpretError
      ? error
      : timedOut
        ? new InterpretError('timeout', 'DeepSeek took too long to answer.')
        : new InterpretError('network', 'The DeepSeek request could not be completed.');
    if (timedOut && interpreted.code === 'cancelled') {
      sendError(
        res,
        logger,
        startedAt,
        deps.now,
        504,
        'timeout',
        'DeepSeek took too long to answer. Try again.',
      );
      return;
    }
    const status = statusForError(interpreted.code);
    respond(status, interpreted.code, interpreted.message);
  } finally {
    clearTimeout(timeout);
    res.removeListener('close', onClose);
    release();
  }
};

export const validatePostedRequest = (
  body: unknown,
): InterpretRequest => {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'request')) {
    throw new Error('The request body must contain only a request object.');
  }
  if (!isRecord(body.request)) {
    throw new Error('request must be an object.');
  }
  const request = body.request as Record<string, unknown>;
  if (request.lens !== 'diagram') {
    throw new Error('request.lens must be diagram.');
  }
  const strokes = validateStrokes(request.strokes);
  const texts = validateTexts(request.texts);
  if (request.image !== undefined) {
    validatePngDataUrl(request.image);
  }
  if (request.intent !== undefined) {
    validateIntent(request.intent);
  }

  const input: InterpretRequest = {
    lens: 'diagram',
    strokes,
    texts,
    t0Plan: request.t0Plan === null || request.t0Plan === undefined
      ? null
      : request.t0Plan as InterpretRequest['t0Plan'],
    ...(typeof request.image === 'string' ? { image: request.image } : {}),
    ...(typeof request.intent === 'string' ? { intent: request.intent } : {}),
  };
  const canonical = buildInterpretRequest(input, DEFAULT_INTERPRET_LIMITS);
  const t0Result = validateT0Plan(canonical.t0Plan, canonical.strokes, canonical.texts);
  if (!t0Result.ok) {
    throw new Error(t0Result.errors.slice(0, 3).join('; '));
  }
  const validated = {
    ...canonical,
    t0Plan: t0Result.plan,
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify({ request: validated }), 'utf8');
  if (encodedBytes > INTERPRET_BODY_LIMIT_BYTES) {
    throw new Error('The Interpret request exceeds the serialized size limit.');
  }
  return validated;
};

const validateStrokes = (value: unknown): InterpretRequest['strokes'] => {
  if (!Array.isArray(value) || value.length > DEFAULT_INTERPRET_LIMITS.maxStrokes) {
    throw new Error(`request.strokes must contain at most ${DEFAULT_INTERPRET_LIMITS.maxStrokes} strokes.`);
  }
  const ids = new Set<string>();
  let totalPoints = 0;
  return value.map((rawStroke, index) => {
    if (!isRecord(rawStroke)) {
      throw new Error(`request.strokes[${index}] must be an object.`);
    }
    const id = readAliasId(rawStroke.id, `request.strokes[${index}].id`, 's');
    if (ids.has(id)) {
      throw new Error(`request.strokes contains duplicate alias "${id}".`);
    }
    ids.add(id);
    if (!Array.isArray(rawStroke.points) || rawStroke.points.length > DEFAULT_INTERPRET_LIMITS.maxPointsPerStroke) {
      throw new Error(`request.strokes[${index}].points exceeds the point limit.`);
    }
    totalPoints += rawStroke.points.length;
    if (totalPoints > DEFAULT_INTERPRET_LIMITS.maxTotalPoints) {
      throw new Error(`request.strokes exceeds the total point limit.`);
    }
    const points = rawStroke.points.map((rawPoint, pointIndex) => {
      if (!isRecord(rawPoint)) {
        throw new Error(`request.strokes[${index}].points[${pointIndex}] must be an object.`);
      }
      return {
        x: readCoordinate(rawPoint.x, `request.strokes[${index}].points[${pointIndex}].x`),
        y: readCoordinate(rawPoint.y, `request.strokes[${index}].points[${pointIndex}].y`),
      };
    });
    return { id, points };
  });
};

const validateTexts = (value: unknown): InterpretRequest['texts'] => {
  if (!Array.isArray(value) || value.length > DEFAULT_INTERPRET_LIMITS.maxTexts) {
    throw new Error(`request.texts must contain at most ${DEFAULT_INTERPRET_LIMITS.maxTexts} texts.`);
  }
  const ids = new Set<string>();
  let totalTextLength = 0;
  return value.map((rawText, index) => {
    if (!isRecord(rawText)) {
      throw new Error(`request.texts[${index}] must be an object.`);
    }
    const id = readAliasId(rawText.id, `request.texts[${index}].id`, 't');
    if (ids.has(id)) {
      throw new Error(`request.texts contains duplicate alias "${id}".`);
    }
    ids.add(id);
    if (typeof rawText.text !== 'string' || rawText.text.length > DEFAULT_INTERPRET_LIMITS.maxTextLength) {
      throw new Error(`request.texts[${index}].text exceeds the text limit.`);
    }
    totalTextLength += rawText.text.length;
    if (totalTextLength > DEFAULT_INTERPRET_LIMITS.maxTotalTextLength) {
      throw new Error('request.texts exceeds the total text limit.');
    }
    return {
      id,
      text: rawText.text,
      x: readCoordinate(rawText.x, `request.texts[${index}].x`),
      y: readCoordinate(rawText.y, `request.texts[${index}].y`),
      width: readNonNegativeCoordinate(rawText.width, `request.texts[${index}].width`),
      height: readNonNegativeCoordinate(rawText.height, `request.texts[${index}].height`),
    };
  });
};

const validatePngDataUrl = (value: unknown) => {
  if (typeof value !== 'string' || value.length > DEFAULT_INTERPRET_LIMITS.maxImageLength) {
    throw new Error('request.image exceeds the image limit.');
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 === 1) {
    throw new Error('request.image must be a valid PNG data URL.');
  }
  const bytes = Buffer.from(match[1], 'base64');
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length || !signature.every((byte, index) => bytes[index] === byte)) {
    throw new Error('request.image must contain PNG bytes.');
  }
};

const validateIntent = (value: unknown) => {
  if (typeof value !== 'string' || value.length > DEFAULT_INTERPRET_LIMITS.maxIntentLength) {
    throw new Error('request.intent exceeds the text limit.');
  }
};

const readAliasId = (
  value: unknown,
  path: string,
  prefix: 's' | 't',
): string => {
  if (
    typeof value !== 'string'
    || value.length > 32
    || !new RegExp(`^${prefix}[1-9]\\d*$`).test(value)
  ) {
    throw new Error(`${path} must be an alias such as ${prefix}1.`);
  }
  return value;
};

const readCoordinate = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new Error(`${path} must be a finite coordinate.`);
  }
  return value;
};

const readNonNegativeCoordinate = (value: unknown, path: string): number => {
  const result = readCoordinate(value, path);
  if (result < 0) {
    throw new Error(`${path} must not be negative.`);
  }
  return result;
};

export const validateSecurity = (
  req: IncomingMessage,
): { status: 403; code: 'forbidden'; message: string } | undefined => {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return {
      status: 403,
      code: 'forbidden',
      message: 'The Interpret route is available only from the local machine.',
    };
  }
  const host = parseAuthority(req.headers.host);
  if (!host || !isAllowedHost(host.hostname)) {
    return { status: 403, code: 'forbidden', message: 'The Interpret route is available only on the local development host.' };
  }
  const origin = req.headers.origin;
  if (origin && !isSameOrigin(origin, host)) {
    return { status: 403, code: 'forbidden', message: 'The request origin is not the local development server.' };
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && String(fetchSite).toLowerCase() !== 'same-origin') {
    return { status: 403, code: 'forbidden', message: 'The request must be same-origin.' };
  }
  return undefined;
};

export const isLoopbackAddress = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }
  if (value === '::1') {
    return true;
  }
  const normalized = value.toLowerCase();
  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized;
  const octets = ipv4.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) {
    return false;
  }
  const first = Number(octets[0]);
  return first === 127 && octets.every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
};

const parseAuthority = (
  value: string | string[] | undefined,
): { hostname: string; port: string } | undefined => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('@')) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return undefined;
    }
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
      port: parsed.port || '80',
    };
  } catch {
    return undefined;
  }
};

const isAllowedHost = (hostname: string): boolean => {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};

const isSameOrigin = (
  originValue: string,
  host: { hostname: string; port: string },
): boolean => {
  try {
    const origin = new URL(originValue);
    if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      return false;
    }
    const originHostname = origin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const originPort = origin.port || '80';
    return isAllowedHost(originHostname)
      && originHostname === host.hostname
      && originPort === host.port;
  } catch {
    return false;
  }
};

const endpointFromUrl = (
  value: string | undefined,
): 'status' | 'interpret' | 'unknown' => {
  try {
    const pathname = new URL(value ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/status')) {
      return 'status';
    }
    if (pathname.endsWith('/api/interpret')) {
      return 'interpret';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
};

const isJsonContentType = (value: string | string[] | undefined): boolean => {
  return typeof value === 'string'
    && value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
};

const readJsonBody = (
  req: IncomingMessage,
): Promise<
  | { kind: 'ok'; value: unknown }
  | { kind: 'too-large' }
  | { kind: 'aborted' }
  | { kind: 'error' }
> => {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > INTERPRET_BODY_LIMIT_BYTES) {
    req.pause();
    return Promise.resolve({ kind: 'too-large' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: Parameters<typeof resolve>[0]) => {
      if (settled) {
        return;
      }
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > INTERPRET_BODY_LIMIT_BYTES) {
        req.pause();
        finish({ kind: 'too-large' });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        finish({ kind: 'ok', value: JSON.parse(text) });
      } catch {
        finish({ kind: 'error' });
      }
    };
    const onError = () => finish({ kind: 'error' });
    const onAborted = () => finish({ kind: 'aborted' });
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
};

const statusForError = (code: InterpretErrorCode): number => {
  switch (code) {
    case 'auth':
      return 401;
    case 'balance':
      return 402;
    case 'rate-limited':
      return 429;
    case 'upstream-rejected':
    case 'invalid-answer':
    case 'empty-answer':
    case 'truncated':
      return code === 'upstream-rejected' ? 400 : 422;
    case 'timeout':
      return 504;
    case 'cancelled':
      return 499;
    case 'unavailable':
      return 503;
    case 'network':
    default:
      return 502;
  }
};

const sendError = (
  res: ServerResponse,
  logger: InterpretRouteLogger,
  startedAt: number,
  now: (() => number) | undefined,
  status: number,
  code: InterpretErrorCode,
  message: string,
) => {
  logRequest(logger, startedAt, now, status, code);
  sendJson(res, status, { ok: false, code, message });
};

const sendInternalError = (
  res: ServerResponse,
  logger: InterpretRouteLogger,
  startedAt: number,
  now: (() => number) | undefined,
) => {
  logRequest(logger, startedAt, now, 500, 'internal');
  sendJson(res, 500, {
    ok: false,
    code: 'internal',
    message: 'The local Interpret route failed. Check the terminal and try again.',
  });
};

const formatValidationMessage = (errors: readonly string[]): string => {
  const prefix = "DeepSeek's answer didn't fit the drawing, so nothing changed. Try again. Details: ";
  const details = errors.slice(0, 3).join('; ');
  return `${prefix}${details}`.slice(0, 300);
};

const sendJson = (
  res: ServerResponse,
  status: number,
  value: unknown,
) => {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  res.end(body);
};

const logRequest = (
  logger: InterpretRouteLogger,
  startedAt: number,
  now: (() => number) | undefined,
  status: number,
  code: string,
  usage?: InterpretUsage,
  options: InterpretLogOptions = {},
) => {
  const latencyMs = options.latencyMs
    ?? requestLatency(startedAt, now);
  const promptTokens = numericUsage(usage, 'prompt_tokens');
  const completionTokens = numericUsage(usage, 'completion_tokens');
  const details = code === 'invalid-answer'
    ? ` errors=${options.errors?.length ?? 0} detail=${JSON.stringify(
      (options.errors ?? []).slice(0, 3).join('; ').slice(0, 240),
    )}`
    : '';
  const finishReason = code === 'ok' || code === 'invalid-answer'
    ? sanitizeFinishReason(options.finishReason)
    : undefined;
  logger.info(
    `drawit interpret status=${status} code=${code} latencyMs=${latencyMs} promptTokens=${promptTokens} completionTokens=${completionTokens}${details}${finishReason ? ` finish=${finishReason}` : ''}`,
  );
};

type InterpretLogOptions = {
  errors?: readonly string[];
  finishReason?: string | null;
  latencyMs?: number;
};

const requestLatency = (
  startedAt: number,
  now: (() => number) | undefined,
): number => Math.max(0, Math.round((now?.() ?? Date.now()) - startedAt));

const sanitizeFinishReason = (
  value: string | null | undefined,
): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z_]+$/.test(sanitized) ? sanitized : undefined;
};

const createCaptureRecord = (
  config: DeepSeekConfig,
  request: InterpretRequest,
  completion: {
    content: string;
    finishReason: string | null;
    usage?: InterpretUsage;
    model: string;
  },
  latencyMs: number,
  outcome: InterpretCaptureRecord['outcome'],
  now: (() => number) | undefined,
  plan?: SuggestionPlan,
): InterpretCaptureRecord => ({
  version: 1,
  capturedAt: new Date(now?.() ?? Date.now()).toISOString(),
  outcome: {
    status: outcome.status,
    code: outcome.code,
    ...(outcome.errors ? { errors: outcome.errors.slice(0, 50) } : {}),
  },
  latencyMs,
  usage: completion.usage ?? null,
  finishReason: completion.finishReason ?? null,
  model: completion.model || config.model,
  settings: {
    model: config.model,
    images: config.images,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  },
  request,
  rawContent: completion.content,
  ...(plan ? { plan } : {}),
});

const scheduleCapture = (
  logger: InterpretRouteLogger,
  capture: InterpretCaptureWriter | undefined,
  record: InterpretCaptureRecord,
): void => {
  if (!capture) {
    return;
  }
  Promise.resolve()
    .then(() => capture(record))
    .catch((error: unknown) => {
      const code = typeof error === 'object'
        && error !== null
        && 'code' in error
        && typeof error.code === 'string'
        && error.code.length > 0
        ? error.code
        : 'unknown';
      logger.info(`drawit interpret capture failed code=${code}`);
    });
};

const numericUsage = (
  usage: InterpretUsage | undefined,
  key: 'prompt_tokens' | 'completion_tokens',
): number => {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const getFallbackState = (
  deps: InterpretRouteDeps,
): InterpretRouteState => {
  const key = deps as unknown as object;
  const existing = fallbackStates.get(key);
  if (existing) {
    return existing;
  }
  const state = createInterpretRouteState();
  fallbackStates.set(key, state);
  return state;
};

const isRecord = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
