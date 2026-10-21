import type { ReactNode } from 'react';

type IconProps = {
  className?: string;
};

const Icon = ({ children, className }: IconProps & { children: ReactNode }) => (
  <svg
    className={className}
    width="1em"
    height="1em"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

export const SparkleIcon = (props: IconProps) => (
  <Icon {...props}>
    <path
      d="M8.5 2.5 10.2 6.8 14.5 8.5 10.2 10.2 8.5 14.5 6.8 10.2 2.5 8.5 6.8 6.8Z"
      fill="currentColor"
      strokeWidth={1}
    />
    <path
      d="M15 12 15.9 14.1 18 15 15.9 15.9 15 18 14.1 15.9 12 15 14.1 14.1Z"
      fill="currentColor"
      strokeWidth={1}
    />
  </Icon>
);

export const DiagramIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="2.5" width="7" height="5" rx="1.2" />
    <rect x="10.5" y="12.5" width="7" height="5" rx="1.2" />
    <path d="M6 7.5V15h4.5M8.5 13l2 2-2 2" />
  </Icon>
);

export const WandIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 17 12 8M10.5 6.5l3 3M14.5 2.5v4M12.5 4.5h4M16 10.5v3M14.5 12h3" />
  </Icon>
);

export const ExportIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 3v9.5M6.5 9l3.5 3.5L13.5 9M3.5 13.5v3h13v-3" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="4.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 10.5 4 4L16 6" />
  </Icon>
);

export const DismissIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Icon>
);

export const UndoIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7.5 4.5 4 8l3.5 3.5M4.5 8h7a4.5 4.5 0 0 1 0 9H8" />
  </Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M10 9v5" />
    <circle cx="10" cy="6.3" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const SuccessIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="m6.5 10.2 2.5 2.5 4.5-4.9" />
  </Icon>
);

export const WarningIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 3 18 16.5H2Z" />
    <path d="M10 8v3.5" />
    <circle cx="10" cy="14" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const KeyboardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="5" width="16" height="10" rx="1.5" />
    <path d="M5 8.5h.01M8 8.5h.01M11 8.5h.01M14 8.5h.01M7 11.5h6" />
  </Icon>
);

export const CodeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7.5 5.5 3 10l4.5 4.5M12.5 5.5 17 10l-4.5 4.5" />
  </Icon>
);

export const DocumentIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 2.5h6.5L15 6v11.5H5Z" />
    <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
  </Icon>
);

export const ImageIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
    <circle cx="7" cy="8" r="1.5" />
    <path d="m3 15 5-4.5 3.5 3 2-2 3.5 3" />
  </Icon>
);

export const SpinnerIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10" cy="10" r="7" opacity="0.25" />
    <path d="M10 3a7 7 0 0 1 7 7" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5H5" />
  </Icon>
);
