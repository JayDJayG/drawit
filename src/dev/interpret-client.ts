import type {
  CanvasAdapter,
  ModelCancellationReason,
} from '../canvas/excalidraw/CanvasAdapter';
import type { ModelSceneSnapshot } from '../canvas/excalidraw/types';
import type { T0NativeNode } from '../perception/t0';
import { snapEndpoint } from '../perception/t0';
import {
  tidyConnectorAxis,
  tidyConnectorPath,
  type ConnectorBoundNode,
} from '../core/geometry';
import type {
  NodeRef,
  ShapeSuggestionItem,
  SuggestionPlan,
} from '../core/suggestions';
import {
  aliasInterpretRequest,
  buildInterpretRequest,
  DEFAULT_INTERPRET_LIMITS,
  layoutSetOfMark,
  validateT0Plan,
  validateInterpretResponse,
  unaliasInterpretPlan,
  type InterpretRequest,
} from '../perception/interpret';
import { groundConnectorEndpoints } from '../perception/interpret/grounding';

export type InterpretStatusResponse = {
  configured: boolean;
  reason?: string;
  provider: 'deepseek';
  model: string;
  images: boolean;
  jsonMode: true;
};

export type InterpretSuccessResponse = {
  ok: true;
  plan: unknown;
  model: string;
  latencyMs: number;
  usage: Record<string, unknown> | null;
  dropped?: number;
};

export type InterpretUiState = {
  available: boolean;
  busy: boolean;
  configured?: boolean;
  reason?: string;
  images?: boolean;
  model?: string;
};

export type InterpretClientStateListener = (state: InterpretUiState) => void;

export type InterpretClientTransport = {
  getStatus: (signal?: AbortSignal) => Promise<InterpretStatusResponse>;
  interpret: (
    request: InterpretRequest,
    signal?: AbortSignal,
  ) => Promise<InterpretSuccessResponse>;
};

export type InterpretClientOptions = {
  onStateChange?: InterpretClientStateListener;
  transport?: InterpretClientTransport;
};

export type InterpretClientController = {
  start: () => Promise<void>;
  cancel: (message?: string) => void;
  refreshStatus: () => Promise<void>;
  getState: () => InterpretUiState;
};

export class DevInterpretError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'DevInterpretError';
    this.code = code;
    this.status = status;
  }
}

export const getStatus = async (
  signal?: AbortSignal,
): Promise<InterpretStatusResponse> => {
  const response = await fetch(routeUrl('status'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  return parseStatusResponse(response);
};

export const interpret = async (
  request: InterpretRequest,
  signal?: AbortSignal,
): Promise<InterpretSuccessResponse> => {
  const response = await fetch(routeUrl(''), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ request }),
    signal,
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !payload || payload.ok !== true) {
    throw new DevInterpretError(
      typeof payload?.code === 'string' ? payload.code : 'network',
      typeof payload?.message === 'string'
        ? payload.message
        : 'The local Interpret server returned an invalid response.',
      response.status,
    );
  }
  return {
    ok: true,
    plan: payload.plan,
    model: typeof payload.model === 'string' ? payload.model : '',
    latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : 0,
    usage: isRecord(payload.usage) ? payload.usage : null,
    dropped: nonNegativeInteger(payload.dropped),
  };
};

