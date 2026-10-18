import {
  Button,
  Card,
  Link,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { CanvasAdapterState } from '../canvas/excalidraw/types';

type SuggestionPanelProps = {
  state: CanvasAdapterState;
  onSuggest: () => void;
  onApply: () => void;
  onDismiss: () => void;
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
});

export const SuggestionPanel = ({
  state,
  onSuggest,
  onApply,
  onDismiss,
}: SuggestionPanelProps) => {
  const styles = useStyles();
  const statusClass = state.statusKind === 'ready' ? styles.statusReady : undefined;

  return (
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
      </div>
      <div className={`${styles.status} ${statusClass ?? ''}`} role="status" aria-live="polite">
        {state.status}
      </div>
      <div className={styles.footer}>
        <Text size={200}>
          {state.selectedStrokeCount > 1
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
  );
};
