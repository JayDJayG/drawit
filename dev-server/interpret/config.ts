export const NO_KEY_MESSAGE =
  'Add DEEPSEEK_API_KEY to .env.local, then press Interpret again.';

const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_TIMEOUT_MS = 60_000;

export type DeepSeekThinking = 'enabled' | 'disabled';
export type DeepSeekReasoningEffort = 'low' | 'high' | 'max';

export type DeepSeekConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
  images: boolean;
  maxTokens: number;
  timeoutMs: number;
  thinking: DeepSeekThinking;
  reasoningEffort: DeepSeekReasoningEffort;
  configured: boolean;
  reason?: string;
};

export type DeepSeekStatus = {
  configured: boolean;
  reason?: string;
  provider: 'deepseek';
  model: string;
  images: boolean;
  jsonMode: true;
};

export const resolveDeepSeekConfig = (
  env: Record<string, string | undefined>,
): DeepSeekConfig => {
  const model = isValidModel(env.DEEPSEEK_MODEL)
    ? env.DEEPSEEK_MODEL!
    : DEFAULT_MODEL;
  const configuredBaseUrl = env.DEEPSEEK_BASE_URL?.trim();
  const baseUrlResult = parseBaseUrl(configuredBaseUrl || DEFAULT_BASE_URL);
  const imagesSetting = parseBoolean(env.DEEPSEEK_IMAGES);
  const images = model === 'deepseek-v4-pro'
    ? false
    : imagesSetting ?? (model === 'deepseek-flash');
  const maxTokens = parseBoundedInteger(
    env.DEEPSEEK_MAX_TOKENS,
    DEFAULT_MAX_TOKENS,
    1024,
    65_536,
  );
  const timeoutMs = parseBoundedInteger(
    env.DEEPSEEK_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1000,
    300_000,
  );
  const thinking = env.DEEPSEEK_THINKING === 'enabled'
    ? 'enabled'
    : 'disabled';
  const reasoningEffort = env.DEEPSEEK_REASONING_EFFORT === 'low'
    || env.DEEPSEEK_REASONING_EFFORT === 'high'
    || env.DEEPSEEK_REASONING_EFFORT === 'max'
    ? env.DEEPSEEK_REASONING_EFFORT
    : 'high';
  const apiKey = env.DEEPSEEK_API_KEY?.trim() ?? '';
  const reason = apiKey.length === 0
    ? NO_KEY_MESSAGE
    : baseUrlResult.error;

  return {
    apiKey,
    model,
    baseUrl: baseUrlResult.baseUrl,
    images,
    maxTokens,
    timeoutMs,
    thinking,
    reasoningEffort,
    configured: apiKey.length > 0 && !baseUrlResult.error,
    reason,
  };
};

export const getDeepSeekStatus = (
  config: DeepSeekConfig,
): DeepSeekStatus => ({
  configured: config.configured,
  ...(config.configured ? {} : { reason: config.reason ?? NO_KEY_MESSAGE }),
  provider: 'deepseek',
  model: config.model,
  images: config.images,
  jsonMode: true,
});

export const parseBaseUrl = (
  value: string,
): { baseUrl: string; error?: string } => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopbackHttp = url.protocol === 'http:'
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
    if (url.protocol !== 'https:' && !isLoopbackHttp) {
      return {
        baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
        error: 'DEEPSEEK_BASE_URL must use https, or http on the local loopback host.',
      };
    }
    if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
      return {
        baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
        error: 'DEEPSEEK_BASE_URL must not contain user info, a query, or a fragment.',
      };
    }
    return {
      baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
    };
  } catch {
    return {
      baseUrl: value,
      error: 'DEEPSEEK_BASE_URL is not a valid URL.',
    };
  }
};

const isValidModel = (value: string | undefined): boolean => {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
};

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
};

const parseBoundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};
