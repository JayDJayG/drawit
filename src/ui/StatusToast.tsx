import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { KeyboardEvent, ReactElement } from 'react';
import type { SuggestionStatus } from '../canvas/excalidraw/types';
import {
  DismissIcon,
  InfoIcon,
  SpinnerIcon,
  SuccessIcon,
  UndoIcon,
  WarningIcon,
} from './icons';
import { floatingSurface, spinning } from './shared-styles';

export type StatusToastProps = {
  status: string;
  kind: SuggestionStatus;
  /** A request is running; the toast offers to cancel it. */
  busy: boolean;
  canUndo: boolean;
  coarse: boolean;
  onUndo: () => void;
  onCancel: () => void;
  onClose: () => void;
};

const useStyles = makeStyles({
  toast: {
    ...floatingSurface,
    position: 'absolute',
    left: '50%',
    bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))',
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    boxSizing: 'border-box',
    width: 'max-content',
    maxWidth: 'min(560px, calc(100% - 24px))',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS} ${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    transform: 'translateX(-50%)',
  },
  icon: {
    display: 'flex',
    flexShrink: 0,
    fontSize: '20px',
  },
  neutral: {
    color: tokens.colorNeutralForeground3,
  },
  success: {
    color: tokens.colorStatusSuccessForeground1,
  },
  warning: {
    color: tokens.colorStatusWarningForeground3,
  },
  danger: {
    color: tokens.colorStatusDangerForeground1,
  },
  progress: {
    color: tokens.colorBrandForeground1,
  },
  spin: spinning,
  text: {
    minWidth: 0,
    padding: `${tokens.spacingVerticalXS} 0`,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
});

export const StatusToast = ({
  status,
  kind,
  busy,
  canUndo,
  coarse,
  onUndo,
  onCancel,
  onClose,
}: StatusToastProps) => {
  const styles = useStyles();
  const size = coarse ? 'large' : 'medium';

  let icon: ReactElement;
  let tone: string;
  if (busy) {
    icon = <SpinnerIcon className={styles.spin} />;
    tone = styles.progress;
  } else if (kind === 'applied') {
    icon = <SuccessIcon />;
    tone = styles.success;
  } else if (kind === 'error') {
    icon = <WarningIcon />;
    tone = styles.danger;
  } else if (
    kind === 'nothing-to-improve'
    || kind === 'no-freehand-selection'
    || kind === 'not-a-box'
  ) {
    icon = <InfoIcon />;
    tone = styles.warning;
  } else {
    icon = <InfoIcon />;
    tone = styles.neutral;
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      onCancel();
    } else {
      onClose();
    }
  };

  return (
    <div className={styles.toast} data-drawit-toast={kind} onKeyDown={handleKeyDown}>
      <span className={mergeClasses(styles.icon, tone)}>{icon}</span>
      <span className={styles.text}>{status}</span>
      <span className={styles.actions}>
        {kind === 'applied' && canUndo && !busy && (
          <Button size={size} icon={<UndoIcon />} onClick={onUndo}>
            Undo
          </Button>
        )}
        {busy && (
          <Button size={size} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          appearance="subtle"
          size={size}
          icon={<DismissIcon />}
          aria-label="Close message"
          onClick={onClose}
        />
      </span>
    </div>
  );
};
