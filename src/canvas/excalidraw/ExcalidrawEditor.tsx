import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import './setup-assets';
import { Excalidraw } from '@excalidraw/excalidraw';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import { CanvasAdapter } from './CanvasAdapter';
import type { CanvasAdapterState } from './types';

export type ExcalidrawEditorProps = {
  onReady?: (adapter: CanvasAdapter) => void;
  onStateChange?: (state: CanvasAdapterState) => void;
};

const EXCALIDRAW_UI_OPTIONS = { tools: { image: false } } as const;

export const ExcalidrawEditor = ({
  onReady,
  onStateChange,
}: ExcalidrawEditorProps) => {
  const shellRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<CanvasAdapter | undefined>(undefined);
  const stateListenerRef = useRef(onStateChange);

  useEffect(() => {
    stateListenerRef.current = onStateChange;
  }, [onStateChange]);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    if (adapterRef.current) {
      return;
    }

    const adapter = new CanvasAdapter(api, shellRef.current);
    adapter.subscribe((state) => {
      window.setTimeout(() => stateListenerRef.current?.(state), 0);
    });
    adapterRef.current = adapter;
    onReady?.(adapter);
    adapter.handleChange(
      api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[],
      api.getAppState() as AppState,
      api.getFiles() as BinaryFiles,
    );
  }, [onReady]);

  const handleChange = useCallback((
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    adapterRef.current?.handleChange(elements, appState, files);
  }, []);

  const handleKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    adapterRef.current?.handleKeyDownCapture(event.nativeEvent);
  }, []);
  const handleContextMenuCapture = useCallback(() => {
    adapterRef.current?.handleContextMenuCapture();
  }, []);

  return (
    <div
      ref={shellRef}
      className="excalidraw-editor-shell"
      onKeyDownCapture={handleKeyDownCapture}
      onContextMenuCapture={handleContextMenuCapture}
    >
      <Excalidraw
        excalidrawAPI={handleApi}
        onChange={handleChange}
        UIOptions={EXCALIDRAW_UI_OPTIONS}
      />
    </div>
  );
};