export const createInterpretController = (
  adapter: CanvasAdapter,
  onStateChangeOrOptions?: InterpretClientStateListener | InterpretClientOptions,
  transportOverride?: InterpretClientTransport,
): InterpretClientController => {
  const onStateChange = typeof onStateChangeOrOptions === 'function'
    ? onStateChangeOrOptions
    : onStateChangeOrOptions?.onStateChange;
  const transport = transportOverride
    ?? (typeof onStateChangeOrOptions === 'function'
      ? defaultTransport
      : onStateChangeOrOptions?.transport ?? defaultTransport);
  let nextRequestId = 0;
  let active: {
    id: number;
    controller: AbortController;
    snapshot: ModelSceneSnapshot;
  } | undefined;
  let state: InterpretUiState = {
    available: true,
    busy: false,
  };

  const publish = (next: Partial<InterpretUiState>) => {
    state = { ...state, ...next };
    onStateChange?.(state);
  };

  const cancel = (
    message = 'Interpret cancelled.',
    silent = false,
  ) => {
    if (!active) {
      return;
    }
    active.controller.abort();
    active = undefined;
    nextRequestId += 1;
    publish({ busy: false });
    if (!silent) {
      adapter.setModelStatus(message, 'dismissed');
    }
  };

  const refreshStatus = async () => {
    try {
      const status = await transport.getStatus();
      publish({
        available: true,
        configured: status.configured,
        reason: status.reason,
        images: status.images,
        model: status.model,
      });
    } catch {
      publish({
        available: true,
        configured: false,
        reason: 'The local Interpret server is not available. Start npm run dev and try again.',
      });
    }
  };

  const start = async () => {
    cancel();
    adapter.dismissPreview();
    const id = ++nextRequestId;
    const controller = new AbortController();
    const scene = adapter.getModelInput();
    if (scene.input.strokes.length === 0 && scene.input.texts.length === 0) {
      adapter.setModelStatus(
        'Nothing to interpret yet — draw shapes, arrows or labels first.',
        'nothing-to-improve',
      );
      return;
    }
    if (
      scene.input.strokes.length > DEFAULT_INTERPRET_LIMITS.maxStrokes
      || scene.input.texts.length > DEFAULT_INTERPRET_LIMITS.maxTexts
    ) {
      adapter.setModelStatus(
        'Interpret works on up to 128 strokes and 64 text boxes. Select part of the drawing and press Interpret again.',
        'error',
      );
      return;
    }
    let aliased;
    try {
      const bounded = buildInterpretRequest({
        ...scene.input,
        t0Plan: scene.input.t0Plan ?? null,
      });
      aliased = aliasInterpretRequest(bounded);
      const t0Validation = validateT0Plan(
        aliased.request.t0Plan,
        aliased.request.strokes,
        aliased.request.texts,
      );
      aliased = {
        ...aliased,
        request: {
          ...aliased.request,
          t0Plan: t0Validation.ok ? t0Validation.plan : null,
        },
      };
    } catch (error) {
      adapter.setModelStatus(
        'The drawing could not be prepared for Interpret. Try selecting part of it and press Interpret again.',
        'error',
      );
      return;
    }
    active = {
      id,
      controller,
      snapshot: scene.snapshot,
    };
    publish({ busy: true });
    adapter.setModelStatus('Interpreting your drawing…', 'idle');

    try {
      const status = await transport.getStatus(controller.signal);
      if (!isCurrent(id)) {
        return;
      }
      publish({
        configured: status.configured,
        reason: status.reason,
        images: status.images,
        model: status.model,
      });
      if (!status.configured) {
        active = undefined;
        publish({ busy: false });
        adapter.setModelStatus(
          status.reason ?? 'Add DEEPSEEK_API_KEY to .env.local, then press Interpret again.',
          'error',
        );
        return;
      }

      let request = aliased.request;
      let imageMessage = '';
      if (status.images) {
        const image = await renderSetOfMarkImage(request);
        if (image && image.length <= DEFAULT_INTERPRET_LIMITS.maxImageLength) {
          request = { ...request, image };
        } else {
          imageMessage = image
            ? ' (text only; the marked image was too large)'
            : ' (text only; the marked image could not be rendered)';
        }
      } else {
        imageMessage = ' (text only; this model has no image input)';
      }
      if (!isCurrent(id)) {
        return;
      }
      adapter.setModelStatus(`Interpreting your drawing…${imageMessage}`, 'idle');
      const result = await transport.interpret(request, controller.signal);
      if (!isCurrent(id)) {
        return;
      }
      if (!adapter.isModelSnapshotCurrent(scene.snapshot)) {
        cancel('The drawing changed while Interpret was working. Press Interpret again.');
        return;
      }
      const validation = validateInterpretResponse(result.plan, request);
      if (!validation.ok) {
        adapter.setModelStatus(
          formatValidationMessage(validation.errors),
          'error',
        );
        return;
      }
      const grounded = groundConnectorEndpoints(validation.plan, request);
      const tidied = tidyInterpretPlan(
        grounded,
        scene.nativeNodes ?? [],
      );
      const plan = unaliasInterpretPlan(tidied, aliased.aliases);
      const skipped = (result.dropped ?? 0) + validation.dropped.length;
      const shown = adapter.showModelPlan(
        plan,
        scene.snapshot,
        { label: 'Interpret', skipped },
      );
      if (!shown.shown) {
        adapter.setModelStatus(
          shown.reason === 'stale'
            ? 'The drawing changed while Interpret was working. Press Interpret again.'
            : 'Interpret had no suggestions.',
          shown.reason === 'stale' ? 'dismissed' : 'nothing-to-improve',
        );
      }
    } catch (error) {
      if (!isCurrent(id)) {
        return;
      }
      if (isAbortError(error) || (error instanceof DevInterpretError && error.code === 'cancelled')) {
        return;
      }
      adapter.setModelStatus(
        error instanceof DevInterpretError
          ? formatTransportError(error)
          : 'The local Interpret request failed. Try again.',
        'error',
      );
    } finally {
      if (isCurrent(id)) {
        active = undefined;
        publish({ busy: false });
      }
    }
  };

  const isCurrent = (id: number): boolean => {
    return active?.id === id;
  };

  if (typeof window !== 'undefined') {
    void refreshStatus();
    window.addEventListener('focus', () => {
      void refreshStatus();
    });
  }

  const controllerApi: InterpretClientController = {
    start,
    cancel,
    refreshStatus,
    getState: () => state,
  };
  adapter.setModelCancellationHandler((reason: ModelCancellationReason) => {
    if (reason === 'superseded') {
      cancel('Interpret cancelled.', true);
      return;
    }
    cancel(
      reason === 'escape'
        ? 'Interpret cancelled.'
        : 'The drawing changed while Interpret was working. Press Interpret again.',
    );
  });
  return controllerApi;
};

