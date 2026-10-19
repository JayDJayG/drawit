import {
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Link,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useState } from 'react';
import type { CanvasAdapterState } from '../canvas/excalidraw/types';

type SuggestionPanelProps = {
  state: CanvasAdapterState;
  mermaidCode: string;
  mermaidUnboundArrows: number;
  onSuggest: () => void;
  onSuggestDiagram: () => void;
  onT2: () => void;
  t2Available: boolean;
  t2Busy: boolean;
  t2Configured?: boolean;
  t2Reason?: string;
  onApply: () => void;
  onDismiss: () => void;
  onExportMermaid: () => void;
  onExportSvg: () => void;
};

const useStyles = makeStyles({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  title: {
    fontWeight: tokens.fontWeightSemibold,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  status: {
    minHeight: '20px',
    color: tokens.colorNeutralForeground2,
  },
  statusReady: {
    color: tokens.colorBrandForeground1,
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  key: {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: '1.4em',
    justifyContent: 'center',
    marginLeft: tokens.spacingHorizontalXS,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
  },
  code: {
    maxHeight: '50vh',
    overflow: 'auto',
    margin: 0,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre',
  },
  dialogNote: {
    color: tokens.colorNeutralForeground2,
  },
});

export const SuggestionPanel = ({
  state,
  mermaidCode,
  mermaidUnboundArrows,
  onSuggest,
  onSuggestDiagram,
  onT2,
  t2Available,
  t2Busy,
  t2Configured,
  t2Reason,
  onApply,
  onDismiss,
  onExportMermaid,
  onExportSvg,
}: SuggestionPanelProps) => {
  const styles = useStyles();
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const statusClass = state.statusKind === 'ready' ? styles.statusReady : undefined;
  const exportsDisabled = !state.canExport || state.hasPendingSuggestion;
  const exportReason = !state.canExport
    ? 'Draw or apply a diagram before exporting.'
    : state.hasPendingSuggestion
      ? 'Apply or dismiss the pending preview before exporting.'
      : undefined;

  const openMermaid = () => {
    onExportMermaid();
    setCopyStatus('');
    setMermaidOpen(true);
  };

  const copyMermaid = async () => {
    try {
      await navigator.clipboard.writeText(mermaidCode);
      setCopyStatus('Copied Mermaid to the clipboard.');
    } catch {
      setCopyStatus('Clipboard access was unavailable. Select the code to copy it.');
    }
  };

  const downloadMermaid = () => {
    const blob = new Blob([mermaidCode], { type: 'text/vnd.mermaid; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'drawit.mmd';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <>
      <Card className={styles.panel} aria-label="Drawit suggestion controls">
        <div className={styles.header}>
          <Text className={styles.title} size={500}>
            Drawit assistance
          </Text>
          <Text size={300}>
            Select strokes with Excalidraw, or target the last freedraw stroke.
          </Text>
        </div>
        <div className={styles.actions}>
          <Tooltip content="Suggest an improvement for the selection, or the last stroke (Y)" relationship="label">
            <Button
              appearance="primary"
              aria-label="Suggest an improvement (Y)"
              disabled={!state.canSuggest || state.hasPendingSuggestion}
              onClick={onSuggest}
            >
              Suggest
              <span className={styles.key}>Y</span>
            </Button>
          </Tooltip>
          <Tooltip content="Suggest a diagram from strokes and typed labels (Shift+Y)" relationship="label">
            <Button
              aria-label="Suggest a diagram (Shift+Y)"
              disabled={!state.canSuggestDiagram || state.hasPendingSuggestion}
              onClick={onSuggestDiagram}
            >
              Diagram
              <span className={styles.key}>Shift+Y</span>
            </Button>
          </Tooltip>
          {import.meta.env.DEV && (
            <Tooltip
              content={t2Configured === false
                ? t2Reason ?? 'Add DEEPSEEK_API_KEY to .env.local, then press Interpret again.'
                : 'Interpret with DeepSeek (development only). Sends your strokes, typed text and a marked PNG of them to DeepSeek.'}
              relationship="label"
            >
              <Button
                aria-label={t2Busy ? 'Cancel Interpret' : 'Interpret with DeepSeek'}
                disabled={!t2Available || (!t2Busy && (!state.canSuggestDiagram || state.hasPendingSuggestion))}
                onClick={onT2}
              >
                {t2Busy ? 'Cancel Interpret' : 'Interpret'}
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Apply the visible suggestion (Enter)" relationship="label">
            <Button
              aria-label="Apply the suggestion (Enter)"
              disabled={!state.hasPendingSuggestion}
              onClick={onApply}
            >
              Apply
              <span className={styles.key}>Enter</span>
            </Button>
          </Tooltip>
          <Tooltip content="Dismiss the visible suggestion (Escape)" relationship="label">
            <Button
              appearance="subtle"
              aria-label="Dismiss the suggestion (Escape)"
              disabled={!state.hasPendingSuggestion}
              onClick={onDismiss}
            >
              Dismiss
              <span className={styles.key}>Esc</span>
            </Button>
          </Tooltip>
          <Tooltip content={exportReason ?? 'Open a Mermaid export of the live native diagram.'} relationship="label">
            <Button
              aria-label="Export Mermaid"
              disabled={exportsDisabled}
              onClick={openMermaid}
            >
              Export Mermaid
            </Button>
          </Tooltip>
          <Tooltip content={exportReason ?? 'Download an SVG export of the live native diagram.'} relationship="label">
            <Button
              aria-label="Export SVG"
              disabled={exportsDisabled}
              onClick={onExportSvg}
            >
              Export SVG
            </Button>
          </Tooltip>
        </div>
        <div className={`${styles.status} ${statusClass ?? ''}`} role="status" aria-live="polite">
          {state.status}
        </div>
        <div className={styles.footer}>
          <Text size={200}>
            {state.hasPendingSuggestion
              ? 'Click a dashed item to reject or restore it. Exports wait until the preview is applied.'
              : state.selectedStrokeCount > 1
                ? `${state.selectedStrokeCount} freedraw strokes selected`
                : 'Suggestions are always previews first.'}
          </Text>
          <Link
            href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.md`}
            target="_blank"
            rel="noreferrer"
          >
            Third-party notices
          </Link>
        </div>
      </Card>
      <Dialog
        open={mermaidOpen}
        onOpenChange={(_event, data) => setMermaidOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Mermaid export</DialogTitle>
            <DialogContent>
              <pre className={styles.code}>{mermaidCode}</pre>
              {mermaidUnboundArrows > 0 && (
                <Text className={styles.dialogNote}>
                  {mermaidUnboundArrows} unbound arrow{mermaidUnboundArrows === 1 ? '' : 's'} {mermaidUnboundArrows === 1 ? 'was' : 'were'} left out.
                </Text>
              )}
              {copyStatus && <Text className={styles.dialogNote}>{copyStatus}</Text>}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={copyMermaid}>Copy</Button>
              <Button onClick={downloadMermaid}>Download .mmd</Button>
              <Button appearance="subtle" onClick={() => setMermaidOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
};
