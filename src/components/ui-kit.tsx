/**
 * ui-kit.tsx — AI Rankia Ads premium UI kit (dark-first, "quiet & expensive").
 *
 * AESTHETIC: luxury-refined enterprise with an editorial signature — serif
 * display typography (Newsreader, --font-display) over a near-black
 * instrument panel; Instrument Sans (--font-ui) for all UI text.
 *
 * SERVER-SAFE: no hooks, no "use client". Every export is a pure function of
 * props + inline style objects, so it works in BOTH server and client
 * components. Color tokens are CSS custom properties (var(--uik-*), defined
 * in globals.css under .dark/.light), so every ui-kit surface — including
 * server-rendered ones — follows the theme toggle automatically.
 *
 * MOTION: PageHeader/Card/StatCard render with the `.rise` class
 * (globals.css); sibling stagger is pure CSS :nth-child — no page edits and
 * no API change required.
 *
 * PUBLIC API
 *   UI                                       — style tokens (colors, radii, maxWidth)
 *   <PageHeader title subtitle? actions? />  — serif display title + hairline divider
 *   <Card style?>…</Card>                    — surface card: radius 12, 1px border, padding 24
 *   <StatCard label value sub? tone? />      — KPI stat; `tone` colors the `sub` line
 *                                              (tone: "ok" | "warn" | "danger" | "muted")
 *   <SectionLabel>…</SectionLabel>           — 11px uppercase tracking muted label
 *   DataTable primitives (compose with a plain <tbody>):
 *     <DataTable>
 *       <THead cols={[{ label: "Campaña" }, { label: "Coste", align: "right" }]} />
 *       <tbody>
 *         <Row>
 *           <Cell>Search — ES</Cell>
 *           <Cell align="right" mono>1.240,50 €</Cell>
 *         </Row>
 *       </tbody>
 *     </DataTable>
 *   <Badge tone="ok|warn|danger|muted|accent" dot?>…</Badge>
 *     — tinted pill; `dot` renders the quiet 6px-dot status variant instead
 *   <EmptyState title hint? action? />       — serif italic title + CSS ornament
 *   <ErrorCard message />                    — quiet red-tinted alert
 *   <PrimaryButton|SecondaryButton|GhostDangerButton href? …props>
 *     — plain <button type="button"> by default; renders an <a> when `href`
 *       is given. Pass onClick etc. from client components only.
 *
 * Note: when a Card directly wraps a DataTable, use <Card style={{ padding: 0 }}>
 * and let the table cells provide the spacing.
 */

import type { CSSProperties, ReactNode } from "react";
import React from "react";

/* ---------------------------------------------------------------------------
 * Tokens (dark palette — the app is dark-first)
 * ------------------------------------------------------------------------- */

export const UI = {
  /** Page background */
  bg: "var(--uik-bg)",
  /** Card / raised surface */
  surface: "var(--uik-surface)",
  /** Second-level surface (active nav item, inset wells) */
  surface2: "var(--uik-surface2)",
  /** The only border. Always 1px hairline, never shadows. */
  border: "var(--uik-border)",
  /** Emphasized hairline (hover borders, ornaments). */
  borderStrong: "var(--uik-border-strong)",
  /** Card top hairline (subtle luminosity in dark; plain border in light). */
  borderTop: "var(--uik-border-top)",
  /** Table row hover */
  hover: "var(--uik-hover)",
  text: "var(--uik-text)",
  muted: "var(--uik-muted)",
  faint: "var(--uik-faint)",
  /** Sparingly: primary actions, active states, positive deltas ONLY. */
  accent: "var(--uik-accent)",
  /** Accent wash for active/selected fills. */
  accentSoft: "var(--uik-accent-soft)",
  /** Accent hairline segments (PageHeader divider, row-hover bar). */
  accentHairline: "var(--uik-accent-hairline)",
  danger: "var(--uik-danger)",
  warn: "var(--uik-warn)",
  radius: 12,
  radiusSm: 8,
  maxWidth: 1150,
  fontMono: "var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace",
  /** Editorial serif — display moments ONLY (page titles, empty states). */
  fontDisplay: "var(--font-display), Georgia, 'Times New Roman', serif",
} as const;

