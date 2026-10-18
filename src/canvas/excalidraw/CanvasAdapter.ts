import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToSvg,
  newElementWith,
  ROUNDNESS,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import {
  acceptedSuggestionItems,
  getPlanSourceIds,
  hitTestPreviewItems,
  summarizeSuggestionPlan,
  type ConnectorSuggestionItem,
  type NodeRef,
  type ShapeSuggestionItem,
  type SuggestionItem,
  type SuggestionPlan,
  type SuggestionPoint,
} from '../../core/suggestions';
import { suggestDiagram } from '../../lenses/diagram';
import {
  generateMermaid,
  type DiagramModel,
  type MermaidOutput,
} from '../../lenses/diagram/mermaid';
import {
  applyElementSet,
  filterOutputElements,
  freedrawElementToStroke,
  getTargetFreedrawElements,
  isPreviewElement,
  markAsPreview,
  removePreviewElements,
  sceneSignature,
  setPreviewReview,
} from './scene-logic';
import {
  formatSuggestionStatus,
  getPendingContextMenuAction,
  getPendingKeyAction,
  matchesExcalidrawKey,
  StrokeSuggestionEngine,
  type SuggestionOperation,
} from './adapter-logic';
import { getElementText } from './text-logic';
import {
  bindArrowEndpoint,
  stabilizeBinding,
  synchronizeBindingMutuality,
  updateBoundPoint,
  type BindingGeometry,
} from './binding-logic';
import type {
  CanvasAdapterState,
  CanvasElement,
  DrawitStroke,
  NativeElementDraft,
  Point,
  SuggestionStatus,
} from './types';

type StateListener = (state: CanvasAdapterState) => void;

type PendingSuggestion = {
  plan: SuggestionPlan;
  rejectedItemIds: Set<string>;
  sourceSnapshots: Map<string, string>;
  operation?: SuggestionOperation;
};

type ExistingBinding = {
  arrowId: string;
  targetId: string;
  endpoint: 'start' | 'end';
};

type ConvertedPlan = {
  elements: OrderedExcalidrawElement[];
  existingBindings: ExistingBinding[];
};

const PREVIEW_COLOR = '#3659a8';
const NATIVE_COLOR = '#1f2937';

export class CanvasAdapter {
  private readonly suggestionEngine = new StrokeSuggestionEngine();
  private readonly api: ExcalidrawImperativeAPI;
  private readonly shellElement?: HTMLElement;
  private readonly listeners = new Set<StateListener>();
  private elements: readonly OrderedExcalidrawElement[] = [];
  private appState?: AppState;
  private files: BinaryFiles = {};
  private pending?: PendingSuggestion;
  private lastSceneSignature?: string;
  private state: CanvasAdapterState = {
    status: 'Draw a stroke to get started.',
    statusKind: 'idle',
    hasPendingSuggestion: false,
    canSuggest: false,
    canSuggestDiagram: false,
    canExport: false,
    selectedStrokeCount: 0,
  };

