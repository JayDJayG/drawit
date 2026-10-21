import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PendingReview } from '../canvas/excalidraw/types';
import { CheckIcon, DismissIcon, SparkleIcon } from './icons';
import { placeReviewBar } from './review-placement';
import type { Insets } from './review-placement';
import { floatingSurface } from './shared-styles';

/** Keeps the bar clear of Excalidraw's toolbar, footer and mobile bars. */
const REVIEW_BAR_INSETS: Insets = { top: 72, right: 12, bottom: 80, left: 12 };

export type ReviewBarProps = {
  review: PendingReview;
  coarse: boolean;
  onApply: () => void;
  onDismiss: () => void;
};

const useStyles = makeStyles({
  bar: {
    ...floatingSurface,
    position: 'absolute',
    top: '0',
    left: '0',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
    boxSizing: 'border-box',
    maxWidth: 'min(560px, calc(100% - 24px))',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderTop: `3px solid ${tokens.colorBrandStroke1}`,
  },
  measuring: {
    visibility: 'hidden',
  },
  text: {
    display: 'flex',
    flex: '1 1 220px',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase300,
  },
  titleIcon: {
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    fontSize: '16px',
  },
  detail: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  warning: {
    color: tokens.colorStatusWarningForeground3,
  },
  actions: {
    display: 'flex',
    flexShrink: 0,
    gap: tokens.spacingHorizontalS,
    marginLeft: 'auto',
  },
});

export const ReviewBar = ({ review, coarse, onApply, onDismiss }: ReviewBarProps) => {
  const styles = useStyles();
  const barRef = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const { anchor } = review;

  useLayoutEffect(() => {
    const bar = barRef.current;
    const container = bar?.parentElement;
    if (!bar || !container) {
      return undefined;
    }
    const update = () => {
      const placement = placeReviewBar(
        anchor,
        { width: container.clientWidth, height: container.clientHeight },
        { width: bar.offsetWidth, height: bar.offsetHeight },
        REVIEW_BAR_INSETS,
      );
      const top = Math.round(placement.top);
      const left = Math.round(placement.left);
      setPosition((current) => {
        return current?.top === top && current.left === left ? current : { top, left };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    observer.observe(container);
    return () => observer.disconnect();
  }, [anchor]);

  const nothingIncluded = review.includedCount === 0;
  const partial = review.totalCount > 1 && review.includedCount < review.totalCount;
  const detail = partial
    ? `${review.detail} · ${review.includedCount} of ${review.totalCount} included`
    : review.detail;
  const action = coarse ? 'Tap' : 'Click';
  const pickHint = nothingIncluded
    ? `Nothing is included. ${action} an item to include it, or dismiss.`
    : review.totalCount > 1
      ? `${action} an item to include or exclude it`
      : undefined;
  // Its own line, so a narrow bar never strands half of the shortcuts.
  const keyHint = !coarse && !nothingIncluded ? 'Enter applies · Esc dismisses' : undefined;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    }
  };

  return (
    <div
      ref={barRef}
      className={mergeClasses(styles.bar, !position && styles.measuring)}
      style={position ? { transform: `translate(${position.left}px, ${position.top}px)` } : undefined}
      role="group"
      aria-label="Review suggestion"
      aria-describedby={detailId}
      data-drawit-review-bar=""
      onKeyDown={handleKeyDown}
    >
      <div className={styles.text}>
        <span className={styles.title}>
          <SparkleIcon className={styles.titleIcon} />
          {review.title}
        </span>
        <span id={detailId} className={styles.detail}>{detail}</span>
        {pickHint && (
          <span className={mergeClasses(styles.hint, nothingIncluded && styles.warning)}>
            {pickHint}
          </span>
        )}
        {keyHint && <span className={styles.hint}>{keyHint}</span>}
      </div>
      <div className={styles.actions}>
        <Button
          appearance="subtle"
          size={coarse ? 'large' : 'medium'}
          icon={<DismissIcon />}
          aria-keyshortcuts="Escape"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
        <Button
          appearance="primary"
          size={coarse ? 'large' : 'medium'}
          icon={<CheckIcon />}
          aria-keyshortcuts="Enter"
          disabledFocusable={nothingIncluded}
          onClick={onApply}
        >
          Apply
        </Button>
      </div>
    </div>
  );
};
