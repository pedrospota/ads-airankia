/**
 * ui-kit.tsx — AI Rankia Ads premium UI kit (dark-first, "quiet & expensive").
 *
 * SERVER-SAFE: no hooks, no "use client". Every export is a pure function of
 * props + inline style objects, so it works in BOTH server and client
 * components. Colors are the dark palette exported as `UI` tokens.
 * (Light theme is handled at the page level via useTheme for client
 * components; server surfaces are dark-first by design.)
 *
 * PUBLIC API
 *   UI                                       — style tokens (colors, radii, maxWidth)
 *   <PageHeader title subtitle? actions? />  — 26px page title row, 32px bottom margin
 *   <Card style?>…</Card>                    — surface card: radius 12, 1px border, padding 24
 *   <StatCard label value sub? tone? />      — KPI stat; `tone` colors the `sub` line
 *                                              (tone: "ok" | "warn" | "danger" | "muted")
 *   <SectionLabel>…</SectionLabel>           — 11px uppercase tracking-0.08em muted label
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
 *   <Badge tone="ok|warn|danger|muted|accent">…</Badge>  — tinted pill
 *   <EmptyState title hint? action? />       — centered, generous padding
 *   <ErrorCard message />                    — quiet red-tinted alert
 *   <PrimaryButton|SecondaryButton|GhostDangerButton href? …props>
 *     — plain <button type="button"> by default; renders an <a> when `href`
 *       is given. Pass onClick etc. from client components only.
 *
 * USAGE EXAMPLE (server component page):
 *   import {
 *     PageHeader, Card, StatCard, DataTable, THead, Row, Cell,
 *     Badge, EmptyState, ErrorCard, PrimaryButton, SecondaryButton, UI,
 *   } from "@/components/ui-kit";
 *
 *   export default function Page() {
 *     return (
 *       <>
 *         <PageHeader
 *           title="Cockpit"
 *           subtitle="Rendimiento del MCC en los últimos 30 días"
 *           actions={<PrimaryButton href="/performance/ajustes">Configurar</PrimaryButton>}
 *         />
 *         <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16, marginBottom: 32 }}>
 *           <StatCard label="Coste" value="12.480 €" sub="+4,2% vs. mes anterior" tone="ok" />
 *         </div>
 *         <Card style={{ padding: 0 }}>
 *           <DataTable>
 *             <THead cols={[{ label: "Campaña" }, { label: "Estado" }, { label: "Coste", align: "right" }]} />
 *             <tbody>
 *               <Row>
 *                 <Cell>Search — ES</Cell>
 *                 <Cell><Badge tone="ok">Activa</Badge></Cell>
 *                 <Cell align="right" mono>1.240,50 €</Cell>
 *               </Row>
 *             </tbody>
 *           </DataTable>
 *         </Card>
 *       </>
 *     );
 *   }
 *
 * Note: when a Card directly wraps a DataTable, use <Card style={{ padding: 0 }}>
 * and let the table cells provide the spacing (as above).
 */

import type { CSSProperties, ReactNode } from "react";
import React from "react";

/* ---------------------------------------------------------------------------
 * Tokens (dark palette — the app is dark-first)
 * ------------------------------------------------------------------------- */

export const UI = {
  /** Page background */
  bg: "#0A0A0B",
  /** Card / raised surface */
  surface: "#101012",
  /** Second-level surface (active nav item, inset wells) */
  surface2: "#151518",
  /** The only border. Always 1px, never shadows. */
  border: "#1F1F23",
  /** Table row hover */
  hover: "#121214",
  text: "#F7F8F8",
  muted: "#8A8F98",
  faint: "#55575D",
  /** Sparingly: primary actions, active states, positive deltas ONLY. */
  accent: "#10B981",
  danger: "#EF4444",
  warn: "#F59E0B",
  radius: 12,
  radiusSm: 8,
  maxWidth: 1150,
  fontMono: "var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace",
} as const;

/* ---------------------------------------------------------------------------
 * Page header
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
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        marginBottom: 32,
        ...style,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1
          style={{
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.25,
            color: UI.text,
            margin: 0,
          }}
        >
          {title}
        </h1>
        {subtitle != null && (
          <p style={{ fontSize: 13.5, color: UI.muted, margin: "6px 0 0", lineHeight: 1.5 }}>
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
        letterSpacing: "0.08em",
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
 * Card
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
      style={{
        background: UI.surface,
        border: `1px solid ${UI.border}`,
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
      style={{
        background: UI.surface,
        border: `1px solid ${UI.border}`,
        borderRadius: UI.radius,
        padding: 20,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: UI.muted,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
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
      {/* Row hover without hooks: a tiny scoped stylesheet (server-safe). */}
      <style>{`.uik-row:hover td{background:${UI.hover};}`}</style>
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
              fontSize: 11,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
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
  children,
  style,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const c = BADGE_TONES[tone];
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
        background: `${c}1F`, // 12% tint
        border: `1px solid ${c}4D`,
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
      <div style={{ fontSize: 15, color: UI.muted }}>{title}</div>
      {hint != null && (
        <div style={{ fontSize: 13, color: UI.faint, marginTop: 6, maxWidth: 440 }}>{hint}</div>
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
        background: "rgba(239,68,68,0.06)",
        border: "1px solid rgba(239,68,68,0.35)",
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
 * ------------------------------------------------------------------------- */

export interface ButtonProps extends React.HTMLAttributes<HTMLElement> {
  /** When set, renders an <a href> instead of a <button>. */
  href?: string;
  target?: string;
  rel?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
}

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

const PRIMARY: CSSProperties = {
  background: "#FFFFFF",
  color: "#0A0A0B",
  border: "1px solid #FFFFFF",
};

const SECONDARY: CSSProperties = {
  background: "transparent",
  color: UI.text,
  border: `1px solid ${UI.border}`,
};

const GHOST_DANGER: CSSProperties = {
  background: "transparent",
  color: UI.danger,
  border: "1px solid transparent",
};

function renderButton(
  variant: CSSProperties,
  { href, type = "button", disabled, style, children, ...rest }: ButtonProps
) {
  const s: CSSProperties = {
    ...buttonBase,
    ...variant,
    ...(disabled ? { opacity: 0.5, cursor: "not-allowed", pointerEvents: "none" } : null),
    ...style,
  };
  if (href && !disabled) {
    return (
      <a href={href} style={s} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} disabled={disabled} style={s} {...rest}>
      {children}
    </button>
  );
}

export function PrimaryButton(props: ButtonProps) {
  return renderButton(PRIMARY, props);
}

export function SecondaryButton(props: ButtonProps) {
  return renderButton(SECONDARY, props);
}

export function GhostDangerButton(props: ButtonProps) {
  return renderButton(GHOST_DANGER, props);
}
