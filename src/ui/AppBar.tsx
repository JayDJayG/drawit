import {
  Menu,
  MenuButton,
  MenuItem,
  MenuItemLink,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import {
  CodeIcon,
  DiagramIcon,
  DocumentIcon,
  ExportIcon,
  ImageIcon,
  KeyboardIcon,
  MoreIcon,
  SparkleIcon,
  SpinnerIcon,
  WandIcon,
} from './icons';
import { spinning, visuallyHidden } from './shared-styles';

export type InterpretControlState = {
  available: boolean;
  busy: boolean;
  configured?: boolean;
  reason?: string;
};

export type AppBarProps = {
  ready: boolean;
  reviewing: boolean;
  canExport: boolean;
  /** Narrow screens show icon-only secondary commands. */
  compact: boolean;
  /** Touch-first screens get larger targets and no keyboard hints. */
  coarse: boolean;
  /** Present only in development builds. */
  interpret?: InterpretControlState;
  onSuggest: () => void;
  onSuggestDiagram: () => void;
  onInterpret: () => void;
  onExportMermaid: () => void;
  onExportSvg: () => void;
  onShowShortcuts: () => void;
};

const REVIEWING_REASON = 'Apply or dismiss the current suggestion first.';
const LOADING_REASON = 'The canvas is still loading.';
const SOURCE_URL = 'https://github.com/JayDJayG/drawit';

const useStyles = makeStyles({
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    height: '48px',
    flexShrink: 0,
    padding: `0 ${tokens.spacingHorizontalS} 0 ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  logo: {
    display: 'block',
    width: '24px',
    height: '24px',
    flexShrink: 0,
  },
  // The development-only Interpret button needs the logo's room on tiny screens.
  logoYields: {
    '@media (max-width: 359px)': {
      display: 'none',
    },
  },
  wordmark: {
    margin: '0',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase400,
    whiteSpace: 'nowrap',
    '@media (max-width: 479px)': visuallyHidden,
  },
  tagline: {
    minWidth: 0,
    margin: '0',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (max-width: 1023px)': {
      display: 'none',
    },
  },
  toolbar: {
    flexShrink: 0,
    gap: tokens.spacingHorizontalXS,
    marginLeft: 'auto',
    padding: '0',
  },
  // Coarse pointers get 40 px targets while keeping the compact text size.
  touchTarget: {
    minWidth: '40px',
    minHeight: '40px',
  },
  compactDivider: {
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
  },
  menuPopover: {
    // Menus render inline (inside the banner landmark), so they must clear
    // Excalidraw's own layers, whose popovers reach z-index 10.
    zIndex: 20,
  },
  spin: spinning,
  hidden: visuallyHidden,
});

type InterpretButtonProps = {
  interpret: InterpretControlState;
  assistReason?: string;
  compact: boolean;
  className?: string;
  spinClassName: string;
  onInterpret: () => void;
};

const InterpretButton = ({
  interpret,
  assistReason,
  compact,
  className,
  spinClassName,
  onInterpret,
}: InterpretButtonProps) => {
  const { busy } = interpret;
  const reason = !interpret.available
    ? 'Interpret is starting.'
    : busy
      ? undefined
      : assistReason;
  const description = busy
    ? 'Stop the Interpret request.'
    : reason
      ?? (interpret.configured === false
        ? interpret.reason ?? 'Add DEEPSEEK_API_KEY to .env.local, then press Interpret again.'
        : 'Read the whole sketch with DeepSeek (development only). Sends your strokes, typed text and a marked image of them to DeepSeek.');

  return (
    <Tooltip content={description} relationship="description">
      <ToolbarButton
        className={className}
        icon={busy ? <SpinnerIcon className={spinClassName} /> : <WandIcon />}
        aria-label={busy ? 'Cancel Interpret' : compact ? 'Interpret' : undefined}
        disabledFocusable={Boolean(reason)}
        onClick={onInterpret}
      >
        {compact ? undefined : busy ? 'Cancel' : 'Interpret'}
      </ToolbarButton>
    </Tooltip>
  );
};

export const AppBar = ({
  ready,
  reviewing,
  canExport,
  compact,
  coarse,
  interpret,
  onSuggest,
  onSuggestDiagram,
  onInterpret,
  onExportMermaid,
  onExportSvg,
  onShowShortcuts,
}: AppBarProps) => {
  const styles = useStyles();
  // Dialogs opened from these menus hand focus back to the menu button on close.
  const restoreFocusTarget = useRestoreFocusTarget();
  const target = coarse ? styles.touchTarget : undefined;
  const assistReason = !ready ? LOADING_REASON : reviewing ? REVIEWING_REASON : undefined;
  const shortcut = (keys: string) => (coarse ? '' : ` Shortcut: ${keys}.`);
  const exportReason = !ready
    ? LOADING_REASON
    : !canExport
      ? 'Draw something first.'
      : reviewing
        ? REVIEWING_REASON
        : undefined;

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <img
          className={mergeClasses(
            styles.logo,
            import.meta.env.DEV && interpret && styles.logoYields,
          )}
          src={`${import.meta.env.BASE_URL}favicon.svg`}
          alt=""
          width={24}
          height={24}
        />
        <h1 className={styles.wordmark}>Drawit</h1>
        <p className={styles.tagline}>Extend what your hands can draw</p>
      </div>
      <Toolbar
        className={styles.toolbar}
        aria-label="Drawing assistant"
      >
        <Tooltip
          content={assistReason ?? `Tidy your last stroke, or the strokes you selected.${shortcut('Y')}`}
          relationship="description"
        >
          <ToolbarButton
            className={target}
            appearance="primary"
            icon={<SparkleIcon />}
            aria-keyshortcuts="Y"
            disabledFocusable={Boolean(assistReason)}
            onClick={onSuggest}
          >
            Suggest
          </ToolbarButton>
        </Tooltip>
        <Tooltip
          content={assistReason ?? `Turn sketched boxes, arrows and labels into a clean diagram.${shortcut('Shift+Y')}`}
          relationship="description"
        >
          <ToolbarButton
            className={target}
            icon={<DiagramIcon />}
            aria-label={compact ? 'Diagram' : undefined}
            aria-keyshortcuts="Shift+Y"
            disabledFocusable={Boolean(assistReason)}
            onClick={onSuggestDiagram}
          >
            {compact ? undefined : 'Diagram'}
          </ToolbarButton>
        </Tooltip>
        {/* The DEV check lets production builds drop the Interpret button entirely. */}
        {import.meta.env.DEV && interpret && (
          <InterpretButton
            interpret={interpret}
            assistReason={assistReason}
            compact={compact}
            className={target}
            spinClassName={styles.spin}
            onInterpret={onInterpret}
          />
        )}
        <ToolbarDivider className={compact ? styles.compactDivider : undefined} />
        <Menu positioning="below-end" inline>
          <MenuTrigger disableButtonEnhancement>
            <MenuButton
              {...restoreFocusTarget}
              className={target}
              appearance="subtle"
              icon={<ExportIcon />}
              aria-label={compact ? 'Export' : undefined}
            >
              {compact ? undefined : 'Export'}
            </MenuButton>
          </MenuTrigger>
          <MenuPopover className={styles.menuPopover}>
            <MenuList>
              <MenuItem
                icon={<CodeIcon />}
                disabled={Boolean(exportReason)}
                subText={exportReason ?? 'Flowchart text for Markdown and GitHub'}
                onClick={onExportMermaid}
              >
                Mermaid code…
              </MenuItem>
              <MenuItem
                icon={<ImageIcon />}
                disabled={Boolean(exportReason)}
                subText={exportReason ?? 'Download the drawing as a picture'}
                onClick={onExportSvg}
              >
                SVG image
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
        <Menu positioning="below-end" inline>
          <MenuTrigger disableButtonEnhancement>
            <Tooltip content="More" relationship="label">
              <ToolbarButton
                {...restoreFocusTarget}
                className={target}
                appearance="subtle"
                icon={<MoreIcon />}
              />
            </Tooltip>
          </MenuTrigger>
          <MenuPopover className={styles.menuPopover}>
            <MenuList>
              <MenuItem icon={<KeyboardIcon />} onClick={onShowShortcuts}>
                Shortcuts and tips
              </MenuItem>
              <MenuItemLink
                icon={<DocumentIcon />}
                href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.md`}
                target="_blank"
                rel="noreferrer"
              >
                Third-party notices
                <span className={styles.hidden}> (opens in a new tab)</span>
              </MenuItemLink>
              <MenuItemLink
                icon={<CodeIcon />}
                href={SOURCE_URL}
                target="_blank"
                rel="noreferrer"
              >
                Source code
                <span className={styles.hidden}> (opens in a new tab)</span>
              </MenuItemLink>
            </MenuList>
          </MenuPopover>
        </Menu>
      </Toolbar>
    </header>
  );
};
