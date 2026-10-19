import {
  FluentProvider,
  Text,
  makeStyles,
  tokens,
  webLightTheme,
} from '@fluentui/react-components';
import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import type { CanvasAdapter } from './canvas/excalidraw/CanvasAdapter';
import type { CanvasAdapterState } from './canvas/excalidraw/types';
import { SuggestionPanel } from './ui/SuggestionPanel';
import type {
  InterpretClientController,
  InterpretUiState,
} from './dev/interpret-client';

const LazyExcalidrawEditor = lazy(async () => {
  const module = await import('./canvas/excalidraw/ExcalidrawEditor');
  return { default: module.ExcalidrawEditor };
});

const useStyles = makeStyles({
  app: {
    minHeight: '100vh',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    minHeight: '56px',
    padding: `0 ${tokens.spacingHorizontalXXL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  brand: {
    fontWeight: tokens.fontWeightSemibold,
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    width: 'min(100% - 32px, 1440px)',
    margin: '0 auto',
    padding: `${tokens.spacingVerticalXXL} 0`,
  },
  intro: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  editor: {
    height: 'min(72vh, 760px)',
    minHeight: '520px',
    overflow: 'hidden',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
  },
  loading: {
    display: 'grid',
    height: '100%',
    placeItems: 'center',
    color: tokens.colorNeutralForeground2,
  },
});

const initialState: CanvasAdapterState = {
  status: 'Draw a stroke to get started.',
  statusKind: 'idle',
  hasPendingSuggestion: false,
  canSuggest: false,
  canSuggestDiagram: false,
  canExport: false,
  selectedStrokeCount: 0,
};

export const App = () => {
  const styles = useStyles();
  const adapterRef = useRef<CanvasAdapter | undefined>(undefined);
  const t2ControllerRef = useRef<InterpretClientController | undefined>(undefined);
  const [adapterState, setAdapterState] = useState(initialState);
  const [t2State, setT2State] = useState<InterpretUiState>({
    available: false,
    busy: false,
  });
  const [mermaid, setMermaid] = useState({ code: '', unboundArrows: 0 });

  const handleReady = useCallback((adapter: CanvasAdapter) => {
    adapterRef.current = adapter;
    if (import.meta.env.DEV) {
      void import('./dev/interpret-client').then(({ createInterpretController }) => {
        if (adapterRef.current !== adapter) {
          return;
        }
        const controller = createInterpretController(adapter, setT2State);
        t2ControllerRef.current = controller;
        setT2State(controller.getState());
      });
    }
  }, []);
  const handleStateChange = useCallback((state: CanvasAdapterState) => {
    setAdapterState(state);
  }, []);
  const handleSuggest = useCallback(() => {
    adapterRef.current?.suggest();
    adapterRef.current?.focusCanvas();
  }, []);
  const handleApply = useCallback(() => {
    adapterRef.current?.apply();
    adapterRef.current?.focusCanvas();
  }, []);
  const handleDismiss = useCallback(() => {
    adapterRef.current?.dismissPreview();
    adapterRef.current?.focusCanvas();
  }, []);
  const handleSuggestDiagram = useCallback(() => {
    adapterRef.current?.suggestDiagram();
    adapterRef.current?.focusCanvas();
  }, []);
  const handleT2 = useCallback(() => {
    if (t2State.busy) {
      t2ControllerRef.current?.cancel();
    } else {
      void t2ControllerRef.current?.start();
    }
    adapterRef.current?.focusCanvas();
  }, [t2State.busy]);
  const handleExportMermaid = useCallback(() => {
    const output = adapterRef.current?.getMermaid();
    if (output) {
      setMermaid(output);
    }
  }, []);
  const handleExportSvg = useCallback(() => {
    void adapterRef.current?.exportSvg();
  }, []);

  return (
    <FluentProvider theme={webLightTheme}>
      <div className={styles.app}>
        <header className={styles.header}>
          <Text className={styles.brand} size={500}>Drawit</Text>
          <Text size={300}>Human-first drawing studio</Text>
        </header>
        <main className={styles.main}>
          <section className={styles.intro} aria-labelledby="page-title">
            <Text id="page-title" size={800} weight="semibold">
              Extend what your hands can draw.
            </Text>
            <Text size={400}>
              Draw with Excalidraw, then ask for a geometry-only suggestion without giving up authorship.
            </Text>
          </section>
          <SuggestionPanel
            state={adapterState}
            onSuggest={handleSuggest}
            onSuggestDiagram={handleSuggestDiagram}
            onT2={handleT2}
            t2Available={t2State.available}
            t2Busy={t2State.busy}
            t2Configured={t2State.configured}
            t2Reason={t2State.reason}
            onApply={handleApply}
            onDismiss={handleDismiss}
            onExportMermaid={handleExportMermaid}
            onExportSvg={handleExportSvg}
            mermaidCode={mermaid.code}
            mermaidUnboundArrows={mermaid.unboundArrows}
          />
          <section className={styles.editor} aria-label="Excalidraw drawing workspace">
            <Suspense fallback={<div className={styles.loading}>Loading the drawing canvas…</div>}>
              <LazyExcalidrawEditor
                onReady={handleReady}
                onStateChange={handleStateChange}
              />
            </Suspense>
          </section>
        </main>
      </div>
    </FluentProvider>
  );
};
