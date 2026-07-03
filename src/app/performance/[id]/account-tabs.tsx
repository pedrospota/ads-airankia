"use client";

// ============================================================================
// <AccountTabs/> — the client shell of /performance/[id]: eight tabs mirroring
// the Python engine's account view (Resumen · Acciones · Segmentos · Calidad ·
// Auditoría · Estrategia · Análisis · Reglas), rendered from the RAW payloads
// of /api/v1/accounts/{id}/full.
//
// PROPOSE-ONLY: "Aprobar" records the decision via our route handlers — the
// engine NEVER executes anything in Google Ads. rec_key replicates the Python
// UI's scheme (sha256/sha1 of the same raw strings) so approvals recorded here
// and there stay in sync.
//
// Every field can be null — everything renders defensively with friendly
// Spanish empty states. Styling: @/components/ui-kit (dark, quiet, premium).
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AccountFull } from "@/lib/sentinel";
import {
  UI,
  Card,
  StatCard,
  SectionLabel,
  DataTable,
  THead,
  Row,
  Cell,
  Badge,
  EmptyState,
  ErrorCard,
  PrimaryButton,
  SecondaryButton,
  GhostDangerButton,
} from "@/components/ui-kit";

type Dict = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared layout atoms (4px grid, 16px card gaps)
// ---------------------------------------------------------------------------

const STACK: CSSProperties = { display: "grid", gap: 16 };

// ---------------------------------------------------------------------------
// Defensive accessors + formatters (client-local: src/lib/sentinel.ts is
// server-only, so we only import its TYPES)
// ---------------------------------------------------------------------------

