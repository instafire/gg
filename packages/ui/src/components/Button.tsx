import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from "react";

export type ButtonVariant = "primary" | "ghost" | "destructive";

interface ButtonOwnProps {
  variant?: ButtonVariant;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Stable test id from the registry (../testids) — never encodes data. */
  "data-testid"?: string;
}

export type ButtonProps = ButtonOwnProps &
  (
    | (ButtonHTMLAttributes<HTMLButtonElement> & { href?: never })
    | (AnchorHTMLAttributes<HTMLAnchorElement> & { href: string })
  );

const baseStyle: CSSProperties = {
  alignItems: "center",
  borderRadius: "var(--radius-lg)",
  cursor: "pointer",
  display: "inline-flex",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-body)",
  fontWeight: 600,
  gap: "var(--space-2)",
  justifyContent: "center",
  minHeight: "var(--touch-min)",
  padding: "0 var(--space-5)",
  textDecoration: "none",
  transition:
    "background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)",
};

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: {
    backgroundColor: "var(--accent)",
    border: "1px solid transparent",
    color: "var(--accent-ink)",
  },
  ghost: {
    backgroundColor: "transparent",
    border: "1px solid var(--border)",
    color: "var(--text)",
  },
  destructive: {
    backgroundColor: "var(--danger)",
    border: "1px solid transparent",
    color: "#ffffff",
  },
};

/**
 * GG Button (DESIGN_SYSTEM §8.1). Renders an <a> when `href` is given,
 * otherwise a <button>. Focus ring comes from the brand standard in
 * tokens.css (:focus-visible, 3px --focus outline).
 */
export function Button(props: ButtonProps) {
  const { variant = "primary", children, className, style, ...rest } = props;
  const mergedStyle: CSSProperties = {
    ...baseStyle,
    ...variantStyles[variant],
    ...style,
  };

  if ("href" in rest && typeof rest.href === "string") {
    const anchorProps = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a {...anchorProps} className={className} style={mergedStyle}>
        {children}
      </a>
    );
  }

  const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button {...buttonProps} className={className} style={mergedStyle} type={buttonProps.type ?? "button"}>
      {children}
    </button>
  );
}