const parseStatusResponse = async (
  response: Response,
): Promise<InterpretStatusResponse> => {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !payload || typeof payload.configured !== 'boolean') {
    throw new DevInterpretError(
      typeof payload?.code === 'string' ? payload.code : 'network',
      typeof payload?.message === 'string'
        ? payload.message
        : 'The local Interpret status could not be read.',
      response.status,
    );
  }
  return payload as InterpretStatusResponse;
};

const defaultTransport: InterpretClientTransport = {
  getStatus,
  interpret,
};

const routeUrl = (suffix: string): string => {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}api/interpret${suffix ? `/${suffix}` : ''}`;
};

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
};

const formatValidationMessage = (errors: readonly string[]): string => {
  const prefix = "DeepSeek's answer didn't fit the drawing, so nothing changed. Try again. Details: ";
  return `${prefix}${errors.slice(0, 3).join('; ')}`.slice(0, 300);
};

const formatTransportError = (error: DevInterpretError): string => {
  if (error.code === 'invalid-answer') {
    return error.message;
  }
  switch (error.code) {
    case 'bad-request':
      return 'The drawing could not be prepared for Interpret. Try selecting part of it and press Interpret again.';
    case 'auth':
      return 'DeepSeek rejected the API key.';
    case 'balance':
      return 'DeepSeek account balance is empty.';
    case 'rate-limited':
      return 'DeepSeek is rate-limiting requests. Try again later.';
    case 'upstream-rejected':
      return 'DeepSeek rejected the request.';
    case 'unavailable':
      return 'DeepSeek is temporarily unavailable.';
    case 'timeout':
      return 'DeepSeek took too long to answer. Try again.';
    case 'empty-answer':
      return 'DeepSeek returned an empty answer. Try again.';
    case 'truncated':
      return 'DeepSeek truncated the JSON answer. Try again with a smaller drawing.';
    case 'internal':
      return 'The local Interpret server failed. Check the terminal and try again.';
    default:
      return 'The local Interpret request failed. Try again.';
  }
};

const tidyInterpretPlan = (
  plan: SuggestionPlan,
  nativeNodes: readonly T0NativeNode[] = [],
): SuggestionPlan => {
  const planNodes = plan.items
    .filter((item): item is ShapeSuggestionItem => item.kind === 'shape')
    .map((item) => ({
      ref: { itemId: item.id } as const,
      kind: item.shape,
      bounds: {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      },
    }));
  const sceneNodes = nativeNodes.map((node) => ({
    ref: { elementId: node.id } as const,
    kind: node.kind,
    bounds: { ...node.bounds },
  }));
  const candidates = [...planNodes, ...sceneNodes];
  let changed = false;
  const items = plan.items.map((item) => {
    if (item.kind !== 'connector') {
      return item;
    }
    const samples = item.points.map(([x, y]) => ({ x, y }));
    const path = tidyConnectorPath(samples);
    let start = item.start;
    let end = item.end;
    let points = path;
    if (!start) {
      const match = snapEndpoint(points[0], points[1], candidates);
      if (match) {
        start = match.ref;
        points[0] = match.point;
      }
    }
    if (!end) {
      const lastIndex = points.length - 1;
      const match = snapEndpoint(points[lastIndex], points[lastIndex - 1], candidates);
      if (match) {
        end = match.ref;
        points[lastIndex] = match.point;
      }
    }
    const axisPoints = tidyConnectorAxis(
      points,
      samples,
      {
        start: findBoundNode(start, candidates),
        end: findBoundNode(end, candidates),
      },
    );
    const next = {
      ...item,
      points: axisPoints.map((point) => [point.x, point.y] as [number, number]),
      start,
      end,
    };
    if (JSON.stringify(next) !== JSON.stringify(item)) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...plan, items } : plan;
};

const findBoundNode = (
  ref: NodeRef | null,
  nodes: readonly ({
    ref: NodeRef;
    kind: ConnectorBoundNode['kind'];
    bounds: ConnectorBoundNode['bounds'];
  })[],
): ConnectorBoundNode | undefined => {
  if (!ref) {
    return undefined;
  }
  const node = nodes.find((candidate) => (
    'itemId' in ref && 'itemId' in candidate.ref
      ? ref.itemId === candidate.ref.itemId
      : 'elementId' in ref && 'elementId' in candidate.ref
        ? ref.elementId === candidate.ref.elementId
        : false
  ));
  return node ? { kind: node.kind, bounds: node.bounds } : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const nonNegativeInteger = (value: unknown): number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
};

const renderSetOfMarkImage = async (
  request: InterpretRequest,
): Promise<string | undefined> => {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const layout = layoutSetOfMark(request);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context) {
    return undefined;
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, layout.width, layout.height);
  context.strokeStyle = '#30343b';
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  for (const stroke of layout.strokes) {
    const first = stroke.points[0];
    if (!first) {
      continue;
    }
    context.beginPath();
    context.moveTo(first.x, first.y);
    stroke.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.stroke();
  }
  context.font = '12px sans-serif';
  context.textBaseline = 'top';
  for (const text of layout.texts) {
    context.strokeStyle = '#30343b';
    context.lineWidth = 1;
    context.strokeRect(text.x, text.y, text.width, text.height);
    context.fillStyle = '#30343b';
    context.fillText(text.text.slice(0, 200), text.x + 3, text.y + 3, Math.max(1, text.width - 6));
  }
  for (const mark of layout.marks) {
    context.fillStyle = '#153e75';
    context.fillRect(mark.x, mark.y, mark.width, mark.height);
    context.fillStyle = '#ffffff';
    context.fillText(mark.label, mark.x + 4, mark.y + 3);
  }
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
};