function asDict(v: unknown): Dict {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {};
}
function asArr(v: unknown): Dict[] {
  return Array.isArray(v)
    ? (v.filter((x) => x && typeof x === "object") as Dict[])
    : [];
}
function str_(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function num_(v: unknown): number | null {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function fmtMoney(v: number | null | undefined, d = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
}
function fmtNum(v: number | null | undefined, d = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: d });
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}
function signedPct(v: number | null | undefined): ReactNode {
  if (v == null || !Number.isFinite(v)) return <span style={{ color: UI.faint }}>—</span>;
  const color = v > 0 ? UI.accent : v < 0 ? UI.danger : UI.muted;
  return (
    <span style={{ color, fontWeight: 550, fontVariantNumeric: "tabular-nums" }}>
      {v > 0 ? "+" : ""}
      {v.toLocaleString("en-US", { maximumFractionDigits: 1 })}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// rec_key scheme — replicated from the Python UI so approvals match:
//   _opt_key : sha256("{tipo}|{target}|{tool}|{text}|{budget_id}|{campaign_id}")[:16]
//   det table: "det-"  + sha256("{action_family}|{target}")[:14]
//   segments : "segm-{dim}-" + sha1(seg)[:8]
//   strategy : "strat-" + sha256("{tipo}|{que}")[:14]
// Python f-strings render missing values as "None" → pyStr() mimics that.
// ---------------------------------------------------------------------------

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

async function hashHex(algo: "SHA-256" | "SHA-1", raw: string): Promise<string> {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function optRecKey(o: Dict): Promise<string> {
  const op = asDict(o.api_op);
  const raw =
    `${pyStr(o.tipo)}|${pyStr(o.target)}|${pyStr(op.tool)}|${pyStr(op.text)}|` +
    `${pyStr(op.budget_id)}|${pyStr(op.campaign_id)}`;
  return (await hashHex("SHA-256", raw)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Semantics maps (mirroring the Python UI)
// ---------------------------------------------------------------------------

const TIPO_LABEL: Record<string, string> = {
  negativas: "Bloquear búsquedas que gastan de más",
  budget: "Mover presupuesto",
  keywords: "Agregar palabras que convierten",
  pujas: "Ajustar pujas por segmento",
  estructura: "Reorganizar campañas",
  copy_rsa: "Reescribir el anuncio (sube Quality Score)",
  calidad_kw: "Arreglar keyword de bajo Quality Score",
  landing: "Mejorar la página de destino",
  assets: "Agregar extensiones (sitelinks / callouts)",
};

/** Honest $ framing per action type: saves vs deploys vs efficiency.
 *  Accent is reserved for savings/positive money; the rest stays neutral. */
function valueLabel(
  tipo: string | null,
  imp: number | null
): { label: string; color: string } | null {
  if (imp == null) return null;
  const t = (tipo || "").toLowerCase();
  if (t === "negativas") return { label: "Ahorra", color: UI.accent };
  if (t === "budget")
    return imp >= 0
      ? { label: "Desplegar", color: UI.text }
      : { label: "Recorta", color: UI.accent };
  if (["copy_rsa", "calidad_kw", "landing"].includes(t))
    return { label: "Calidad", color: UI.text };
  return { label: "Eficiencia", color: UI.text };
}

function confTone(conf: number): "ok" | "warn" | "muted" {
  return conf >= 70 ? "ok" : conf >= 45 ? "warn" : "muted";
}

const QS_PROBLEM: Record<string, [string, string]> = {
  relevancia_anuncio: [
    "tu anuncio no usa esa palabra",
    "reescribe el anuncio para incluirla",
  ],
  ctr_esperado: ["tu anuncio no invita al clic", "mejora titulares y oferta"],
  experiencia_landing: [
    "tu página no entrega lo que promete",
    "alinea y acelera la landing",
  ],
};

/** Per-segment call vs the account CVR (deterministic, same as the engine). */
function segVerdict(
  cvr: number | null,
  acctCvr: number | null,
  lowVol: boolean
): { label: string; color: string; mod: number | null } {
  if (lowVol || cvr == null || !acctCvr) {
    return { label: "pocos datos", color: UI.faint, mod: null };
  }
  const ratio = cvr / acctCvr;
  if (ratio >= 1.25) {
    const m = Math.min(50, Math.round((ratio - 1) * 100));
    return { label: `subir puja +${m}%`, color: UI.accent, mod: m };
  }
  if (ratio <= 0.6) {
    const m = Math.max(-50, Math.round((ratio - 1) * 100));
    return { label: `bajar puja ${m}%`, color: UI.warn, mod: m };
  }
  return { label: "a tono", color: UI.muted, mod: 0 };
}

const OBJETIVOS: [string, string][] = [
  ["", "— sin declarar (el sistema lo infiere del bidding) —"],
  ["leads", "Leads / solicitudes"],
  ["ventas", "Ventas / conversiones"],
  ["roas", "Valor / ROAS (maximizar retorno)"],
  ["brandformance", "Brandformance (marca + performance)"],
  ["awareness", "Awareness / alcance"],
  ["llamadas", "Llamadas"],
];

const FASES: [string, string][] = [
  ["", "— sin declarar —"],
  ["crecimiento", "Crecimiento (volumen > eficiencia)"],
  ["eficiencia", "Eficiencia (bajar CPA aunque baje volumen)"],
  ["mantener", "Mantener"],
];

const BIZ_LABELS: Record<string, string> = {
  que_vende: "Qué vende",
  cliente: "Cliente",
  objetivo_real: "Objetivo real",
  momento: "Momento",
  mercado: "Mercado",
  competencia: "Competencia",
  estrategia: "Estrategia",
  propuesta_valor: "Propuesta de valor",
  estacionalidad: "Estacionalidad",
  riesgos: "Riesgos",
  notas: "Notas",
};

function humanize(key: string): string {
  return BIZ_LABELS[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Map deterministic recommendations into the action-card shape (the same
 *  fallback the Python UI uses when the LLM plan is missing). */
function detOpts(recs: Dict[]): Dict[] {
  const fam: Record<string, string> = {
    negatives: "negativas",
    budget: "budget",
    bidding: "pujas",
    keywords: "keywords",
  };
  const acc: Record<string, string> = {
    negativas: "Bloquear términos que gastan sin convertir",
    budget: "Ajustar el presupuesto de la campaña",
    pujas: "Mejorar puja / Quality Score",
    keywords: "Agregar el término en concordancia exacta",
  };
  return recs.slice(0, 12).map((r) => {
    const tipo = fam[str_(r.action_family) ?? ""] ?? (str_(r.action_family) || "");
    const note = str_(asDict(r.human_note).text);
    const ev = asDict(r.evidence);
    const porque =
      note ||
      Object.entries(ev)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ") ||
      "Detectado por el motor.";
    const cf = num_(r.confidence);
    const tgt = str_(r.target);
    const detalle: Record<string, string[]> = {
      negativas: [`Bloquear el término: ${tgt ?? "—"}`],
      keywords: [`Agregar en concordancia exacta: ${tgt ?? "—"}`],
      budget: [`Ajustar el presupuesto de: ${tgt ?? "—"}`],
      pujas: [`Revisar puja / Quality Score en: ${tgt ?? "—"}`],
    };
    return {
      tipo,
      accion: acc[tipo] ?? "Optimización",
      target: tgt,
      confianza: cf != null ? Math.round(cf * 100) : null,
      detalle: detalle[tipo] ?? null,
      impacto_estimado_mxn_mes: r.dollars_at_stake,
      api_op: asDict(r.api_op),
      porque,
      _det: true,
    } as Dict;
  });
}

// ---------------------------------------------------------------------------
// Approve plumbing
// ---------------------------------------------------------------------------

interface ApproveCtx {
  approved: Set<string>;
  approvedMeta: Record<string, { by?: string | null; at?: string | null }>;
  busyKey: string | null;
  approve: (recKey: string, title: string, detail?: Dict) => void;
  revert: (recKey: string) => void;
}

function ApproveControl({
  ctx,
  recKey,
  title,
  detail,
  compact,
}: {
  ctx: ApproveCtx;
  recKey: string | null | undefined;
  title: string;
  detail?: Dict;
  compact?: boolean;
}) {
  if (!recKey) {
    return <span style={{ fontSize: 12, color: UI.faint }}>preparando…</span>;
  }
  const busy = ctx.busyKey === recKey;
  if (ctx.approved.has(recKey)) {
    const meta = ctx.approvedMeta[recKey];
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge tone="ok">Aprobada{meta?.by ? ` · ${meta.by}` : ""}</Badge>
        <GhostDangerButton
          onClick={() => ctx.revert(recKey)}
          disabled={busy}
          style={{ padding: "4px 8px", fontSize: 12 }}
        >
          {busy ? "deshaciendo…" : "deshacer"}
        </GhostDangerButton>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <PrimaryButton
        onClick={() => ctx.approve(recKey, title, detail)}
        disabled={busy}
        style={compact ? { padding: "5px 10px", fontSize: 12 } : undefined}
      >
        {busy ? "Registrando…" : "Aprobar"}
      </PrimaryButton>
      {!compact && (
        <span style={{ fontSize: 11, color: UI.faint }}>no ejecuta aún</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// On-demand generation plumbing (/api/performance/generate). The engine runs
// each job in background (~30 s); the button shows a loading state and then
// router.refresh() re-pulls the payload.
// ---------------------------------------------------------------------------

interface GenCtx {
  busyKind: string | null;
  run: (kind: string) => void;
}

function GenButton({
  gen,
  kind,
  label,
  busyLabel,
}: {
  gen: GenCtx;
  kind: string;
  label: string;
  busyLabel: string;
}) {
  const busy = gen.busyKind === kind;
  return (
    <SecondaryButton
      onClick={() => gen.run(kind)}
      disabled={gen.busyKind != null}
      style={{ padding: "6px 12px", fontSize: 12.5 }}
    >
      {busy ? busyLabel : label}
    </SecondaryButton>
  );
}

// ---------------------------------------------------------------------------
// Small shared atoms
// ---------------------------------------------------------------------------

function Empty({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <Card style={{ padding: 0 }}>
      <EmptyState title={title} hint={hint} />
    </Card>
  );
}

/** Quiet inline note card (info banners). */
function NoteCard({ children }: { children: ReactNode }) {
  return (
    <Card style={{ padding: "12px 16px", background: UI.surface2, fontSize: 13, color: UI.muted, lineHeight: 1.5 }}>
      {children}
    </Card>
  );
}

function gradeColor(grade: string | null | undefined): string {
  const g = (grade || "").trim().charAt(0).toUpperCase();
  if (g === "A" || g === "B") return UI.accent;
  if (g === "C") return UI.warn;
  if (g === "D" || g === "F") return UI.danger;
  return UI.muted;
}

// ===========================================================================
// The component
// ===========================================================================

export function AccountTabs({
  data,
  accountId,
  userEmail,
}: {
  data: AccountFull;
  accountId: string;
  userEmail: string;
}) {
  // ---- derived raw payloads -------------------------------------------------
  const diag = useMemo(() => asDict(data.diagnostic), [data]);
  const aiPlan = data.ai_plan ?? null;
  const biz = useMemo(() => asDict(aiPlan?.business), [aiPlan]);
  const signals = useMemo(() => asDict(aiPlan?.signals), [aiPlan]);
  const measured = useMemo(() => asArr(aiPlan?.measured), [aiPlan]);
  const recs = useMemo(() => asArr(data.recommendations), [data]);
  const aiOpts = useMemo(() => asArr(aiPlan?.optimizations), [aiPlan]);
  const cardsFromDet = aiOpts.length === 0;
  const opts = useMemo(
    () => (aiOpts.length ? aiOpts.slice(0, 12) : detOpts(recs)),
    [aiOpts, recs]
  );
  const audit = data.audit ?? null;
  const auditAi = useMemo(() => asDict(data.audit_ai), [data]);
  const shadowBets = useMemo(() => asArr(data.shadow_bets), [data]);
  const bp = data.business_profile ?? null;

  // ---- tabs ------------------------------------------------------------------
  const [tab, setTab] = useState("resumen");

  // ---- approvals state -------------------------------------------------------
  const [approved, setApproved] = useState<Set<string>>(
    () => new Set((data.approvals ?? []).map((a) => a.rec_key ?? "").filter(Boolean))
  );
  const [approvedMeta, setApprovedMeta] = useState<
    Record<string, { by?: string | null; at?: string | null }>
  >(() => {
    const m: Record<string, { by?: string | null; at?: string | null }> = {};
    for (const a of data.approvals ?? []) {
      if (a.rec_key) m[a.rec_key] = { by: a.approved_by, at: a.approved_at };
    }
    return m;
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ---- on-demand generation + CSV download ------------------------------------
  const router = useRouter();
  const [genBusy, setGenBusy] = useState<string | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);

  async function runGenerate(kind: string) {
    setGenBusy(kind);
    setActionError(null);
    try {
      const res = await fetch("/api/performance/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, kind }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      setActionError(
        "No se pudo lanzar la generación en el optimizador. Inténtalo de nuevo."
      );
    } finally {
      setGenBusy(null);
    }
  }

  const gen: GenCtx = { busyKind: genBusy, run: runGenerate };

  async function downloadApprovedCsv() {
    setCsvBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/performance/engine-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/export/approved.csv?account=${encodeURIComponent(accountId)}`,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cambios_aprobados_${accountId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setActionError("No se pudo descargar el CSV de aprobados. Inténtalo de nuevo.");
    } finally {
      setCsvBusy(false);
    }
  }

  async function approve(recKey: string, title: string, detail?: Dict) {
    setBusyKey(recKey);
    setActionError(null);
    try {
      const res = await fetch("/api/performance/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, rec_key: recKey, title, detail }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setApproved((prev) => new Set(prev).add(recKey));
      setApprovedMeta((prev) => ({
        ...prev,
        [recKey]: { by: userEmail || "tú", at: new Date().toISOString() },
      }));
    } catch {
      setActionError("No se pudo registrar la aprobación. Inténtalo de nuevo.");
    } finally {
      setBusyKey(null);
    }
  }

  async function revert(recKey: string) {
    setBusyKey(recKey);
    setActionError(null);
    try {
      const res = await fetch("/api/performance/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, rec_key: recKey }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setApproved((prev) => {
        const next = new Set(prev);
        next.delete(recKey);
        return next;
      });
    } catch {
      setActionError("No se pudo deshacer la aprobación. Inténtalo de nuevo.");
    } finally {
      setBusyKey(null);
    }
  }

  const ctx: ApproveCtx = { approved, approvedMeta, busyKey, approve, revert };

  // ---- rec_key computation (async: Web Crypto) --------------------------------
  const [keys, setKeys] = useState<Record<string, string>>({});
  const bidDims = useMemo(() => asDict(diag.bid_dimensions), [diag]);
  const estrategiaAi = useMemo(() => asDict(signals.estrategia), [signals]);
  const stratMoves = useMemo(
    () => asArr(estrategiaAi.movidas_estructurales).slice(0, 4),
    [estrategiaAi]
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, string> = {};
      try {
        for (let i = 0; i < opts.length; i++) {
          out[`opt-${i}`] = await optRecKey(opts[i]);
        }
        if (!cardsFromDet) {
          const list = recs.slice(0, 15);
          for (let i = 0; i < list.length; i++) {
            const d = list[i];
            const h = await hashHex(
              "SHA-256",
              `${pyStr(d.action_family)}|${pyStr(d.target)}`
            );
            out[`det-${i}`] = `det-${h.slice(0, 14)}`;
          }
        }
        for (const dkey of ["device", "edad", "genero", "ingreso", "dia", "hora"]) {
          const rows = asArr(bidDims[dkey]).slice(0, 8);
          for (let i = 0; i < rows.length; i++) {
            const seg = str_(rows[i].seg) ?? "";
            const h = await hashHex("SHA-1", seg);
            out[`seg-${dkey}-${i}`] = `segm-${dkey}-${h.slice(0, 8)}`;
          }
        }
        for (let i = 0; i < stratMoves.length; i++) {
          const m = stratMoves[i];
          const h = await hashHex(
            "SHA-256",
            `${pyStr(m.tipo)}|${pyStr(m.que)}`
          );
          out[`strat-${i}`] = `strat-${h.slice(0, 14)}`;
        }
      } catch {
        // Web Crypto unavailable (non-secure context): fall back to a plain
        // action_type+target key — approvals still record, just won't dedupe
        // against the Python UI.
        for (let i = 0; i < opts.length; i++) {
          out[`opt-${i}`] = `fb-${pyStr(opts[i].tipo)}|${pyStr(opts[i].target)}`.slice(0, 120);
        }
      }
      if (alive) setKeys(out);
    })();
    return () => {
      alive = false;
    };
  }, [opts, recs, bidDims, stratMoves, cardsFromDet]);

  // ---- tab bar ----------------------------------------------------------------
  const tabs: { id: string; label: string }[] = [
    { id: "resumen", label: "Resumen" },
    { id: "acciones", label: `Acciones · ${opts.length}` },
    { id: "segmentos", label: "Segmentos" },
    { id: "calidad", label: "Calidad" },
    { id: "auditoria", label: `Auditoría${audit?.grade ? ` · ${audit.grade}` : ""}` },
    { id: "estrategia", label: "Estrategia" },
    { id: "analisis", label: "Análisis" },
    { id: "reglas", label: "Reglas" },
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <SecondaryButton
          onClick={() => runGenerate("reason-now")}
          disabled={genBusy != null}
          style={{ padding: "6px 12px", fontSize: 12.5 }}
        >
          {genBusy === "reason-now" ? "Re-analizando…" : "Re-analizar"}
        </SecondaryButton>
        <SecondaryButton
          onClick={downloadApprovedCsv}
          disabled={csvBusy}
          style={{ padding: "6px 12px", fontSize: 12.5 }}
        >
          {csvBusy ? "Descargando…" : "Aprobados (CSV)"}
        </SecondaryButton>
        <Link
          href={`/performance/simulacion?account=${encodeURIComponent(accountId)}`}
          style={{
            fontSize: 12.5,
            color: UI.muted,
            textDecoration: "underline",
            textUnderlineOffset: 3,
          }}
        >
          Simulación de esta cuenta
        </Link>
      </div>

      <div
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
          borderBottom: `1px solid ${UI.border}`,
          marginBottom: 24,
        }}
      >
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: active ? 550 : 450,
                color: active ? UI.text : UI.muted,
                background: "transparent",
                border: "none",
                borderBottom: active
                  ? `2px solid ${UI.accent}`
                  : "2px solid transparent",
                marginBottom: -1,
                cursor: "pointer",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {actionError && <ErrorCard message={actionError} style={{ marginBottom: 16 }} />}

      {tab === "resumen" && (
        <ResumenTab biz={biz} signals={signals} diag={diag} opts={opts} />
      )}
      {tab === "acciones" && (
        <AccionesTab
          opts={opts}
          recs={recs}
          cardsFromDet={cardsFromDet}
          keys={keys}
          ctx={ctx}
        />
      )}
      {tab === "segmentos" && (
        <SegmentosTab diag={diag} keys={keys} ctx={ctx} />
      )}
      {tab === "calidad" && <CalidadTab diag={diag} gen={gen} />}
      {tab === "auditoria" && (
        <AuditoriaTab audit={audit} auditAi={auditAi} hasRules={!!bp} gen={gen} />
      )}
      {tab === "estrategia" && (
        <EstrategiaTab
          biz={biz}
          estrategiaAi={estrategiaAi}
          stratMoves={stratMoves}
          diag={diag}
          keys={keys}
          ctx={ctx}
        />
      )}
      {tab === "analisis" && (
        <AnalisisTab
          signals={signals}
          measured={measured}
          shadowBets={shadowBets}
          gen={gen}
        />
      )}
      {tab === "reglas" && <ReglasTab accountId={accountId} bp={bp} />}
    </div>
  );
}

// ===========================================================================
// Resumen — negocio (IA) + señales + top 3 acciones
// ===========================================================================

function optImp(o: Dict): number {
  return num_(o.impacto_estimado_mxn_mes) ?? 0;
}

function ResumenTab({
  biz,
  signals,
  diag,
  opts,
}: {
  biz: Dict;
  signals: Dict;
  diag: Dict;
  opts: Dict[];
}) {
  const gasto = num_(diag.search_cost_30d);
  const ahorro = opts
    .filter(
      (o) =>
        str_(o.tipo) === "negativas" ||
        (str_(o.tipo) === "budget" && optImp(o) < 0)
    )
    .reduce((s, o) => s + Math.abs(optImp(o)), 0);
  const oport = opts.reduce((s, o) => s + Math.abs(optImp(o)), 0) - ahorro;
  const gh = asDict(signals.ga4_health);
  const ghStatus = str_(gh.status);
  const trends = asArr(signals.trends).slice(0, 6);
  const top3 = [...opts].sort((a, b) => Math.abs(optImp(b)) - Math.abs(optImp(a))).slice(0, 3);
  const competidores = Array.isArray(biz.competidores)
    ? (biz.competidores as unknown[]).map((c) => String(c)).slice(0, 10)
    : [];

  const hasAnything =
    gasto != null || opts.length > 0 || str_(biz.que_vende) || trends.length > 0;

  return (
    <div style={STACK}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
        }}
      >
        <StatCard label="Gasto Search/mes" value={fmtMoney(gasto)} />
        <StatCard
          label="Ahorro disponible"
          value={fmtMoney(ahorro)}
          sub={ahorro > 0 ? "/mes recuperable" : undefined}
          tone="ok"
        />
        <StatCard
          label="Oportunidad/mes"
          value={fmtMoney(oport)}
          sub={oport > 0 ? "/mes por capturar" : undefined}
          tone="muted"
        />
        <StatCard label="Propuestas" value={fmtNum(opts.length)} />
      </div>

      {ghStatus && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Badge
            tone={ghStatus === "ok" ? "ok" : ghStatus === "contaminada" ? "warn" : "muted"}
          >
            GA4 {ghStatus}
          </Badge>
          {str_(gh.nota) && (
            <span style={{ fontSize: 12, color: UI.muted }}>{str_(gh.nota)}</span>
          )}
        </div>
      )}

      {str_(biz.que_vende) && (
        <Card>
          <SectionLabel>Negocio (IA)</SectionLabel>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: UI.text, margin: 0 }}>
            <b style={{ fontWeight: 550 }}>{str_(biz.que_vende)}</b>
            {str_(biz.cliente) ? <> · {str_(biz.cliente)}</> : null}
            {str_(biz.objetivo_real) ? (
              <>
                {" "}
                · objetivo:{" "}
                <span style={{ fontWeight: 550 }}>{str_(biz.objetivo_real)}</span>
              </>
            ) : null}
          </p>
          {str_(biz.momento) && (
            <p style={{ fontSize: 13, marginTop: 8, color: UI.muted }}>
              Momento: {str_(biz.momento)}
            </p>
          )}
          {competidores.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: UI.faint }}>competidores</span>
              {competidores.map((c, i) => (
                <Badge key={i} tone="muted">
                  {c}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      )}

      {trends.length > 0 && (
        <Card>
          <SectionLabel>Momentum</SectionLabel>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            {trends.map((t, i) => (
              <span key={i} style={{ whiteSpace: "nowrap" }}>
                <span style={{ color: UI.muted }}>{str_(t.campana) ?? "campaña"}</span>{" "}
                {signedPct(num_(t.mejora_pct))}
              </span>
            ))}
          </div>
        </Card>
      )}

      {top3.length > 0 && (
        <Card>
          <SectionLabel>Empieza por estas (mayor impacto)</SectionLabel>
          <ol
            style={{
              paddingLeft: 20,
              fontSize: 13.5,
              lineHeight: 2,
              color: UI.text,
              margin: 0,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {top3.map((o, i) => (
              <li key={i}>
                {TIPO_LABEL[str_(o.tipo) ?? ""] ?? str_(o.tipo) ?? "Movida"}{" "}
                <span style={{ color: UI.muted }}>
                  {str_(o.target) ? `· ${str_(o.target)}` : ""} ·{" "}
                  {fmtMoney(Math.abs(optImp(o)))}/mes
                </span>
              </li>
            ))}
          </ol>
          <p style={{ fontSize: 12, color: UI.faint, marginTop: 10 }}>
            El detalle y el botón de aprobar viven en la pestaña Acciones.
          </p>
        </Card>
      )}

      {!hasAnything && (
        <Empty
          title="Todavía no hay análisis para esta cuenta."
          hint="Los resultados aparecerán aquí después del próximo análisis del optimizador."
        />
      )}
    </div>
  );
}

// ===========================================================================
// Acciones — la lista de propuestas, cada una aprobable (propose-only)
// ===========================================================================

function AccionesTab({
  opts,
  recs,
  cardsFromDet,
  keys,
  ctx,
}: {
  opts: Dict[];
  recs: Dict[];
  cardsFromDet: boolean;
  keys: Record<string, string>;
  ctx: ApproveCtx;
}) {
  if (opts.length === 0 && recs.length === 0) {
    return (
      <Empty
        title="No hay acciones propuestas por ahora."
        hint="Cuando el optimizador detecte desperdicio u oportunidad, aparecerán aquí para tu aprobación."
      />
    );
  }

  const ahorroT = opts
    .filter(
      (o) =>
        str_(o.tipo) === "negativas" ||
        (str_(o.tipo) === "budget" && optImp(o) < 0)
    )
    .reduce((s, o) => s + Math.abs(optImp(o)), 0);
  const oportT = opts.reduce((s, o) => s + Math.abs(optImp(o)), 0) - ahorroT;
  const detTable = !cardsFromDet ? recs.slice(0, 15) : [];

  return (
    <div style={STACK}>
      <NoteCard>
        Modo propuesta:{" "}
        <b style={{ color: UI.text, fontWeight: 550 }}>
          aprobar registra la decisión — nada se ejecuta en Google Ads
        </b>
        . Tú (o tu equipo) aplican los cambios cuando quieran.
      </NoteCard>

      {cardsFromDet && opts.length > 0 && (
        <Card
          style={{
            padding: "12px 16px",
            background: "rgba(245,158,11,0.06)",
            border: "1px solid rgba(245,158,11,0.35)",
            fontSize: 13,
            color: UI.warn,
            lineHeight: 1.5,
          }}
        >
          El razonamiento de IA no está disponible ahora — mostrando el plan del
          motor determinista (aterrizado en los números).
        </Card>
      )}

      {opts.length > 0 && (
        <Card>
          <SectionLabel>Tu plan en 1 vistazo</SectionLabel>
          <div
            style={{
              display: "flex",
              gap: 32,
              flexWrap: "wrap",
              alignItems: "baseline",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span>
              <b style={{ fontSize: 22, fontWeight: 600, color: UI.accent }}>
                {fmtMoney(ahorroT)}
              </b>{" "}
              <span style={{ fontSize: 12, color: UI.muted }}>/mes ahorras</span>
            </span>
            <span>
              <b style={{ fontSize: 22, fontWeight: 600, color: UI.text }}>
                {fmtMoney(oportT)}
              </b>{" "}
              <span style={{ fontSize: 12, color: UI.muted }}>/mes capturas</span>
            </span>
            <span>
              <b style={{ fontSize: 22, fontWeight: 600, color: UI.text }}>{opts.length}</b>{" "}
              <span style={{ fontSize: 12, color: UI.muted }}>acciones</span>
            </span>
          </div>
        </Card>
      )}

      {opts.map((o, i) => {
        const tipo = str_(o.tipo);
        const label = TIPO_LABEL[tipo ?? ""] ?? tipo ?? "Movida";
        const imp = num_(o.impacto_estimado_mxn_mes);
        const vl = valueLabel(tipo, imp);
        const conf = num_(o.confianza);
        const detalle = Array.isArray(o.detalle)
          ? (o.detalle as unknown[]).map((d) => String(d)).slice(0, 4)
          : [];
        const target = str_(o.target);
        const title = `${label}${target ? `: ${target}` : ""}`.slice(0, 120);
        return (
          <Card key={i}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 20,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 550, color: UI.text }}>
                    {label}
                  </span>
                  {conf != null && (
                    <Badge tone={confTone(conf)}>confianza {Math.round(conf)}%</Badge>
                  )}
                  {o._det ? <Badge tone="muted">motor determinista</Badge> : null}
                </div>
                {str_(o.accion) && (
                  <p style={{ fontSize: 13, marginTop: 6, color: UI.text, lineHeight: 1.5 }}>
                    {str_(o.accion)}
                  </p>
                )}
                {target && (
                  <p
                    style={{
                      fontSize: 12,
                      marginTop: 4,
                      color: UI.muted,
                      fontFamily: UI.fontMono,
                      wordBreak: "break-word",
                    }}
                  >
                    {target}
                  </p>
                )}
              </div>
              {vl && imp != null && (
                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: UI.muted,
                    }}
                  >
                    {vl.label}
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 600,
                      color: vl.color,
                      marginTop: 4,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtMoney(Math.abs(imp))}/mes
                  </div>
                </div>
              )}
            </div>

            {str_(o.expected_impact) && (
              <p style={{ fontSize: 13, marginTop: 12, color: UI.text, lineHeight: 1.5 }}>
                <span style={{ color: UI.muted }}>Qué pasará:</span>{" "}
                {str_(o.expected_impact)}
              </p>
            )}
            {detalle.length > 0 && (
              <ul
                style={{
                  fontSize: 13,
                  marginTop: 10,
                  paddingLeft: 18,
                  lineHeight: 1.7,
                  color: UI.text,
                }}
              >
                {detalle.map((d, j) => (
                  <li key={j}>{d}</li>
                ))}
              </ul>
            )}
            {str_(o.porque) && (
              <p style={{ fontSize: 12, color: UI.muted, marginTop: 10, lineHeight: 1.5 }}>
                <span style={{ color: UI.faint }}>Por qué:</span> {str_(o.porque)}
              </p>
            )}
            <div style={{ marginTop: 16 }}>
              <ApproveControl
                ctx={ctx}
                recKey={keys[`opt-${i}`]}
                title={title}
                detail={{ tipo, target, impacto_estimado_mxn_mes: imp }}
              />
            </div>
          </Card>
        );
      })}

      {detTable.length > 0 && (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel style={{ marginBottom: 0 }}>
              Recomendaciones deterministas (el grounding)
            </SectionLabel>
          </div>
          <DataTable>
            <THead
              cols={[
                { label: "Acción" },
                { label: "Target" },
                { label: "$ en juego", align: "right" },
                { label: "Confianza", align: "right" },
                { label: "", align: "right" },
              ]}
            />
            <tbody>
              {detTable.map((d, i) => {
                const cf = num_(d.confidence);
                return (
                  <Row key={i}>
                    <Cell>{str_(d.action_family) ?? "—"}</Cell>
                    <Cell style={{ color: UI.muted }}>{str_(d.target) ?? "—"}</Cell>
                    <Cell align="right" mono>
                      {fmtMoney(num_(d.dollars_at_stake))}
                    </Cell>
                    <Cell align="right" mono>
                      {cf != null ? `${Math.round(cf * 100)}%` : "—"}
                    </Cell>
                    <Cell align="right">
                      <ApproveControl
                        ctx={ctx}
                        recKey={keys[`det-${i}`]}
                        title={`${str_(d.action_family) ?? ""}: ${str_(d.target) ?? ""}`.slice(0, 80)}
                        compact
                      />
                    </Cell>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        </Card>
      )}
    </div>
  );
}

// ===========================================================================
// Segmentos — bid modifiers por dispositivo/edad/género/ingreso/día/hora
// ===========================================================================

const SEG_DIMS: [string, string][] = [
  ["device", "Dispositivo"],
  ["edad", "Edad"],
  ["genero", "Género"],
  ["ingreso", "Ingreso"],
  ["dia", "Día"],
  ["hora", "Hora"],
];

function SegmentosTab({
  diag,
  keys,
  ctx,
}: {
  diag: Dict;
  keys: Record<string, string>;
  ctx: ApproveCtx;
}) {
  const bidDims = asDict(diag.bid_dimensions);
  const acctCvr = num_(diag.cvr);

  const blocks = SEG_DIMS.map(([dkey, label]) => {
    const rows = asArr(bidDims[dkey]).slice(0, 8);
    if (rows.length === 0) return null;
    const adjustable = rows
      .map((r, idx) => ({ r, idx, v: segVerdict(num_(r.cvr), acctCvr, Boolean(r.low_vol)) }))
      .filter(({ r, v }) => v.mod != null && v.mod !== 0 && !r.low_vol);
    return (
      <Card key={dkey} style={{ padding: 0 }}>
        <div style={{ padding: "20px 24px 12px" }}>
          <SectionLabel style={{ marginBottom: 0 }}>{label}</SectionLabel>
        </div>
        <DataTable>
          <THead
            cols={[
              { label: "Segmento" },
              { label: "Gasto", align: "right" },
              { label: "Conv", align: "right" },
              { label: "CVR", align: "right" },
              { label: "Vs cuenta" },
            ]}
          />
          <tbody>
            {rows.map((r, i) => {
              const v = segVerdict(num_(r.cvr), acctCvr, Boolean(r.low_vol));
              const cvr = num_(r.cvr);
              return (
                <Row key={i}>
                  <Cell>{str_(r.seg) ?? "—"}</Cell>
                  <Cell align="right" mono>
                    {fmtMoney(num_(r.cost))}
                  </Cell>
                  <Cell align="right" mono>
                    {fmtNum(num_(r.conv))}
                  </Cell>
                  <Cell align="right" mono>
                    {cvr != null ? `${(cvr * 100).toFixed(1)}%` : "—"}
                  </Cell>
                  <Cell style={{ color: v.color, whiteSpace: "nowrap", fontWeight: 500 }}>
                    {v.label}
                  </Cell>
                </Row>
              );
            })}
          </tbody>
        </DataTable>
        {adjustable.length > 0 && (
          <div style={{ padding: "12px 24px 20px" }}>
            <p style={{ fontSize: 12, color: UI.faint, margin: "0 0 4px" }}>
              Ajustes sugeridos · aprobar registra la propuesta, no ejecuta
            </p>
            {adjustable.map(({ r, idx, v }) => {
              const seg = str_(r.seg) ?? "—";
              const mod = v.mod as number;
              return (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: "8px 0",
                    borderTop: `1px solid ${UI.border}`,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 120, fontSize: 13.5, color: UI.text }}>
                    {seg}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 550,
                      fontFamily: UI.fontMono,
                      fontVariantNumeric: "tabular-nums",
                      color: mod >= 0 ? UI.accent : UI.warn,
                    }}
                  >
                    bid {mod >= 0 ? "+" : ""}
                    {mod}%
                  </span>
                  <ApproveControl
                    ctx={ctx}
                    recKey={keys[`seg-${dkey}-${idx}`]}
                    title={`puja ${label} ${seg}: ${mod >= 0 ? "+" : ""}${mod}%`.slice(0, 80)}
                    detail={{ dimension: dkey, seg, modifier_pct: mod }}
                    compact
                  />
                </div>
              );
            })}
          </div>
        )}
      </Card>
    );
  }).filter(Boolean);

  if (blocks.length === 0) {
    return (
      <Empty
        title="Los datos por segmento se refrescan semanalmente."
        hint="Dispositivo/edad/género/ingreso/día/hora — aparecerán después del próximo refresco pesado."
      />
    );
  }

  return (
    <div style={STACK}>
      <p style={{ fontSize: 13.5, color: UI.muted, margin: 0, lineHeight: 1.5 }}>
        Cada segmento vs el CVR de tu cuenta: sube la puja donde convierte mejor,
        bájala donde peor. Aprobar solo registra la propuesta — nada se ejecuta.
      </p>
      {blocks}
    </div>
  );
}

// ===========================================================================
// Calidad — dónde pagas de más por Quality Score + landing
// ===========================================================================

function CalidadTab({ diag, gen }: { diag: Dict; gen: GenCtx }) {
  const lowQs = asArr(diag.low_qs);
  const withProblem = lowQs
    .filter((r) => Array.isArray(r.componentes_debiles) && (r.componentes_debiles as unknown[]).length > 0)
    .sort((a, b) => (num_(b.cost) ?? 0) - (num_(a.cost) ?? 0))
    .slice(0, 8);
  const total = withProblem.reduce((s, r) => s + (num_(r.cost) ?? 0), 0);
  const landing = asArr(diag.landing);

  const actionsRow = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <GenButton
        gen={gen}
        kind="landing-scan-now"
        label="Escanear landings"
        busyLabel="Escaneando…"
      />
      <GenButton
        gen={gen}
        kind="landing-brief"
        label="Brief landing/CRO"
        busyLabel="Generando…"
      />
      <span style={{ fontSize: 11, color: UI.faint }}>
        corre en el motor (~30 s) · refresca para ver el resultado
      </span>
    </div>
  );

  if (withProblem.length === 0 && lowQs.length === 0 && landing.length === 0) {
    return (
      <div style={STACK}>
        {actionsRow}
        <Empty
          title="Sin problemas de calidad detectados."
          hint="O los datos por keyword llegan en el próximo refresco pesado."
        />
      </div>
    );
  }

  return (
    <div style={STACK}>
      {actionsRow}
      {withProblem.length > 0 ? (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel>Calidad: dónde pagas de más</SectionLabel>
            <p style={{ fontSize: 13, color: UI.muted, margin: 0, lineHeight: 1.5 }}>
              En estas búsquedas tu Quality Score bajo te encarece cada clic. Arregla
              el anuncio o la landing y pagas menos por lo mismo. En juego:{" "}
              <b style={{ color: UI.text, fontWeight: 550, fontVariantNumeric: "tabular-nums" }}>
                ~{fmtMoney(total)}/mes
              </b>
              .
            </p>
          </div>
          <DataTable>
            <THead
              cols={[
                { label: "Keyword" },
                { label: "QS", align: "right" },
                { label: "Problema" },
                { label: "Arreglo" },
              ]}
            />
            <tbody>
              {withProblem.map((r, i) => {
                let prob = "su calidad es baja";
                let fix = "mejora el anuncio y la landing";
                const comps = Array.isArray(r.componentes_debiles)
                  ? (r.componentes_debiles as unknown[]).map((c) => String(c))
                  : [];
                for (const c of comps) {
                  if (QS_PROBLEM[c]) {
                    [prob, fix] = QS_PROBLEM[c];
                    break;
                  }
                }
                const qs = num_(r.qs);
                return (
                  <Row key={i}>
                    <Cell style={{ fontWeight: 500 }}>
                      {str_(r.keyword) ?? "—"}
                      {str_(r.ad_group) && (
                        <span style={{ color: UI.muted, fontWeight: 400 }}>
                          {" "}
                          · {str_(r.ad_group)}
                        </span>
                      )}
                    </Cell>
                    <Cell
                      align="right"
                      mono
                      style={{ color: qs != null && qs <= 4 ? UI.danger : UI.warn }}
                    >
                      {qs != null ? `${qs}/10` : "—"}
                    </Cell>
                    <Cell style={{ color: UI.muted }}>{prob}</Cell>
                    <Cell style={{ color: UI.text }}>{fix}</Cell>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
          <p style={{ fontSize: 12, color: UI.faint, padding: "12px 24px 20px", margin: 0 }}>
            El arreglo de cada una vive como tarjeta en Acciones.
          </p>
        </Card>
      ) : lowQs.length > 0 ? (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel style={{ marginBottom: 0 }}>
              Keywords con Quality Score bajo
            </SectionLabel>
          </div>
          <DataTable>
            <THead
              cols={[
                { label: "Keyword" },
                { label: "QS", align: "right" },
                { label: "Gasto", align: "right" },
              ]}
            />
            <tbody>
              {lowQs.slice(0, 12).map((r, i) => (
                <Row key={i}>
                  <Cell>{str_(r.keyword) ?? "—"}</Cell>
                  <Cell align="right" mono>
                    {num_(r.qs) != null ? `${num_(r.qs)}/10` : "—"}
                  </Cell>
                  <Cell align="right" mono>
                    {fmtMoney(num_(r.cost))}
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Card>
      ) : null}

      {landing.length > 0 && (
        <Card>
          <SectionLabel>Landings</SectionLabel>
          <ul style={{ fontSize: 13, paddingLeft: 18, lineHeight: 1.9, color: UI.text, margin: 0 }}>
            {landing.slice(0, 10).map((l, i) => {
              const url = str_(l.url) ?? str_(l.final_url) ?? str_(l.landing) ?? "—";
              const estado = str_(l.veredicto) ?? str_(l.status) ?? null;
              return (
                <li key={i}>
                  <span style={{ wordBreak: "break-all" }}>{url}</span>
                  {estado && <span style={{ color: UI.muted }}> · {estado}</span>}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ===========================================================================
// Auditoría — grade hero + categorías con checks + enfoque IA
// ===========================================================================

/** 8px status dot: pass = faint, warn = amber, fail = red. No emojis. */
function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        flex: "none",
        marginTop: 6,
      }}
    />
  );
}

function AuditoriaTab({
  audit,
  auditAi,
  hasRules,
  gen,
}: {
  audit: AccountFull["audit"];
  auditAi: Dict;
  hasRules: boolean;
  gen: GenCtx;
}) {
  if (!audit || !audit.grade) {
    return <Empty title="Aún no hay datos suficientes para auditar esta cuenta." />;
  }
  const gcol = gradeColor(audit.grade);
  const msg: Record<string, string> = {
    A: "Estructura sólida.",
    B: "Buena estructura, con detalles a pulir.",
    C: "Estructura mejorable: hay fugas estructurales.",
    D: "Problemas serios que limitan el rendimiento.",
    F: "Estructura deficiente: arréglala antes de escalar gasto.",
  };
  const adjGrade = str_(auditAi.grado_ajustado);
  const enfoque = str_(auditAi.enfoque);
  const hasAuditAi = Object.keys(auditAi).length > 0;
  const statusDot: Record<string, string> = {
    fail: UI.danger,
    warn: UI.warn,
    pass: UI.faint,
  };
  const order: Record<string, number> = { fail: 0, warn: 1, pass: 2 };

  return (
    <div style={STACK}>
      <Card style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        <div
          style={{
            width: 76,
            height: 76,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: UI.surface2,
            border: `1px solid ${UI.border}`,
            borderRadius: UI.radius,
            color: gcol,
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            flex: "none",
          }}
        >
          {audit.grade}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <p
            style={{
              fontSize: 15,
              fontWeight: 550,
              color: UI.text,
              margin: 0,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            Estructura {audit.score != null ? `${audit.score}/100` : "—"}
          </p>
          <p
            style={{
              fontSize: 13,
              color: UI.muted,
              margin: "4px 0 0",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {audit.n_fail ?? 0} falla(s) · {audit.n_warn ?? 0} advertencia(s)
          </p>
          <p style={{ fontSize: 13, margin: "4px 0 0", color: UI.muted }}>
            {msg[(audit.grade || "").charAt(0).toUpperCase()] ?? ""}
          </p>
          {adjGrade && (
            <p
              style={{
                fontSize: 12,
                margin: "8px 0 0",
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              <Badge tone="muted">IA</Badge>
              <span style={{ color: UI.muted }}>ajustado al contexto:</span>
              <b
                style={{
                  color: gradeColor(adjGrade),
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {adjGrade}
                {num_(auditAi.score_ajustado) != null
                  ? ` · ${num_(auditAi.score_ajustado)}/100`
                  : ""}
              </b>
            </p>
          )}
        </div>
      </Card>

      {!hasAuditAi && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <GenButton
            gen={gen}
            kind="audit-ai"
            label="Interpretar con IA"
            busyLabel="Interpretando…"
          />
          <span style={{ fontSize: 11, color: UI.faint }}>
            ajusta el grado al contexto del negocio (~30 s) · refresca para verlo
          </span>
        </div>
      )}

      {hasRules && (
        <NoteCard>
          <b style={{ color: UI.text, fontWeight: 550 }}>Reglas de negocio activas</b>
          {audit.n_suppressed
            ? ` · ${audit.n_suppressed} hallazgo(s) suprimido(s) por regla`
            : ""}{" "}
          · edítalas en la pestaña Reglas.
        </NoteCard>
      )}

      {enfoque && (
        <Card>
          <SectionLabel>Enfoque para esta cuenta (IA)</SectionLabel>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: UI.text, margin: 0 }}>{enfoque}</p>
          {str_(auditAi.justificacion) && (
            <p style={{ fontSize: 12, color: UI.muted, marginTop: 8, lineHeight: 1.5 }}>
              {str_(auditAi.justificacion)}
            </p>
          )}
        </Card>
      )}

      {(audit.categories ?? []).map((cat, ci) => {
        const cs = cat.score ?? 0;
        const ccol = cs >= 80 ? UI.accent : cs >= 50 ? UI.warn : UI.danger;
        const checks = [...asArr(cat.checks)].sort(
          (a, b) => (order[str_(a.status) ?? ""] ?? 3) - (order[str_(b.status) ?? ""] ?? 3)
        );
        return (
          <Card key={ci} style={{ padding: 20 }}>
            <details open={cs < 80}>
              <summary
                style={{
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  listStyle: "none",
                }}
              >
                <span
                  style={{
                    minWidth: 170,
                    fontSize: 13.5,
                    fontWeight: 550,
                    color: UI.text,
                  }}
                >
                  {cat.label ?? "Categoría"}
                </span>
                <span
                  style={{
                    flex: 1,
                    maxWidth: 150,
                    height: 4,
                    background: UI.border,
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${Math.max(0, Math.min(100, cs))}%`,
                      background: ccol,
                    }}
                  />
                </span>
                <span
                  style={{
                    color: ccol,
                    fontWeight: 550,
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {cs}
                </span>
              </summary>
              <div style={{ marginTop: 12 }}>
                {checks.length === 0 && (
                  <p style={{ fontSize: 13, color: UI.muted, margin: 0 }}>
                    Sin checks en esta categoría.
                  </p>
                )}
                {checks.map((c, i) => {
                  const st = str_(c.status) ?? "";
                  const dot = statusDot[st] ?? UI.faint;
                  const suppressed = Boolean(c.suppressed);
                  return (
                    <div
                      key={i}
                      style={{
                        padding: "10px 0",
                        borderBottom: `1px solid ${UI.border}`,
                        display: "flex",
                        gap: 12,
                        alignItems: "flex-start",
                      }}
                    >
                      <StatusDot color={suppressed ? UI.faint : dot} />
                      <div style={{ minWidth: 0 }}>
                        <p
                          style={{
                            fontSize: 13.5,
                            fontWeight: 500,
                            color: suppressed ? UI.faint : UI.text,
                            margin: 0,
                          }}
                        >
                          {str_(c.title) ?? "—"}
                        </p>
                        {str_(c.evidence) && (
                          <p
                            style={{
                              fontSize: 12,
                              color: suppressed ? UI.faint : UI.muted,
                              margin: "3px 0 0",
                              lineHeight: 1.5,
                            }}
                          >
                            {str_(c.evidence)}
                          </p>
                        )}
                        {str_(c.fix) && st !== "pass" && !suppressed && (
                          <p style={{ fontSize: 12, color: UI.muted, margin: "4px 0 0", lineHeight: 1.5 }}>
                            <span style={{ color: UI.faint }}>Arreglo:</span> {str_(c.fix)}
                          </p>
                        )}
                        {suppressed && (
                          <p
                            style={{
                              margin: "6px 0 0",
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              flexWrap: "wrap",
                            }}
                          >
                            <Badge tone="muted">
                              regla
                              {str_(c.suppress_reason) ? `: ${str_(c.suppress_reason)}` : ""}
                            </Badge>
                            <span style={{ fontSize: 11, color: UI.faint }}>no penaliza</span>
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          </Card>
        );
      })}
    </div>
  );
}

// ===========================================================================
// Estrategia — el perfil de negocio completo + movidas estructurales (IA)
// ===========================================================================

function EstrategiaTab({
  biz,
  estrategiaAi,
  stratMoves,
  diag,
  keys,
  ctx,
}: {
  biz: Dict;
  estrategiaAi: Dict;
  stratMoves: Dict[];
  diag: Dict;
  keys: Record<string, string>;
  ctx: ApproveCtx;
}) {
  const bizEntries = Object.entries(biz).filter(
    ([k, v]) => typeof v === "string" && v.trim() && k !== "competidores"
  ) as [string, string][];
  const competidores = Array.isArray(biz.competidores)
    ? (biz.competidores as unknown[]).map((c) => String(c)).slice(0, 12)
    : [];
  const diagGeneral = str_(estrategiaAi.diagnostico_general);
  const saturation = asArr(diag.saturation).slice(0, 8);

  const empty =
    bizEntries.length === 0 &&
    competidores.length === 0 &&
    !diagGeneral &&
    stratMoves.length === 0 &&
    saturation.length === 0;

  if (empty) {
    return (
      <Empty
        title="El plan estratégico (IA) aparecerá aquí."
        hint="Después del próximo análisis con razonamiento."
      />
    );
  }

  return (
    <div style={STACK}>
      {(bizEntries.length > 0 || competidores.length > 0) && (
        <Card>
          <SectionLabel>Perfil de negocio (IA)</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 12,
            }}
          >
            {bizEntries.map(([k, v]) => (
              <div
                key={k}
                style={{
                  padding: 12,
                  borderRadius: UI.radiusSm,
                  background: UI.surface2,
                  border: `1px solid ${UI.border}`,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: UI.muted,
                  }}
                >
                  {humanize(k)}
                </div>
                <p style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5, color: UI.text }}>
                  {v}
                </p>
              </div>
            ))}
          </div>
          {competidores.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <SectionLabel style={{ marginBottom: 8 }}>Competidores</SectionLabel>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {competidores.map((c, i) => (
                  <Badge key={i} tone="muted">
                    {c}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {(diagGeneral || stratMoves.length > 0) && (
        <Card>
          <SectionLabel>Estrategia de cuenta (IA)</SectionLabel>
          {diagGeneral && (
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: UI.text, margin: 0 }}>
              {diagGeneral}
            </p>
          )}
          {stratMoves.map((m, i) => {
            const tipo = str_(m.tipo);
            const que = str_(m.que);
            const conf = num_(m.confianza);
            const pasos = asArr(m.pasos).slice(0, 14);
            return (
              <div
                key={i}
                style={{
                  marginTop: 12,
                  padding: 16,
                  borderRadius: UI.radiusSm,
                  background: UI.surface2,
                  border: `1px solid ${UI.border}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 550, color: UI.text }}>
                    {tipo ? `${tipo.charAt(0).toUpperCase()}${tipo.slice(1)}: ` : ""}
                    {que ?? "—"}
                  </span>
                  {conf != null && (
                    <Badge tone={confTone(conf)}>confianza {Math.round(conf)}%</Badge>
                  )}
                </div>
                {str_(m.porque) && (
                  <p style={{ fontSize: 12, color: UI.muted, margin: "6px 0 0", lineHeight: 1.5 }}>
                    {str_(m.porque)}
                  </p>
                )}
                {str_(m.impacto) && (
                  <p style={{ fontSize: 12, margin: "4px 0 0", lineHeight: 1.5 }}>
                    <span style={{ color: UI.faint }}>Impacto:</span>{" "}
                    <span style={{ color: UI.accent }}>{str_(m.impacto)}</span>
                  </p>
                )}
                {pasos.length > 0 && (
                  <details style={{ marginTop: 10 }}>
                    <summary
                      style={{
                        cursor: "pointer",
                        fontSize: 12,
                        color: UI.muted,
                        fontWeight: 500,
                      }}
                    >
                      Ver plan API · {pasos.length} pasos (dry-run, no ejecuta)
                    </summary>
                    <ol
                      style={{
                        fontSize: 12,
                        marginTop: 8,
                        paddingLeft: 18,
                        lineHeight: 1.7,
                        color: UI.muted,
                      }}
                    >
                      {pasos.map((p, j) => (
                        <li key={j}>
                          {str_(p.descripcion) ?? "—"}
                          {str_(p.tool) && (
                            <span style={{ color: UI.faint, fontFamily: UI.fontMono }}>
                              {" "}
                              · {str_(p.tool)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <ApproveControl
                    ctx={ctx}
                    recKey={keys[`strat-${i}`]}
                    title={`estrategia/${tipo ?? ""}: ${que ?? ""}`.slice(0, 120)}
                    detail={{ tipo, que }}
                    compact
                  />
                  <span style={{ fontSize: 11, color: UI.faint }}>dry-run · no ejecuta</span>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {saturation.length > 0 && (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel style={{ marginBottom: 0 }}>
              Techo de mercado / saturación
            </SectionLabel>
          </div>
          <DataTable>
            <THead
              cols={[
                { label: "Campaña" },
                { label: "IS", align: "right" },
                { label: "Perd. budget", align: "right" },
                { label: "Veredicto" },
              ]}
            />
            <tbody>
              {saturation.map((c, i) => (
                <Row key={i}>
                  <Cell>{str_(c.name) ?? "—"}</Cell>
                  <Cell align="right" mono>
                    {num_(c.is) != null ? `${num_(c.is)}%` : "—"}
                  </Cell>
                  <Cell align="right" mono>
                    {num_(c.lost_budget) != null ? `${num_(c.lost_budget)}%` : "—"}
                  </Cell>
                  <Cell style={{ color: UI.muted }}>{str_(c.verdict) ?? "—"}</Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}
    </div>
  );
}

// ===========================================================================
// Análisis — momentum, forecasts, lo medido (el loop) y shadow bets
// ===========================================================================

function AnalisisTab({
  signals,
  measured,
  shadowBets,
  gen,
}: {
  signals: Dict;
  measured: Dict[];
  shadowBets: Dict[];
  gen: GenCtx;
}) {
  const trends = asArr(signals.trends);
  const forecasts = asArr(signals.forecasts).filter((f) => !f.low_data);

  const entregables = (
    <Card>
      <SectionLabel>Entregables de equipo</SectionLabel>
      <p style={{ fontSize: 12, color: UI.muted, margin: "0 0 12px", lineHeight: 1.5 }}>
        Briefs generados por IA para cada equipo — se generan en el motor
        (~30 s); refresca para verlos.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <GenButton
          gen={gen}
          kind="team-brief:creativos"
          label="Brief creativos"
          busyLabel="Generando…"
        />
        <GenButton
          gen={gen}
          kind="team-brief:audiencias"
          label="Brief audiencias"
          busyLabel="Generando…"
        />
        <GenButton
          gen={gen}
          kind="team-brief:feed"
          label="Brief feed"
          busyLabel="Generando…"
        />
        <GenButton
          gen={gen}
          kind="tracking-brief"
          label="Brief de tracking"
          busyLabel="Generando…"
        />
      </div>
    </Card>
  );

  const empty =
    trends.length === 0 && forecasts.length === 0 && measured.length === 0 && shadowBets.length === 0;
  if (empty) {
    return (
      <div style={STACK}>
        <Empty
          title="Las señales medidas aparecerán aquí cuando el sistema acumule historial."
          hint="Momentum, forecasts, el loop de medición y las apuestas sombra."
        />
        {entregables}
      </div>
    );
  }

  return (
    <div style={STACK}>
      {entregables}
      {trends.length > 0 && (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel style={{ marginBottom: 0 }}>Momentum por campaña</SectionLabel>
          </div>
          <DataTable>
            <THead cols={[{ label: "Campaña" }, { label: "Mejora", align: "right" }]} />
            <tbody>
              {trends.slice(0, 12).map((t, i) => (
                <Row key={i}>
                  <Cell>{str_(t.campana) ?? "—"}</Cell>
                  <Cell align="right" mono>
                    {signedPct(num_(t.mejora_pct))}
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}

      {forecasts.length > 0 && (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel style={{ marginBottom: 0 }}>Forecast (CPA a 7 días)</SectionLabel>
          </div>
          <DataTable>
            <THead
              cols={[
                { label: "Campaña" },
                { label: "CPA actual → 7d", align: "right" },
                { label: "Tendencia" },
                { label: "Pacing" },
              ]}
            />
            <tbody>
              {forecasts.slice(0, 10).map((f, i) => {
                const cn = num_(f.cpa_actual);
                const cp = num_(f.cpa_predicho_7d);
                const chg = num_(f.cambio_cpa_pct);
                const tend = str_(f.tendencia);
                const tcol =
                  tend === "empeorando" ? UI.danger : tend === "mejorando" ? UI.accent : UI.muted;
                const pacing = str_(asDict(f.pacing).estado);
                return (
                  <Row key={i}>
                    <Cell>{str_(f.campana) ?? str_(f.campaign) ?? "—"}</Cell>
                    <Cell align="right" mono style={{ whiteSpace: "nowrap" }}>
                      {cn != null && cp != null ? (
                        <>
                          {fmtMoney(cn)} → <span style={{ color: tcol }}>{fmtMoney(cp)}</span>
                          {chg != null ? ` (${chg > 0 ? "+" : ""}${chg}%)` : ""}
                        </>
                      ) : (
                        "—"
                      )}
                    </Cell>
                    <Cell style={{ color: tcol }}>{tend ?? "—"}</Cell>
                    <Cell style={{ color: UI.muted }}>{pacing ?? "—"}</Cell>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        </Card>
      )}

      {measured.length > 0 && (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel style={{ marginBottom: 0 }}>
              Medido (de-confundido) · el loop
            </SectionLabel>
          </div>
          <DataTable>
            <THead
              cols={[
                { label: "Acción" },
                { label: "Efecto mediano", align: "right" },
                { label: "Win rate", align: "right" },
              ]}
            />
            <tbody>
              {measured.slice(0, 10).map((m, i) => {
                const wr = num_(m.win_rate);
                return (
                  <Row key={i}>
                    <Cell>{str_(m.familia) ?? str_(m.action) ?? "—"}</Cell>
                    <Cell align="right" mono>
                      {signedPct(num_(m.efecto_mediano_pct))}
                    </Cell>
                    <Cell align="right" mono>
                      {wr != null ? `${Math.round(wr * 100)}%` : "—"}
                    </Cell>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        </Card>
      )}

      {shadowBets.length > 0 && (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "20px 24px 12px" }}>
            <SectionLabel>Apuestas sombra (paper-trading)</SectionLabel>
            <p style={{ fontSize: 12, color: UI.muted, margin: 0, lineHeight: 1.5 }}>
              Lo que habría pasado si se hubieran aplicado las propuestas — el
              costo de no actuar.
            </p>
          </div>
          <DataTable>
            <THead
              cols={[
                { label: "Acción" },
                { label: "Target" },
                { label: "Estado" },
                { label: "$ en juego", align: "right" },
                { label: "Perdido (USD)", align: "right" },
                { label: "Abierta", align: "right" },
              ]}
            />
            <tbody>
              {shadowBets.slice(0, 15).map((b, i) => (
                <Row key={i}>
                  <Cell>{str_(b.action_family) ?? str_(b.kind) ?? "—"}</Cell>
                  <Cell style={{ color: UI.muted }}>{str_(b.target) ?? "—"}</Cell>
                  <Cell>
                    <Badge tone="muted">{str_(b.status) ?? "—"}</Badge>
                  </Cell>
                  <Cell align="right" mono>
                    {fmtMoney(num_(b.dollars_at_stake))}
                  </Cell>
                  <Cell align="right" mono style={{ color: UI.danger }}>
                    {fmtMoney(num_(b.missed_usd))}
                  </Cell>
                  <Cell align="right" mono style={{ color: UI.muted, whiteSpace: "nowrap" }}>
                    {fmtDate(str_(b.opened_at))}
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}
    </div>
  );
}

// ===========================================================================
// Reglas — declara las reglas de negocio que el sistema respeta
// ===========================================================================

const INPUT: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: UI.surface,
  border: `1px solid ${UI.border}`,
  borderRadius: UI.radiusSm,
  padding: "10px 12px",
  fontSize: 13.5,
  color: UI.text,
  outline: "none",
};

const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: UI.muted,
  marginBottom: 6,
};

function ReglasTab({
  accountId,
  bp,
}: {
  accountId: string;
  bp: AccountFull["business_profile"];
}) {
  const [objetivo, setObjetivo] = useState(bp?.objetivo ?? "");
  const [cpa, setCpa] = useState(bp?.cpa_objetivo != null ? String(bp.cpa_objetivo) : "");
  const [roas, setRoas] = useState(bp?.roas_objetivo != null ? String(bp.roas_objetivo) : "");
  const [marca, setMarca] = useState(Boolean(bp?.marca_intencional));
  const [fase, setFase] = useState(bp?.fase ?? "");
  const [notas, setNotas] = useState(bp?.notas ?? "");
  const [hasRules, setHasRules] = useState(Boolean(bp));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/performance/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          objetivo: objetivo || null,
          cpa_objetivo: cpa.trim() === "" ? null : Number(cpa),
          roas_objetivo: roas.trim() === "" ? null : Number(roas),
          marca_intencional: marca,
          fase: fase || null,
          notas: notas || null,
          // pass the existing exclusions through so a save never wipes them
          excluir_campanas: bp?.excluir_campanas ?? [],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(true);
      setHasRules(true);
    } catch {
      setError("No se pudieron guardar las reglas. Inténtalo de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 680, display: "grid", gap: 16 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 550, color: UI.text }}>
            Reglas de negocio
          </span>
          {hasRules && <Badge tone="muted">reglas activas</Badge>}
        </div>
        <p style={{ fontSize: 13, color: UI.muted, margin: "8px 0 0", lineHeight: 1.5 }}>
          Lo que tú o el cliente saben y el sistema no puede adivinar. El sistema las
          respeta en todo (auditoría, recomendaciones): lo declarado manda sobre lo
          inferido. Vacío = se comporta como hoy.
        </p>
      </div>

      {saved && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: UI.radiusSm,
            fontSize: 13,
            color: UI.accent,
            border: "1px solid rgba(16,185,129,0.35)",
            background: "rgba(16,185,129,0.06)",
            lineHeight: 1.5,
          }}
        >
          Reglas guardadas — el sistema ya las respeta.
        </div>
      )}
      {error && <ErrorCard message={error} />}

      <Card>
        <label style={FIELD_LABEL}>Objetivo del cliente</label>
        <p style={{ fontSize: 12, color: UI.faint, margin: "0 0 8px", lineHeight: 1.5 }}>
          Hacia qué optimiza el sistema. Con Brandformance deja de tratar el gasto
          de marca como desperdicio.
        </p>
        <select value={objetivo} onChange={(e) => setObjetivo(e.target.value)} style={INPUT}>
          {OBJETIVOS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={FIELD_LABEL}>CPA/CPL techo ($)</label>
            <input
              type="number"
              value={cpa}
              onChange={(e) => setCpa(e.target.value)}
              placeholder="ej. 500"
              style={INPUT}
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={FIELD_LABEL}>ROAS meta</label>
            <input
              type="number"
              step="0.1"
              value={roas}
              onChange={(e) => setRoas(e.target.value)}
              placeholder="ej. 4"
              style={INPUT}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={FIELD_LABEL}>Fase</label>
            <select value={fase} onChange={(e) => setFase(e.target.value)} style={INPUT}>
              {FASES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <Card>
        <label style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={marca}
            onChange={(e) => setMarca(e.target.checked)}
            style={{ marginTop: 3, accentColor: UI.accent }}
          />
          <span>
            <span
              style={{
                display: "block",
                fontSize: 13.5,
                fontWeight: 550,
                color: UI.text,
              }}
            >
              La inversión en mi marca es intencional
            </span>
            <span
              style={{
                display: "block",
                fontSize: 12,
                color: UI.muted,
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              Defensa de marca a propósito — el sistema NO la marca como desperdicio
              ni penaliza la «fuga de marca».
            </span>
          </span>
        </label>
      </Card>

      <Card>
        <label style={FIELD_LABEL}>Notas para el sistema</label>
        <textarea
          rows={3}
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          placeholder="Algo más que el sistema deba saber…"
          style={{ ...INPUT, fontFamily: "inherit", resize: "vertical" }}
        />
      </Card>

      {(bp?.excluir_campanas?.length ?? 0) > 0 && (
        <p style={{ fontSize: 12, color: UI.faint, margin: 0, lineHeight: 1.5 }}>
          Campañas que no se deben tocar (regla dura, se conservan al guardar):{" "}
          {bp!.excluir_campanas!.join(", ")}
        </p>
      )}

      <div>
        <PrimaryButton onClick={save} disabled={saving}>
          {saving ? "Guardando…" : "Guardar reglas"}
        </PrimaryButton>
      </div>
    </div>
  );
}
