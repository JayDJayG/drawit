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

export type ShortcutsDialogProps = {
  open: boolean;
  coarse: boolean;
  onOpenChange: (open: boolean) => void;
};

const SHORTCUTS: ReadonlyArray<{ keys: string[]; action: string }> = [
  { keys: ['Y'], action: 'Suggest a tidier stroke' },
  { keys: ['Shift', 'Y'], action: 'Suggest a diagram' },
  { keys: ['Enter'], action: 'Apply the suggestion' },
  {
    keys: ['Esc'],
    action: import.meta.env.DEV
      ? 'Dismiss the suggestion, or cancel Interpret'
      : 'Dismiss the suggestion',
  },
  { keys: ['Ctrl', 'Z'], action: 'Undo (⌘ Z on a Mac)' },
  { keys: ['?'], action: 'Excalidraw’s own drawing shortcuts' },
];

const useStyles = makeStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  heading: {
    margin: `${tokens.spacingVerticalS} 0 0`,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase400,
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    margin: '0',
    paddingLeft: tokens.spacingHorizontalXL,
  },
  table: {
    borderCollapse: 'collapse',
    width: '100%',
    '& th, & td': {
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      textAlign: 'left',
      verticalAlign: 'top',
    },
    '& th': {
      color: tokens.colorNeutralForeground2,
      fontWeight: tokens.fontWeightSemibold,
    },
  },
  keys: {
    whiteSpace: 'nowrap',
  },
  key: {
    display: 'inline-block',
    minWidth: '1.6em',
    margin: `0 ${tokens.spacingHorizontalXXS}`,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderBottomWidth: '2px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase200,
    textAlign: 'center',
  },
  note: {
    margin: '0',
    color: tokens.colorNeutralForeground2,
  },
});

export const ShortcutsDialog = ({ open, coarse, onOpenChange }: ShortcutsDialogProps) => {
  const styles = useStyles();
  const action = coarse ? 'Tap' : 'Click';

  return (
    <Dialog open={open} onOpenChange={(_event, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Shortcuts and tips</DialogTitle>
          <DialogContent className={styles.content}>
            <h3 className={styles.heading}>How it works</h3>
            <ol className={styles.steps}>
              <li>Draw with the pen. Select strokes if you want help with only some of them.</li>
              <li>
                Press <strong>Suggest</strong> to tidy a stroke, or <strong>Diagram</strong> to turn
                sketched boxes and arrows into a clean diagram.
              </li>
              <li>
                Check the dashed preview. {action} an item to include or exclude it, then choose
                {' '}<strong>Apply</strong> or <strong>Dismiss</strong>. Your drawing doesn’t change until you apply.
              </li>
            </ol>
            <h3 className={styles.heading}>Keyboard shortcuts</h3>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Keys</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {SHORTCUTS.map(({ keys, action: shortcutAction }) => (
                  <tr key={shortcutAction}>
                    <td className={styles.keys}>
                      {keys.map((key, index) => (
                        <span key={key}>
                          {index > 0 && '+'}
                          <kbd className={styles.key}>{key}</kbd>
                        </span>
                      ))}
                    </td>
                    <td>{shortcutAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.note}>Shortcuts work while the canvas has focus.</p>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
