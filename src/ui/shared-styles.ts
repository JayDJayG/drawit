import { tokens } from '@fluentui/react-components';
import type { GriffelStyle } from '@fluentui/react-components';

/** Hides content visually while keeping it available to screen readers. */
export const visuallyHidden: GriffelStyle = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: '0',
};

export const spinning: GriffelStyle = {
  animationName: {
    from: { transform: 'rotate(0deg)' },
    to: { transform: 'rotate(360deg)' },
  },
  animationDuration: '0.9s',
  animationIterationCount: 'infinite',
  animationTimingFunction: 'linear',
  '@media (prefers-reduced-motion: reduce)': {
    animationDuration: '2.4s',
  },
};

/** The shared look of Drawit's surfaces that float over the canvas. */
export const floatingSurface: GriffelStyle = {
  border: `1px solid ${tokens.colorNeutralStroke1}`,
  borderRadius: tokens.borderRadiusXLarge,
  backgroundColor: tokens.colorNeutralBackground1,
  boxShadow: tokens.shadow16,
  pointerEvents: 'auto',
};