  constructor(api: ExcalidrawImperativeAPI, shellElement?: HTMLElement | null) {
    this.api = api;
    this.shellElement = shellElement ?? undefined;
    setTimeout(() => this.api.setActiveTool({ type: 'freedraw' }), 0);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  handleChange(
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) {
    const nextElements = elements;
    const nextSignature = sceneSignature(nextElements as unknown as CanvasElement[]);
    const sceneChanged = this.lastSceneSignature !== undefined
      && nextSignature !== this.lastSceneSignature;
    const openedOutputUi = Boolean(
      appState.openDialog
      || appState.openMenu
      || appState.contextMenu,
    );

    this.elements = nextElements;
    this.appState = appState;
    this.files = files;

    if (this.pending && (sceneChanged || openedOutputUi)) {
      this.dismissPreview(openedOutputUi ? 'Preview dismissed before saving or exporting.' : undefined);
    }

    this.lastSceneSignature = nextSignature;
    this.publishDerivedState();
  }

  suggest() {
    if (this.pending) {
      return;
    }

    const currentElements = this.getCurrentElements();
    const selectedElementIds = this.appState?.selectedElementIds ?? {};
    const targetElements = getTargetFreedrawElements(
      currentElements,
      selectedElementIds,
    );
    const hasSelection = currentElements.some((element) => {
      return selectedElementIds[element.id] && !element.isDeleted;
    });
    const strokes = targetElements
      .map((element) => freedrawElementToStroke(element))
      .filter((stroke): stroke is DrawitStroke => stroke !== undefined);
    const result = this.suggestionEngine.suggest(
      strokes,
      hasSelection ? 'selection' : targetElements.length > 0 ? 'last' : 'none',
    );

    if (result.kind !== 'ready') {
      const status = formatSuggestionStatus(result);
      this.setStatus(status.text, status.kind);
      return;
    }

    this.showPlan(result.operation.plan, currentElements, result.operation);
    const status = formatSuggestionStatus(result);
    this.setStatus(status.text, status.kind);
  }

  suggestDiagram() {
    if (this.pending) {
      return;
    }
    const currentElements = this.getCurrentElements();
    const plan = suggestDiagram(this.getDiagramInput(currentElements));
    if (plan.items.length === 0) {
      const unresolved = plan.unresolved.length;
      this.setStatus(
        unresolved > 0
          ? `Diagram: ${unresolved} ${unresolved === 1 ? 'stroke' : 'strokes'} left as drawn — no diagram elements found.`
          : 'Diagram: Nothing recognized yet — draw shapes and connectors first.',
        'nothing-to-improve',
      );
      return;
    }

    this.showPlan(plan, currentElements);
    this.setStatus(this.formatDiagramStatus(plan, new Set()), 'ready');
  }

  apply() {
    if (!this.pending) {
      return;
    }

    const pending = this.pending;
    const currentElements = this.getCurrentElements();
    if (!this.sourcesStillMatch(pending, currentElements)) {
      this.dismissPreview('That suggestion is no longer available.');
      return;
    }

    const accepted = acceptedSuggestionItems(pending.plan, pending.rejectedItemIds);
    this.pending = undefined;
    this.api.updateScene({
      elements: removePreviewElements(currentElements as unknown as CanvasElement[]) as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    if (accepted.length === 0) {
      this.setStatus('Nothing was applied — the preview was dismissed.', 'dismissed');
      this.publishDerivedState();
      return;
    }

    const acceptedPlan: SuggestionPlan = {
      ...pending.plan,
      items: accepted,
    };
    const converted = this.convertPlan(acceptedPlan, false, currentElements);
    let appliedElements = applyElementSet(
      currentElements as unknown as CanvasElement[],
      getPlanSourceIds(acceptedPlan),
      converted.elements as unknown as CanvasElement[],
      (element) => newElementWith(
        element as unknown as ExcalidrawElement,
        { isDeleted: true },
      ) as unknown as CanvasElement,
    );
    appliedElements = this.applyExistingBindings(appliedElements, converted.existingBindings);
    const convertedArrowIds = new Set(converted.elements
      .filter((element) => element.type === 'arrow')
      .map((element) => element.id));
    for (let iteration = 0; iteration < 3; iteration += 1) {
      appliedElements = reconstructBoundEndpoints(appliedElements, convertedArrowIds);
    }
    appliedElements = synchronizeBindingMutuality(appliedElements);

    this.api.updateScene({
      elements: appliedElements as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    this.setStatus(
      pending.plan.lens === 'diagram'
        ? 'Applied diagram — Ctrl+Z to undo.'
        : 'Applied — Ctrl+Z to undo.',
      'applied',
    );
    this.publishDerivedState();
  }

  dismissPreview(status = 'Suggestion dismissed — the original drawing remains.') {
    if (!this.pending) {
      return;
    }

    const currentElements = this.getCurrentElements();
    this.pending = undefined;
    this.api.updateScene({
      elements: removePreviewElements(currentElements as unknown as CanvasElement[]) as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.setStatus(status, 'dismissed');
    this.publishDerivedState();
  }

  handleKeyDownCapture(event: KeyboardEvent): boolean {
    const editingText = Boolean(
      this.appState?.editingTextElement
      || isTextEntryTarget(event.target),
    );
    if (this.pending) {
      const action = getPendingKeyAction(event, editingText);

      if (action === 'apply') {
        event.preventDefault();
        event.stopPropagation();
        this.apply();
        return true;
      }

      if (action === 'dismiss-and-block') {
        event.preventDefault();
        event.stopPropagation();
        this.dismissPreview();
        return true;
      }

      if (action === 'dismiss') {
        this.dismissPreview();
        return false;
      }
    }

    const hasControlModifier = event.ctrlKey || event.metaKey;
    if (
      !editingText
      && !hasControlModifier
      && !event.altKey
      && matchesExcalidrawKey(event, 'y')
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        this.suggestDiagram();
      } else {
        this.suggest();
      }
      return true;
    }

    return false;
  }

  handlePointerDownCapture(event: PointerEvent): boolean {
    if (!this.pending || event.button !== 0 || !this.appState) {
      return false;
    }
    const scenePoint = viewportCoordsToSceneCoords(
      { clientX: event.clientX, clientY: event.clientY },
      this.appState,
    );
    const target = this.findPreviewItemAt(scenePoint);
    if (!target) {
      return false;
    }
    this.togglePreviewItem(target);
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  handleContextMenuCapture() {
    if (
      getPendingContextMenuAction(this.pending !== undefined)
      === 'dismiss'
    ) {
      this.dismissPreview('Preview dismissed before opening the context menu.');
    }
  }

  focusCanvas() {
    this.shellElement
      ?.querySelector<HTMLElement>('.excalidraw')
      ?.focus({ preventScroll: true });
  }

  getOutputElements(): ExcalidrawElement[] {
    return filterOutputElements(
      this.getCurrentElements() as unknown as CanvasElement[],
    ) as unknown as ExcalidrawElement[];
  }

  getMermaid(): MermaidOutput {
    return generateMermaid(this.extractDiagramModel(this.getOutputElements()));
  }

  async exportSvg(): Promise<void> {
    const elements = this.getOutputElements();
    if (elements.length === 0 || !this.appState) {
      return;
    }
    const svg = await exportToSvg({
      elements: elements as never,
      appState: this.appState,
      files: this.files,
    });
    const source = new XMLSerializer().serializeToString(svg);
    downloadBlob('drawit.svg', new Blob([source], { type: 'image/svg+xml' }));
  }

  private showPlan(
    plan: SuggestionPlan,
    currentElements: readonly OrderedExcalidrawElement[],
    operation?: SuggestionOperation,
  ) {
    this.pending = {
      plan,
      rejectedItemIds: new Set(),
      sourceSnapshots: this.captureSourceSnapshots(plan, currentElements),
      operation,
    };

    const converted = this.convertPlan(plan, true, currentElements);
    let previewElements = [
      ...removePreviewElements(currentElements as unknown as CanvasElement[]),
      ...converted.elements,
    ] as CanvasElement[];
    previewElements = this.applyExistingBindings(previewElements, converted.existingBindings);
    previewElements = synchronizeBindingMutuality(previewElements);
    this.api.updateScene({
      elements: previewElements as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.publishDerivedState();
  }

  private convertPlan(
    plan: SuggestionPlan,
    preview: boolean,
    currentElements: readonly OrderedExcalidrawElement[],
  ): ConvertedPlan {
    const skeletons: ExcalidrawElementSkeleton[] = [];
    for (const item of plan.items) {
      skeletons.push(this.itemToSkeleton(item, preview));
    }
    const converted = convertToExcalidrawElements(skeletons, {
      regenerateIds: true,
    }) as OrderedExcalidrawElement[];
    const elementByItemId = new Map<string, OrderedExcalidrawElement>();
    for (const element of converted) {
      const itemId = getCustomString(element, 'planItemId');
      if (itemId && element.type !== 'text') {
        elementByItemId.set(itemId, element);
      }
    }

    const existingBindings: ExistingBinding[] = [];
    const output = converted.map((element) => {
      const itemId = getCustomString(element, 'planItemId')
        ?? getContainerPlanItemId(element, converted);
      if (!itemId) {
        return element;
      }
      const item = plan.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        return element;
      }
      const internal = getInternalRefs(element);
      let next = element;
      if (item.kind === 'connector' && (element.type === 'arrow' || element.type === 'line')) {
        next = this.bindConnectorElement(
          element,
          item,
          internal,
          elementByItemId,
          currentElements,
          existingBindings,
        );
      }
      const metadata = {
        drawit: preview ? 'preview' : 'native',
        sourceIds: [...item.sourceIds],
        planItemId: item.id,
        ...(preview ? {
          review: this.pending?.rejectedItemIds.has(item.id) ? 'rejected' : 'accepted',
        } : {}),
      };
      const rejected = preview && this.pending?.rejectedItemIds.has(item.id);
      next = {
        ...next,
        groupIds: next.groupIds ?? [],
        boundElements: next.boundElements ?? null,
        opacity: rejected ? 25 : preview ? 100 : next.opacity,
        locked: preview,
        strokeStyle: preview ? 'dashed' : 'solid',
        customData: metadata,
      } as OrderedExcalidrawElement;
      return next;
    });

    return {
      elements: output,
      existingBindings,
    };
  }

  private itemToSkeleton(
    item: SuggestionItem,
    preview: boolean,
  ): ExcalidrawElementSkeleton {
    const customData = {
      drawit: preview ? 'preview' : 'native',
      sourceIds: [...item.sourceIds],
      planItemId: item.id,
      ...(preview ? { review: 'accepted' as const } : {}),
    } as Record<string, unknown>;
    const style = {
      strokeColor: preview ? PREVIEW_COLOR : NATIVE_COLOR,
      strokeWidth: 2,
      opacity: 100,
      roughness: 0,
      strokeStyle: 'solid' as const,
      backgroundColor: 'transparent',
      fillStyle: 'solid' as const,
      angle: 0,
      customData,
    };

    if (item.kind === 'shape') {
      return {
        type: item.shape === 'roundedRectangle' ? 'rectangle' : item.shape,
        id: item.id,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        roundness: item.shape === 'roundedRectangle'
          ? { type: ROUNDNESS.PROPORTIONAL_RADIUS }
          : null,
        label: item.label
          ? {
              text: item.label,
              fontSize: 16,
              verticalAlign: item.children?.length ? 'top' : 'middle',
              customData,
            }
          : undefined,
        ...style,
      } as unknown as ExcalidrawElementSkeleton;
    }

    if (item.kind === 'connector') {
      const points = item.points.length > 1 ? item.points : [[0, 0], [1, 1]];
      const first = points[0] ?? [0, 0];
      const localPoints = points.map(([x, y]) => [x - first[0], y - first[1]] as [number, number]);
      const startRef = item.start && 'itemId' in item.start ? { id: item.start.itemId } : undefined;
      const endRef = item.end && 'itemId' in item.end ? { id: item.end.itemId } : undefined;
      const internalCustomData = {
        ...customData,
        ...(item.start ? { _drawitStartRef: nodeRefId(item.start) } : {}),
        ...(item.end ? { _drawitEndRef: nodeRefId(item.end) } : {}),
      };
      const type = 'arrow';
      return {
        type,
        id: item.id,
        x: first[0],
        y: first[1],
        points: localPoints,
        start: startRef,
        end: endRef,
        startArrowhead: item.startArrowhead,
        endArrowhead: item.endArrowhead,
        label: item.label
          ? { text: item.label, customData: internalCustomData }
          : undefined,
        ...style,
        customData: internalCustomData,
      } as unknown as ExcalidrawElementSkeleton;
    }

    if (item.kind === 'text') {
      return {
        type: 'text',
        id: item.id,
        x: item.x,
        y: item.y,
        text: item.text,
        ...style,
      } as unknown as ExcalidrawElementSkeleton;
    }

    if (item.primitive === 'ellipse' && item.bounds) {
      return {
        type: 'ellipse',
        id: item.id,
        x: item.bounds.x,
        y: item.bounds.y,
        width: item.bounds.width,
        height: item.bounds.height,
        ...style,
      } as unknown as ExcalidrawElementSkeleton;
    }
    if (item.primitive === 'line' && item.points && item.points.length > 1) {
      const first = item.points[0] ?? { x: 0, y: 0 };
      return {
        type: 'line',
        id: item.id,
        x: first.x,
        y: first.y,
        points: item.points.map((point) => [point.x - first.x, point.y - first.y] as [number, number]),
        ...style,
      } as unknown as ExcalidrawElementSkeleton;
    }
    const points = item.points ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const first = points[0] ?? { x: 0, y: 0 };
    return {
      type: 'freedraw',
      id: item.id,
      x: first.x,
      y: first.y,
      points: points.map((point) => [point.x - first.x, point.y - first.y] as [number, number]),
      pressures: points.map(() => 0.5),
      simulatePressure: true,
      lastCommittedPoint: null,
      ...style,
    } as unknown as ExcalidrawElementSkeleton;
  }

  private bindConnectorElement(
    element: OrderedExcalidrawElement,
    item: ConnectorSuggestionItem,
    internal: { start?: string; end?: string },
    elementByItemId: ReadonlyMap<string, OrderedExcalidrawElement>,
    currentElements: readonly OrderedExcalidrawElement[],
    existingBindings: ExistingBinding[],
  ): OrderedExcalidrawElement {
    let next = element;
    const startTarget = this.resolveBindingTarget(item.start, internal.start, elementByItemId, currentElements);
    const endTarget = this.resolveBindingTarget(item.end, internal.end, elementByItemId, currentElements);
    if (startTarget) {
      next = ensureElementBinding(next, 'start', startTarget.element);
      if (!hasStableBinding(next, 'start', startTarget.element.id)) {
        next = clearElementBinding(next, 'start');
      } else if (startTarget.fromExisting) {
        existingBindings.push({ arrowId: element.id, targetId: startTarget.element.id, endpoint: 'start' });
      }
    }
    if (endTarget) {
      next = ensureElementBinding(next, 'end', endTarget.element);
      if (!hasStableBinding(next, 'end', endTarget.element.id)) {
        next = clearElementBinding(next, 'end');
      } else if (endTarget.fromExisting) {
        existingBindings.push({ arrowId: element.id, targetId: endTarget.element.id, endpoint: 'end' });
      }
    }
    return next;
  }

  private resolveBindingTarget(
    ref: NodeRef | null,
    internalRef: string | undefined,
    elementByItemId: ReadonlyMap<string, OrderedExcalidrawElement>,
    currentElements: readonly OrderedExcalidrawElement[],
  ): { element: OrderedExcalidrawElement; fromExisting: boolean } | undefined {
    if (ref && 'itemId' in ref) {
      const target = elementByItemId.get(ref.itemId);
      if (target) {
        return { element: target, fromExisting: false };
      }
    }
    const targetId = ref && 'elementId' in ref ? ref.elementId : internalRef;
    if (!targetId) {
      return undefined;
    }
    const existing = currentElements.find((element) => element.id === targetId && !element.isDeleted);
    return existing ? { element: existing, fromExisting: true } : undefined;
  }

  private applyExistingBindings(
    elements: CanvasElement[],
    bindings: readonly ExistingBinding[],
  ): CanvasElement[] {
    if (bindings.length === 0) {
      return elements;
    }
    const next = elements.map((element) => ({ ...element }));
    for (const binding of bindings) {
      const target = next.find((element) => element.id === binding.targetId && !element.isDeleted);
      const arrow = next.find((element) => element.id === binding.arrowId && !element.isDeleted);
      if (!target || !arrow) {
        continue;
      }
      const stabilized = stabilizeBinding(
        arrow as unknown as {
          id: string;
          x: number;
          y: number;
          points?: readonly [number, number][];
        },
        target as unknown as BindingGeometry,
        binding.endpoint,
      );
      if (!stabilized.binding || !isStableBindingValue(stabilized.binding, target.id)) {
        arrow[`${binding.endpoint}Binding`] = null;
        continue;
      }
      arrow.points = stabilized.points as [number, number][];
      const boundElements = Array.isArray(target.boundElements)
        ? [...target.boundElements as { id: string; type: string }[]]
        : [];
      if (!boundElements.some((bound) => bound.id === arrow.id)) {
        boundElements.push({ id: arrow.id, type: 'arrow' });
      }
      target.boundElements = boundElements;
      if (binding.endpoint === 'start') {
        arrow.startBinding = stabilized.binding;
      } else {
        arrow.endBinding = stabilized.binding;
      }
    }
    return next;
  }

  private findPreviewItemAt(point: Point): string | undefined {
    const targets = new Map<string, {
      itemId: string;
      bounds: { x: number; y: number; width: number; height: number };
      points: SuggestionPoint[];
    }>();
    for (const element of this.getCurrentElements()) {
      const data = element.customData;
      if (!isPreviewElement(element as unknown as CanvasElement) || !data) {
        continue;
      }
      const itemId = typeof data.planItemId === 'string' ? data.planItemId : undefined;
      if (!itemId) {
        continue;
      }
      const points = getAbsoluteElementPoints(element);
      const bounds = getElementBounds(element, points);
      const current = targets.get(itemId);
      if (!current) {
        targets.set(itemId, { itemId, bounds, points });
      } else {
        current.bounds = unionBounds(current.bounds, bounds);
        current.points.push(...points);
      }
    }
    return hitTestPreviewItems([...targets.values()], point);
  }

  private togglePreviewItem(itemId: string) {
    if (!this.pending) {
      return;
    }
    const rejected = this.pending.rejectedItemIds;
    if (rejected.has(itemId)) {
      rejected.delete(itemId);
    } else {
      rejected.add(itemId);
    }
    const currentElements = this.getCurrentElements();
    const nextElements = currentElements.map((element) => {
      const planItemId = getCustomString(element, 'planItemId');
      return planItemId === itemId
        ? (setPreviewReview(
          element as unknown as CanvasElement,
          rejected.has(itemId) ? 'rejected' : 'accepted',
        ) as unknown as OrderedExcalidrawElement)
        : element;
    });
    this.api.updateScene({
      elements: nextElements as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.setStatus(
      this.pending.plan.lens === 'diagram'
        ? this.formatDiagramStatus(this.pending.plan, rejected)
        : `Suggestion ready — ${rejected.size} item${rejected.size === 1 ? '' : 's'} rejected. Enter applies the rest. Esc dismisses.`,
      'ready',
    );
  }

  private formatDiagramStatus(
    plan: SuggestionPlan,
    rejected: ReadonlySet<string>,
  ): string {
    const acceptedCount = plan.items.filter((item) => !rejected.has(item.id)).length;
    return `Diagram: ${summarizeSuggestionPlan(plan, rejected)}. Click an item to reject or restore it. Enter applies ${acceptedCount} of ${plan.items.length}. Esc dismisses.`;
  }

  private sourcesStillMatch(
    pending: PendingSuggestion,
    elements: readonly OrderedExcalidrawElement[],
  ): boolean {
    for (const [id, snapshot] of pending.sourceSnapshots) {
      const element = elements.find((candidate) => candidate.id === id && !candidate.isDeleted);
      if (!element || snapshot === '__missing__' || elementFingerprint(element) !== snapshot) {
        return false;
      }
    }
    return true;
  }

  private captureSourceSnapshots(
    plan: SuggestionPlan,
    elements: readonly OrderedExcalidrawElement[],
  ): Map<string, string> {
    const snapshots = new Map<string, string>();
    for (const id of getPlanSourceIds(plan)) {
      const element = elements.find((candidate) => candidate.id === id && !candidate.isDeleted);
      snapshots.set(id, element ? elementFingerprint(element) : '__missing__');
    }
    return snapshots;
  }

  private getDiagramInput(currentElements: readonly OrderedExcalidrawElement[]) {
    const selectedIds = this.appState?.selectedElementIds ?? {};
    const selectedTargets = currentElements.filter((element) => {
      return Boolean(selectedIds[element.id])
        && !element.isDeleted
        && (element.type === 'freedraw' || element.type === 'text');
    });
    const targets = selectedTargets.length > 0
      ? selectedTargets
      : currentElements.filter((element) => {
        return !element.isDeleted
          && !isPreviewElement(element as unknown as CanvasElement)
          && (element.type === 'freedraw' || element.type === 'text');
      });
    const input = {
      strokes: targets
        .filter((element) => element.type === 'freedraw')
        .map((element) => freedrawElementToStroke(element as unknown as CanvasElement))
        .filter((stroke): stroke is DrawitStroke => Boolean(stroke))
        .map((stroke) => ({ id: stroke.sourceId, points: stroke.points })),
      texts: targets
        .filter((element) => element.type === 'text')
        .filter((element) => {
          const containerId = (element as unknown as { containerId?: unknown }).containerId;
          return typeof containerId !== 'string' || containerId.length === 0;
        })
        .map((element) => ({
          id: element.id,
          text: getElementText(element),
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        })),
      nativeNodes: currentElements
        .filter((element) => {
          return !element.isDeleted
            && !isPreviewElement(element as unknown as CanvasElement)
            && (element.type === 'rectangle' || element.type === 'diamond' || element.type === 'ellipse');
        })
        .map((element) => ({
          id: element.id,
          kind: element.type === 'rectangle' && element.roundness ? 'roundedRectangle' as const : element.type as 'rectangle' | 'diamond' | 'ellipse',
          bounds: {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          },
        })),
    };
    return input;
  }

  private extractDiagramModel(elements: readonly ExcalidrawElement[]): DiagramModel {
    const live = elements.filter((element) => !element.isDeleted);
    const nodeElements = live.filter((element) => {
      return element.type === 'rectangle' || element.type === 'diamond' || element.type === 'ellipse';
    });
    const nodes = nodeElements.map((element) => ({
      id: element.id,
      kind: element.type === 'rectangle' && element.roundness ? 'roundedRectangle' as const : element.type as 'rectangle' | 'diamond' | 'ellipse',
      bounds: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      },
      label: getBoundText(element, live),
    }));
    const edges = live
      .filter((element) => element.type === 'arrow' || element.type === 'line')
      .map((element) => {
        const start = getBindingId(element, 'start');
        const end = getBindingId(element, 'end');
        return {
          id: element.id,
          from: start,
          to: end,
          direction: getEdgeDirection(element),
          label: getBoundText(element, live),
        };
      });
    const containers = nodes
      .map((outer) => ({
        id: outer.id,
        title: outer.label,
        children: nodes
          .filter((inner) => inner.id !== outer.id && contains(outer.bounds, inner.bounds))
          .sort((first, second) => area(first.bounds) - area(second.bounds))
          .map((inner) => inner.id),
      }))
      .filter((container) => container.children.length > 0);
    return { nodes, edges, containers };
  }

  private publishDerivedState() {
    const currentElements = this.getCurrentElements() as unknown as CanvasElement[];
    const selectedElementIds = this.appState?.selectedElementIds ?? {};
    const selectedStrokeCount = currentElements.filter((element) => {
      return selectedElementIds[element.id]
        && element.type === 'freedraw'
        && !element.isDeleted;
    }).length;
    const hasFreedraw = currentElements.some((element) => {
      return element.type === 'freedraw' && !element.isDeleted && !isPreviewElement(element);
    });
    const hasDiagramInput = currentElements.some((element) => {
      return !element.isDeleted
        && !isPreviewElement(element)
        && (element.type === 'freedraw' || element.type === 'text' || element.type === 'rectangle' || element.type === 'diamond' || element.type === 'ellipse');
    });
    const canExport = filterOutputElements(currentElements).length > 0;

    this.state = {
      ...this.state,
      hasPendingSuggestion: this.pending !== undefined,
      canSuggest: hasFreedraw,
      canSuggestDiagram: hasDiagramInput,
      canExport,
      selectedStrokeCount,
    };
    this.notify();
  }

  private setStatus(status: string, statusKind: SuggestionStatus) {
    this.state = {
      ...this.state,
      status,
      statusKind,
      hasPendingSuggestion: this.pending !== undefined,
    };
    this.notify();
  }

  private notify() {
    this.listeners.forEach((listener) => listener(this.state));
  }

  getCurrentElements(): OrderedExcalidrawElement[] {
    if (this.elements.length > 0) {
      return [...this.elements];
    }
    return this.api.getSceneElementsIncludingDeleted() as OrderedExcalidrawElement[];
  }
}

const isTextEntryTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable
    || Boolean(target.closest('[contenteditable="true"]'));
};

const nodeRefId = (ref: NodeRef): string => {
  return 'itemId' in ref ? `item:${ref.itemId}` : `element:${ref.elementId}`;
};

const getCustomString = (
  element: { customData?: Record<string, unknown> } & Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = element.customData?.[key] ?? element[key];
  return typeof value === 'string' ? value : undefined;
};

const getContainerPlanItemId = (
  element: OrderedExcalidrawElement,
  elements: readonly OrderedExcalidrawElement[],
): string | undefined => {
  const containerIdValue = (element as unknown as { containerId?: unknown }).containerId;
  const containerId = typeof containerIdValue === 'string' ? containerIdValue : undefined;
  if (!containerId) {
    return undefined;
  }
  const container = elements.find((candidate) => candidate.id === containerId);
  return container ? getCustomString(container, 'planItemId') : undefined;
};

const getInternalRefs = (
  element: OrderedExcalidrawElement,
): { start?: string; end?: string } => ({
  start: getCustomString(element, '_drawitStartRef'),
  end: getCustomString(element, '_drawitEndRef'),
});

const isStableBindingValue = (
  binding: { elementId?: unknown; focus?: unknown; gap?: unknown } | null | undefined,
  targetId: string,
): binding is { elementId: string; focus: number; gap: number } => {
  return binding?.elementId === targetId
    && typeof binding.focus === 'number'
    && Number.isFinite(binding.focus)
    && Math.abs(binding.focus) <= 1
    && typeof binding.gap === 'number'
    && Number.isFinite(binding.gap)
    && binding.gap >= 1;
};

const hasStableBinding = (
  element: OrderedExcalidrawElement,
  endpoint: 'start' | 'end',
  targetId: string,
): boolean => {
  const binding = (element as unknown as Record<string, unknown>)[
    `${endpoint}Binding`
  ] as { elementId?: unknown; focus?: unknown; gap?: unknown } | null | undefined;
  return isStableBindingValue(binding, targetId);
};

const ensureElementBinding = (
  element: OrderedExcalidrawElement,
  endpoint: 'start' | 'end',
  target: OrderedExcalidrawElement,
): OrderedExcalidrawElement => {
  const binding = (element as unknown as Record<string, unknown>)[
    `${endpoint}Binding`
  ] as { elementId?: unknown; focus?: unknown; gap?: unknown } | null | undefined;
  if (
    binding?.elementId === target.id
    && isStableBindingValue(binding, target.id)
  ) {
    const probe = stabilizeBinding(
      element as unknown as {
        id: string;
        x: number;
        y: number;
        points?: readonly [number, number][];
      },
      target,
      endpoint,
    );
    if (probe.binding && probe.movement <= 0.5) {
      return element;
    }
  }
  return setElementBinding(element, endpoint, target);
};

const clearElementBinding = (
  element: OrderedExcalidrawElement,
  endpoint: 'start' | 'end',
): OrderedExcalidrawElement => ({
  ...element,
  [`${endpoint}Binding`]: null,
});

const setElementBinding = (
  element: OrderedExcalidrawElement,
  endpoint: 'start' | 'end',
  target: OrderedExcalidrawElement,
): OrderedExcalidrawElement => {
  return bindArrowEndpoint(
    element as unknown as {
      id: string;
      x: number;
      y: number;
      points?: readonly [number, number][];
    },
    target,
    endpoint,
  ) as unknown as OrderedExcalidrawElement;
};

const reconstructBoundEndpoints = (
  elements: CanvasElement[],
  arrowIds: ReadonlySet<string>,
): CanvasElement[] => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  return elements.map((element) => {
    if (
      element.type !== 'arrow'
      || !arrowIds.has(element.id)
      || !Array.isArray(element.points)
      || element.points.length < 2
    ) {
      return element;
    }
    const candidate = element as unknown as {
      x: number;
      y: number;
      points: readonly [number, number][];
      startBinding?: { elementId: string; focus: number; gap: number } | null;
      endBinding?: { elementId: string; focus: number; gap: number } | null;
    };
    const replacements = new Map<number, Point>();
    for (const endpoint of ['start', 'end'] as const) {
      const binding = endpoint === 'start'
        ? candidate.startBinding
        : candidate.endBinding;
      if (!binding || binding.gap < 1) {
        continue;
      }
      const target = byId.get(binding.elementId);
      if (!target) {
        continue;
      }
      const point = updateBoundPoint(
        element as unknown as {
          x: number;
          y: number;
          points: readonly [number, number][];
          startBinding?: { elementId: string; focus: number; gap: number } | null;
          endBinding?: { elementId: string; focus: number; gap: number } | null;
        },
        target as unknown as BindingGeometry,
        endpoint,
      );
      const index = endpoint === 'start' ? 0 : candidate.points.length - 1;
      replacements.set(index, point);
    }
    if (replacements.size === 0) {
      return element;
    }
    const points = candidate.points.map(([x, y], pointIndex) => {
      const point = replacements.get(pointIndex);
      return point
        ? [point.x - candidate.x, point.y - candidate.y] as [number, number]
        : [x, y] as [number, number];
    });
    return { ...element, points } as CanvasElement;
  });
};

const getAbsoluteElementPoints = (
  element: OrderedExcalidrawElement,
): Point[] => {
  const candidate = element as unknown as {
    x: number;
    y: number;
    points?: readonly [number, number][];
  };
  if (!Array.isArray(candidate.points)) {
    return [];
  }
  return candidate.points.map(([x, y]) => ({
    x: candidate.x + x,
    y: candidate.y + y,
  }));
};

const getElementBounds = (
  element: OrderedExcalidrawElement,
  points: readonly Point[],
) => {
  if (points.length > 0) {
    return {
      x: Math.min(...points.map((point) => point.x)),
      y: Math.min(...points.map((point) => point.y)),
      width: Math.max(1, Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x))),
      height: Math.max(1, Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))),
    };
  }
  return { x: element.x, y: element.y, width: element.width, height: element.height };
};

const unionBounds = (
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) => {
  const minX = Math.min(first.x, second.x);
  const minY = Math.min(first.y, second.y);
  const maxX = Math.max(first.x + first.width, second.x + second.width);
  const maxY = Math.max(first.y + first.height, second.y + second.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const elementFingerprint = (element: OrderedExcalidrawElement): string => {
  const candidate = element as unknown as { points?: unknown };
  return JSON.stringify({
    id: element.id,
    version: element.version,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    text: getElementString(element, 'text'),
    points: candidate.points,
  });
};

const getBindingId = (
  element: ExcalidrawElement,
  endpoint: 'start' | 'end',
): string | undefined => {
  const binding = (element as unknown as Record<string, unknown>)[`${endpoint}Binding`];
  if (!binding || typeof binding !== 'object') {
    return undefined;
  }
  const elementId = (binding as { elementId?: unknown }).elementId;
  return typeof elementId === 'string' ? elementId : undefined;
};

const getEdgeDirection = (
  element: ExcalidrawElement,
): 'forward' | 'backward' | 'both' | 'none' => {
  if (element.type !== 'arrow') {
    return 'none';
  }
  const start = element.startArrowhead === 'arrow';
  const end = element.endArrowhead === 'arrow';
  if (start && end) {
    return 'both';
  }
  if (start) {
    return 'backward';
  }
  if (end) {
    return 'forward';
  }
  return 'none';
};

const getBoundText = (
  container: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): string | undefined => {
  const textIds = Array.isArray(container.boundElements)
    ? container.boundElements.filter((bound) => bound.type === 'text').map((bound) => bound.id)
    : [];
  const text = elements
    .filter((element) => textIds.includes(element.id) && element.type === 'text')
    .map((element) => getElementText(element).trim())
    .filter(Boolean)
    .join('\n');
  return text || undefined;
};

const getElementString = (
  element: object,
  key: string,
): string => {
  const value = (element as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

const contains = (
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
) => {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
    && area(inner) < area(outer);
};

const area = (bounds: { width: number; height: number }) => bounds.width * bounds.height;

const downloadBlob = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
