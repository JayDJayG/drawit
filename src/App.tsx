import {
  FluentProvider,
  makeStyles,
  tokens,
  webLightTheme,
} from '@fluentui/react-components';
import {
  lazy,
  Suspense,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { CanvasAdapter } from './canvas/excalidraw/CanvasAdapter';
import type { CanvasAdapterState } from './canvas/excalidraw/types';
import type {
  InterpretClientController,
  InterpretUiState,
} from './dev/interpret-client';
import { AppBar } from './ui/AppBar';
import { MermaidDialog } from './ui/MermaidDialog';
import { ReviewBar } from './ui/ReviewBar';
import { ShortcutsDialog } from './ui/ShortcutsDialog';
import { StatusToast } from './ui/StatusToast';
import { visuallyHidden } from './ui/shared-styles';
import { useCoarsePointer, useMediaQuery } from './ui/use-media-query';

const LazyExcalidrawEditor = lazy(async () => {
  const module = await import('./canvas/excalidraw/ExcalidrawEditor');
  return { default: module.ExcalidrawEditor };
});

// Inline on purpose: FluentProvider copies its className onto every portal
// mount node, so a height class would turn each portal into a full-page layer.
const PROVIDER_STYLE: CSSProperties = { height: '100%' };

const useStyles = makeStyles({
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  workspace: {
    position: 'relative',
    flex: '1 1 auto',
    minHeight: '0',
    overflow: 'hidden',
  },
  layer: {
    position: 'absolute',
    top: '0',
    right: '0',
    bottom: '0',
    left: '0',
  },
  overlay: {
    // Above Excalidraw's toolbars (z-index 4), below its popovers and dialogs.
    zIndex: 5,
    pointerEvents: 'none',
  },
  loading: {
    display: 'grid',
    height: '100%',
    placeItems: 'center',
    color: tokens.colorNeutralForeground2,
  },
  hidden: visuallyHidden,
});

const initialState: CanvasAdapterState = {
  status: 'Draw a stroke to get started.',
  statusKind: 'idle',
  statusId: 0,
  hasPendingSuggestion: false,
  canSuggest: false,
  canSuggestDiagram: false,
  canExport: false,
  canUndo: false,
  excalidrawUiOpen: false,
  selectedStrokeCount: 0,
};

export const App = () => {
  const styles = useStyles();
  const adapterRef = useRef<CanvasAdapter | undefined>(undefined);
  const interpretRef = useRef<InterpretClientController | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [adapterState, setAdapterState] = useState(initialState);
  const [interpretState, setInterpretState] = useState<InterpretUiState>({
    available: false,
    busy: false,
  });
  const [hiddenStatusId, setHiddenStatusId] = useState(-1);
  const [mermaid, setMermaid] = useState({ code: '', unboundArrows: 0 });
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const coarse = useCoarsePointer();
  const compact = useMediaQuery('(max-width: 479px)');

  const handleReady = useCallback((adapter: CanvasAdapter) => {
    adapterRef.current = adapter;
    setReady(true);
    if (import.meta.env.DEV) {
      void import('./dev/interpret-client').then(({ createInterpretController }) => {
        if (adapterRef.current !== adapter) {
          return;
        }
        const controller = createInterpretController(adapter, setInterpretState);
        interpretRef.current = controller;
        setInterpretState(controller.getState());
      });
    }
  }, []);
  const handleStateChange = useCallback((state: CanvasAdapterState) => {
    setAdapterState(state);
  }, []);
  const focusCanvas = useCallback(() => {
    adapterRef.current?.focusCanvas();
  }, []);
  const handleSuggest = useCallback(() => {
    adapterRef.current?.suggest();
    focusCanvas();
  }, [focusCanvas]);
  const handleSuggestDiagram = useCallback(() => {
    adapterRef.current?.suggestDiagram();
    focusCanvas();
  }, [focusCanvas]);
  const handleApply = useCallback(() => {
    adapterRef.current?.apply();
    focusCanvas();
  }, [focusCanvas]);
  const handleDismiss = useCallback(() => {
    adapterRef.current?.dismissPreview();
    focusCanvas();
  }, [focusCanvas]);
  const handleUndo = useCallback(() => {
    adapterRef.current?.undo();
    focusCanvas();
  }, [focusCanvas]);
  const handleInterpret = useCallback(() => {
    const controller = interpretRef.current;
    if (!controller) {
      return;
    }
    if (controller.getState().busy) {
      controller.cancel();
    } else {
      void controller.start();
    }
    focusCanvas();
  }, [focusCanvas]);
  const handleCancelInterpret = useCallback(() => {
    interpretRef.current?.cancel();
    focusCanvas();
  }, [focusCanvas]);
  const handleExportMermaid = useCallback(() => {
    const output = adapterRef.current?.getMermaid();
    if (output) {
      setMermaid(output);
      setMermaidOpen(true);
    }
  }, []);
  const handleExportSvg = useCallback(() => {
    void adapterRef.current?.exportSvg();
  }, []);
  const handleShowShortcuts = useCallback(() => {
    setShortcutsOpen(true);
  }, []);

  const { statusId } = adapterState;
  const interpretBusy = interpretState.busy;
  const handleCloseToast = useCallback(() => {
    setHiddenStatusId(statusId);
    focusCanvas();
  }, [focusCanvas, statusId]);
  // Drawing again puts the last message away, unless Interpret is still working.
  const handleCanvasPointerDown = useCallback(() => {
    if (!interpretBusy) {
      setHiddenStatusId(statusId);
    }
  }, [interpretBusy, statusId]);

  const review = adapterState.hasPendingSuggestion && !adapterState.excalidrawUiOpen
    ? adapterState.review
    : undefined;
  const showToast = !adapterState.hasPendingSuggestion
    && !adapterState.excalidrawUiOpen
    && hiddenStatusId !== statusId;

  return (
    <FluentProvider style={PROVIDER_STYLE} theme={webLightTheme}>
      <div className={styles.app}>
        <AppBar
          ready={ready}
          reviewing={adapterState.hasPendingSuggestion}
          canExport={adapterState.canExport}
          compact={compact}
          coarse={coarse}
          interpret={import.meta.env.DEV ? interpretState : undefined}
          onSuggest={handleSuggest}
          onSuggestDiagram={handleSuggestDiagram}
          onInterpret={handleInterpret}
          onExportMermaid={handleExportMermaid}
          onExportSvg={handleExportSvg}
          onShowShortcuts={handleShowShortcuts}
        />
        <main className={styles.workspace}>
          <div className={styles.hidden} role="status" aria-live="polite" aria-atomic="true">
            <span key={statusId}>{adapterState.status}</span>
          </div>
          <div className={`${styles.layer} ${styles.overlay}`}>
            {review && (
              <ReviewBar
                review={review}
                coarse={coarse}
                onApply={handleApply}
                onDismiss={handleDismiss}
              />
            )}
            {showToast && (
              <StatusToast
                status={adapterState.status}
                kind={adapterState.statusKind}
                busy={interpretBusy}
                canUndo={adapterState.canUndo}
                coarse={coarse}
                onUndo={handleUndo}
                onCancel={handleCancelInterpret}
                onClose={handleCloseToast}
              />
            )}
          </div>
          <div className={styles.layer} onPointerDownCapture={handleCanvasPointerDown}>
            <Suspense fallback={<div className={styles.loading}>Loading the drawing canvas…</div>}>
              <LazyExcalidrawEditor
                onReady={handleReady}
                onStateChange={handleStateChange}
              />
            </Suspense>
          </div>
        </main>
        <MermaidDialog
          open={mermaidOpen}
          code={mermaid.code}
          unboundArrows={mermaid.unboundArrows}
          onOpenChange={setMermaidOpen}
        />
        <ShortcutsDialog
          open={shortcutsOpen}
          coarse={coarse}
          onOpenChange={setShortcutsOpen}
        />
      </div>
    </FluentProvider>
  );
};
