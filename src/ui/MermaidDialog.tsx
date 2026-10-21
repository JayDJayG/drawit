import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useId, useState } from 'react';
import { CopyIcon, ExportIcon } from './icons';

export type MermaidDialogProps = {
  open: boolean;
  code: string;
  unboundArrows: number;
  onOpenChange: (open: boolean) => void;
};

const useStyles = makeStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  description: {
    margin: '0',
    color: tokens.colorNeutralForeground2,
  },
  code: {
    maxHeight: '50vh',
    margin: '0',
    overflow: 'auto',
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre',
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '2px',
    },
  },
  note: {
    margin: '0',
    color: tokens.colorNeutralForeground2,
  },
  feedback: {
    minHeight: tokens.lineHeightBase300,
    margin: '0',
    color: tokens.colorNeutralForeground2,
  },
});

export const MermaidDialog = ({
  open,
  code,
  unboundArrows,
  onOpenChange,
}: MermaidDialogProps) => {
  const styles = useStyles();
  const descriptionId = useId();
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (open) {
      setFeedback('');
    }
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setFeedback('Copied to the clipboard.');
    } catch {
      setFeedback('The clipboard isn’t available here. Select the code and copy it instead.');
    }
  };

  const download = () => {
    const blob = new Blob([code], { type: 'text/vnd.mermaid; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'drawit.mmd';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setFeedback('Downloaded drawit.mmd.');
  };

  return (
    <Dialog open={open} onOpenChange={(_event, data) => onOpenChange(data.open)}>
      <DialogSurface aria-describedby={descriptionId}>
        <DialogBody>
          <DialogTitle>Mermaid code</DialogTitle>
          <DialogContent className={styles.content}>
            <p id={descriptionId} className={styles.description}>
              Your diagram as a Mermaid flowchart. Paste it into Markdown, GitHub or any Mermaid editor.
            </p>
            <pre
              className={styles.code}
              tabIndex={0}
              role="region"
              aria-label="Mermaid code"
            >
              {code}
            </pre>
            {unboundArrows > 0 && (
              <p className={styles.note}>
                {unboundArrows === 1
                  ? '1 arrow that isn’t connected at both ends was left out.'
                  : `${unboundArrows} arrows that aren’t connected at both ends were left out.`}
              </p>
            )}
            <p className={styles.feedback} aria-live="polite">{feedback}</p>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" icon={<CopyIcon />} onClick={copy}>Copy</Button>
            <Button icon={<ExportIcon />} onClick={download}>Download</Button>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="subtle">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
