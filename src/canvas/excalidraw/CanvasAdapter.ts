import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
} from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import {
  applyElementSet,
  filterOutputElements,
  freedrawElementToStroke,
  getTargetFreedrawElements,
  markAsPreview,
  removePreviewElements,
  sceneSignature,
} from './scene-logic';
import {
  formatSuggestionStatus,
  getPendingContextMenuAction,
  getPendingKeyAction,
  matchesExcalidrawKey,
  StrokeSuggestionEngine,
  type SuggestionOperation,
} from './adapter-logic';
import type {
  CanvasAdapterState,
  CanvasElement,
  DrawitStroke,
  NativeElementDraft,
  Point,
  SuggestionStatus,
} from './types';

type StateListener = (state: CanvasAdapterState) => void;

export class CanvasAdapter {
  private readonly suggestionEngine = new StrokeSuggestionEngine();
  private readonly api: ExcalidrawImperativeAPI;
  private readonly shellElement?: HTMLElement;
  private readonly listeners = new Set<StateListener>();
  private elements: readonly OrderedExcalidrawElement[] = [];
  private appState?: AppState;
  private pendingOperation?: SuggestionOperation;
  private lastSceneSignature?: string;
  private state: CanvasAdapterState = {
    status: 'Draw a stroke to get started.',
    statusKind: 'idle',
    hasPendingSuggestion: false,
    canSuggest: false,
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
    _files: BinaryFiles,
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

    if (
      this.pendingOperation
      && (sceneChanged || openedOutputUi)
    ) {
      this.dismissPreview(openedOutputUi ? 'Preview dismissed before saving or exporting.' : undefined);
    }

    this.lastSceneSignature = nextSignature;
    this.publishDerivedState();
  }

  suggest() {
    if (this.pendingOperation) {
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

    this.pendingOperation = result.operation;
    const previews = this.createNativeElements(result.operation.drafts, true);
    const nextElements = [
      ...removePreviewElements(currentElements),
      ...previews,
    ];

    this.api.updateScene({
      elements: nextElements as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    const status = formatSuggestionStatus(result);
    this.setStatus(status.text, status.kind);
    this.publishDerivedState();
  }

  apply() {
    if (!this.pendingOperation) {
      return;
    }

    const operation = this.pendingOperation;
    const currentElements = this.getCurrentElements();
    const currentSourceIds = new Set(
      currentElements
        .filter((element) => operation.sourceIds.includes(element.id) && !element.isDeleted)
        .map((element) => element.id),
    );

    if (currentSourceIds.size !== operation.sourceIds.length) {
      this.dismissPreview('That suggestion is no longer available.');
      return;
    }

    this.pendingOperation = undefined;
    this.api.updateScene({
      elements: removePreviewElements(currentElements) as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    const nativeElements = this.createNativeElements(operation.drafts, false);
    const appliedElements = applyElementSet(
      currentElements as unknown as CanvasElement[],
      operation.sourceIds,
      nativeElements as unknown as CanvasElement[],
      (element) => newElementWith(
        element as unknown as ExcalidrawElement,
        { isDeleted: true },
      ) as unknown as CanvasElement,
    );

    this.api.updateScene({
      elements: appliedElements as unknown as readonly ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    this.setStatus('Applied — Ctrl+Z to undo.', 'applied');
    this.publishDerivedState();
  }

  dismissPreview(status = 'Suggestion dismissed — the original drawing remains.') {
    if (!this.pendingOperation) {
      return;
    }

    const currentElements = this.getCurrentElements();

    this.pendingOperation = undefined;
    this.api.updateScene({
      elements: removePreviewElements(currentElements) as unknown as readonly ExcalidrawElement[],
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
    if (this.pendingOperation) {
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
      this.suggest();
      return true;
    }

    return false;
  }

  handleContextMenuCapture() {
    if (
      getPendingContextMenuAction(this.pendingOperation !== undefined)
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

  getCurrentElements(): OrderedExcalidrawElement[] {
    if (this.elements.length > 0) {
      return [...this.elements];
    }

    return this.api.getSceneElementsIncludingDeleted() as OrderedExcalidrawElement[];
  }

  private createNativeElements(
    drafts: readonly NativeElementDraft[],
    preview: boolean,
  ): OrderedExcalidrawElement[] {
    return drafts.flatMap((draft) => {
      const skeleton = this.toSkeleton(draft);
      const [element] = convertToExcalidrawElements([skeleton], {
        regenerateIds: true,
      });

      if (!element) {
        return [];
      }

      const sourceIds = draft.sourceIds;
      const bounds = draft.bounds ?? getDraftBounds(draft.points ?? []);
      const nativeElement = {
        ...element,
        width: element.width || bounds.width,
        height: element.height || bounds.height,
        groupIds: element.groupIds ?? [],
        frameId: element.frameId ?? null,
        boundElements: element.boundElements ?? null,
        link: element.link ?? null,
        roughness: 0,
        strokeStyle: 'solid',
        locked: false,
        customData: { drawit: 'native', sourceIds },
      } as unknown as OrderedExcalidrawElement;

      return [preview
        ? markAsPreview(nativeElement as unknown as CanvasElement, sourceIds) as unknown as OrderedExcalidrawElement
        : nativeElement];
    });
  }

  private toSkeleton(draft: NativeElementDraft) {
    const style = {
      strokeColor: draft.style.color,
      strokeWidth: draft.style.width,
      opacity: draft.style.opacity,
      roughness: 0,
      strokeStyle: 'solid' as const,
      backgroundColor: 'transparent',
      fillStyle: 'solid' as const,
      roundness: null,
      angle: 0,
    };

    if (draft.kind === 'rectangle' || draft.kind === 'ellipse') {
      const bounds = draft.bounds;

      if (!bounds) {
        throw new Error(`A ${draft.kind} suggestion is missing bounds.`);
      }

      return {
        type: draft.kind,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        ...style,
      } as unknown as ExcalidrawElementSkeleton;
    }

    const points = draft.points ?? [];
    const first = points[0] ?? { x: 0, y: 0 };
    const localPoints = points.map((point) => [
      point.x - first.x,
      point.y - first.y,
    ] as [number, number]);

    if (draft.kind === 'line') {
      return {
        type: 'line',
        x: first.x,
        y: first.y,
        points: localPoints,
        ...style,
      } as unknown as ExcalidrawElementSkeleton;
    }

    return {
      type: 'freedraw',
      x: first.x,
      y: first.y,
      points: localPoints,
      pressures: localPoints.map(() => 0.5),
      simulatePressure: true,
      lastCommittedPoint: null,
      ...style,
    } as unknown as ExcalidrawElementSkeleton;
  }

  private setStatus(
    status: string,
    statusKind: SuggestionStatus,
  ) {
    this.state = {
      ...this.state,
      status,
      statusKind,
      hasPendingSuggestion: this.pendingOperation !== undefined,
    };
    this.notify();
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
      return element.type === 'freedraw' && !element.isDeleted;
    });

    this.state = {
      ...this.state,
      hasPendingSuggestion: this.pendingOperation !== undefined,
      canSuggest: hasFreedraw,
      selectedStrokeCount,
    };
    this.notify();
  }

  private notify() {
    this.listeners.forEach((listener) => listener(this.state));
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

const getDraftBounds = (points: readonly Point[]) => {
  if (points.length === 0) {
    return { width: 0, height: 0 };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};
