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
  selectedStrokeCount: 0,
};

export const App = () => {
  const styles = useStyles();
  const adapterRef = useRef<CanvasAdapter | undefined>(undefined);
  const [adapterState, setAdapterState] = useState(initialState);

  const handleReady = useCallback((adapter: CanvasAdapter) => {
    adapterRef.current = adapter;
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
            onApply={handleApply}
            onDismiss={handleDismiss}
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