/* ---------------------------------------------------------------------------
 * Page header — the editorial signature: Newsreader 30px/500 over the panel,
 * closed by a hairline divider with an 80px accent segment.
 * ------------------------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  actions,
  style,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="rise" style={{ marginBottom: 32, ...style }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              fontFamily: UI.fontDisplay,
              fontSize: 30,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              lineHeight: 1.15,
              color: UI.text,
              margin: 0,
            }}
          >
            {title}
          </h1>
          {subtitle != null && (
            <p style={{ fontSize: 13.5, color: UI.muted, margin: "7px 0 0", lineHeight: 1.5 }}>
              {subtitle}
            </p>
          )}
        </div>
        {actions != null && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {actions}
          </div>
        )}
      </div>
      {/* Hairline divider with an 80px accent segment on the left */}
      <div
        aria-hidden="true"
        style={{ position: "relative", height: 1, background: UI.border, marginTop: 20 }}
      >
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: 1,
            width: 80,
            background: UI.accentHairline,
          }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Section label
 * ------------------------------------------------------------------------- */

export function SectionLabel({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        color: UI.muted,
        marginBottom: 12,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Card — hairline border with subtle top luminosity, rises on entry
 * ------------------------------------------------------------------------- */

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      className="rise"
      style={{
        background: UI.surface,
        border: `1px solid ${UI.border}`,
        // Subtle luminosity: the top hairline catches a little more light.
        borderTopColor: UI.borderTop,
        borderRadius: UI.radius,
        padding: 24,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * KPI stat card
 * ------------------------------------------------------------------------- */

const STAT_TONES = {
  ok: UI.accent,
  warn: UI.warn,
  danger: UI.danger,
  muted: UI.muted,
} as const;

export function StatCard({
  label,
  value,
  sub,
  tone = "muted",
  style,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Colors the `sub` line only (use "ok" for positive deltas). */
  tone?: keyof typeof STAT_TONES;
  style?: CSSProperties;
}) {
  return (
    <div
      className="rise"
      style={{
        background: UI.surface,
        border: `1px solid ${UI.border}`,
        borderTopColor: UI.borderTop,
        borderRadius: UI.radius,
        padding: 20,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: UI.muted,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1.2,
          color: UI.text,
          marginTop: 8,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {sub != null && (
        <div
          style={{
            fontSize: 12,
            color: STAT_TONES[tone],
            marginTop: 6,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * DataTable primitives — <DataTable><THead/><tbody><Row><Cell/>…
 * ------------------------------------------------------------------------- */

export interface TableCol {
  label: ReactNode;
  align?: "left" | "right" | "center";
  width?: number | string;
}

export function DataTable({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      {/* Row hover without hooks: a tiny scoped stylesheet (server-safe).
          Hover = background + a 2px left accent hairline that fades in. */}
      <style>{`
        .uik-row td{transition:background 150ms ease,box-shadow 150ms ease;}
        .uik-row:hover td{background:${UI.hover};}
        .uik-row td:first-child{box-shadow:inset 2px 0 0 0 transparent;}
        .uik-row:hover td:first-child{box-shadow:inset 2px 0 0 0 ${UI.accentHairline};}
      `}</style>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13.5,
          fontVariantNumeric: "tabular-nums",
          ...style,
        }}
      >
        {children}
      </table>
    </div>
  );
}

export function THead({ cols }: { cols: TableCol[] }) {
  return (
    <thead>
      <tr>
        {cols.map((col, i) => (
          <th
            key={i}
            style={{
              textAlign: col.align ?? "left",
              width: col.width,
              padding: "10px 12px",
              fontSize: 10.5,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: UI.muted,
              borderBottom: `1px solid ${UI.border}`,
              whiteSpace: "nowrap",
            }}
          >
            {col.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function Row({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <tr className="uik-row" style={style}>
      {children}
    </tr>
  );
}

export function Cell({
  children,
  align = "left",
  mono = false,
  colSpan,
  style,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  /** Monospace + tabular numerals — use for metrics/ids. */
  mono?: boolean;
  colSpan?: number;
  style?: CSSProperties;
}) {
  return (
    <td
      colSpan={colSpan}
      style={{
        textAlign: align,
        padding: "10px 12px",
        height: 44,
        verticalAlign: "middle",
        color: UI.text,
        borderBottom: `1px solid ${UI.border}`,
        ...(mono
          ? {
              fontFamily: UI.fontMono,
              fontSize: 13,
              fontVariantNumeric: "tabular-nums",
            }
          : null),
        ...style,
      }}
    >
      {children}
    </td>
  );
}

/* ---------------------------------------------------------------------------
 * Badge
 * ------------------------------------------------------------------------- */

const BADGE_TONES = {
  ok: UI.accent,
  accent: UI.accent,
  warn: UI.warn,
  danger: UI.danger,
  muted: UI.muted,
} as const;

export function Badge({
  tone = "muted",
  dot = false,
  children,
  style,
}: {
  tone?: keyof typeof BADGE_TONES;
  /** Quiet status variant: 6px colored dot + 11.5px label, no pill chrome. */
  dot?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const c = BADGE_TONES[tone];
  if (dot) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11.5,
          fontWeight: 500,
          lineHeight: "16px",
          whiteSpace: "nowrap",
          color: c,
          ...style,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: c,
            flexShrink: 0,
          }}
        />
        {children}
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        borderRadius: 999,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 600,
        lineHeight: "16px",
        whiteSpace: "nowrap",
        color: c,
        // color-mix instead of hex-alpha concatenation: tones are var(--uik-*).
        background: `color-mix(in srgb, ${c} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Empty & error states
 * ------------------------------------------------------------------------- */

export function EmptyState({
  title,
  hint,
  action,
  style,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 64,
        ...style,
      }}
    >
      {/* Minimal CSS ornament: a 1px ring with a centered dot (border-drawn). */}
      <div
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          borderRadius: 999,
          border: `1px solid ${UI.borderStrong}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 18,
        }}
      >
        <span style={{ width: 4, height: 4, borderRadius: 999, background: UI.faint }} />
      </div>
      <div
        style={{
          fontFamily: UI.fontDisplay,
          fontStyle: "italic",
          fontWeight: 400,
          fontSize: 18,
          letterSpacing: "0.01em",
          color: UI.muted,
        }}
      >
        {title}
      </div>
      {hint != null && (
        <div style={{ fontSize: 13, color: UI.faint, marginTop: 8, maxWidth: 440, lineHeight: 1.55 }}>
          {hint}
        </div>
      )}
      {action != null && <div style={{ marginTop: 20 }}>{action}</div>}
    </div>
  );
}

export function ErrorCard({
  message,
  style,
}: {
  message: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      role="alert"
      style={{
        background: `color-mix(in srgb, ${UI.danger} 6%, transparent)`,
        border: `1px solid color-mix(in srgb, ${UI.danger} 35%, transparent)`,
        borderRadius: UI.radius,
        padding: "14px 18px",
        fontSize: 13.5,
        lineHeight: 1.5,
        color: UI.danger,
        ...style,
      }}
    >
      {message}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Buttons — plain <button>/<a>; safe in server components (no handlers there)
 * Hover/active choreography lives in globals.css under .uik-btn-* (150ms).
 * ------------------------------------------------------------------------- */

export interface ButtonProps extends React.HTMLAttributes<HTMLElement> {
  /** When set, renders an <a href> instead of a <button>. */
  href?: string;
  target?: string;
  rel?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
}

/* Variant colors (background/color/border) live in globals.css under the
   .uik-btn-* classes — NOT inline — so the .light theme overrides can win.
   Only layout/typography is inline. fontWeight 550 is genuine: Instrument
   Sans is loaded as a variable font (wght axis) in layout.tsx. */
const buttonBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  borderRadius: UI.radiusSm,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 550,
  lineHeight: "16px",
  cursor: "pointer",
  textDecoration: "none",
  whiteSpace: "nowrap",
  userSelect: "none",
};

function renderButton(
  variantClass: string,
  { href, type = "button", disabled, style, className, children, ...rest }: ButtonProps
) {
  const s: CSSProperties = {
    ...buttonBase,
    ...(disabled ? { opacity: 0.5, cursor: "not-allowed", pointerEvents: "none" } : null),
    ...style,
  };
  const cls = ["uik-btn", variantClass, className].filter(Boolean).join(" ");
  if (href && !disabled) {
    return (
      <a href={href} className={cls} style={s} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} disabled={disabled} className={cls} style={s} {...rest}>
      {children}
    </button>
  );
}

export function PrimaryButton(props: ButtonProps) {
  return renderButton("uik-btn-primary", props);
}

export function SecondaryButton(props: ButtonProps) {
  return renderButton("uik-btn-secondary", props);
}

export function GhostDangerButton(props: ButtonProps) {
  return renderButton("uik-btn-ghost-danger", props);
}
