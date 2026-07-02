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
// Spanish empty states.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { AccountFull } from "@/lib/sentinel";

type Dict = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Palette + shared styles (same look as /performance)
// ---------------------------------------------------------------------------

const ACCENT = "#10b981";
const RED = "#ef4444";
const AMBER = "#f59e0b";
const BLUE = "#60a5fa";
const PURPLE = "#a78bfa";
const MUTED = "rgba(128,128,128,0.7)";

const CARD: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
};

const TH: React.CSSProperties = {
  textAlign: "left",
  fontWeight: 500,
  padding: "8px 10px",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  opacity: 0.5,
  borderBottom: "1px solid rgba(128,128,128,0.2)",
};

const TD: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 13,
  borderBottom: "1px solid rgba(128,128,128,0.1)",
  verticalAlign: "top",
};

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
function signedPct(v: number | null | undefined): React.ReactNode {
  if (v == null || !Number.isFinite(v)) return <span style={{ color: MUTED }}>—</span>;
  const color = v > 0 ? "#34D399" : v < 0 ? "#FF5B66" : MUTED;
  return (
    <span style={{ color, fontWeight: 600 }}>
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

/** Honest $ framing per action type: saves vs deploys vs efficiency. */
function valueLabel(
  tipo: string | null,
  imp: number | null
): { label: string; color: string } | null {
  if (imp == null) return null;
  const t = (tipo || "").toLowerCase();
  if (t === "negativas") return { label: "Ahorra", color: "#34D399" };
  if (t === "budget")
    return imp >= 0
      ? { label: "Desplegar", color: BLUE }
      : { label: "Recorta", color: "#34D399" };
  if (["copy_rsa", "calidad_kw", "landing"].includes(t))
    return { label: "Calidad", color: PURPLE };
  return { label: "Eficiencia", color: AMBER };
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
    return { label: "pocos datos", color: MUTED, mod: null };
  }
  const ratio = cvr / acctCvr;
  if (ratio >= 1.25) {
    const m = Math.min(50, Math.round((ratio - 1) * 100));
    return { label: `↑ subir puja +${m}%`, color: "#34D399", mod: m };
  }
  if (ratio <= 0.6) {
    const m = Math.max(-50, Math.round((ratio - 1) * 100));
    return { label: `↓ bajar puja ${m}%`, color: AMBER, mod: m };
  }
  return { label: "≈ a tono", color: MUTED, mod: 0 };
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
  const pad = compact ? "4px 12px" : "7px 14px";
  if (!recKey) {
    return (
      <span style={{ fontSize: 12, color: MUTED }}>preparando…</span>
    );
  }
  const busy = ctx.busyKey === recKey;
  if (ctx.approved.has(recKey)) {
    const meta = ctx.approvedMeta[recKey];
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            padding: pad,
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            color: "#34D399",
            background: "rgba(16,185,129,0.12)",
            border: "1px solid rgba(16,185,129,0.35)",
          }}
        >
          Aprobada ✓{meta?.by ? ` · ${meta.by}` : ""}
        </span>
        <button
          onClick={() => ctx.revert(recKey)}
          disabled={busy}
          style={{
            background: "transparent",
            border: "none",
            color: MUTED,
            fontSize: 12,
            cursor: busy ? "wait" : "pointer",
            textDecoration: "underline",
            padding: 0,
          }}
        >
          {busy ? "deshaciendo…" : "deshacer"}
        </button>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button
        onClick={() => ctx.approve(recKey, title, detail)}
        disabled={busy}
        style={{
          padding: pad,
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 700,
          color: "#052e22",
          background: busy ? "rgba(16,185,129,0.5)" : ACCENT,
          border: "none",
          cursor: busy ? "wait" : "pointer",
        }}
      >
        {busy ? "Registrando…" : "✓ Aprobar"}
      </button>
      {!compact && (
        <span style={{ fontSize: 11, color: MUTED }}>no ejecuta aún</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small shared atoms
// ---------------------------------------------------------------------------

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...CARD, color: MUTED, fontSize: 14 }}>{children}</div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold mb-3">{children}</h2>;
}

function Chip({
  children,
  color,
}: {
  children: React.ReactNode;
  color: string;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color,
        background: `${color}1f`,
        border: `1px solid ${color}55`,
      }}
    >
      {children}
    </span>
  );
}

function gradeColor(grade: string | null | undefined): string {
  const g = (grade || "").trim().charAt(0).toUpperCase();
  if (g === "A" || g === "B") return ACCENT;
  if (g === "C") return AMBER;
  if (g === "D" || g === "F") return RED;
  return MUTED;
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
          gap: 6,
          flexWrap: "wrap",
          borderBottom: "1px solid rgba(128,128,128,0.2)",
          marginBottom: 20,
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? ACCENT : "inherit",
              opacity: tab === t.id ? 1 : 0.6,
              background: "transparent",
              border: "none",
              borderBottom:
                tab === t.id ? `2px solid ${ACCENT}` : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {actionError && (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 13,
            background: "rgba(248,113,113,0.1)",
            border: "1px solid rgba(248,113,113,0.2)",
            color: "#F87171",
          }}
        >
          {actionError}
        </div>
      )}

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
      {tab === "calidad" && <CalidadTab diag={diag} />}
      {tab === "auditoria" && (
        <AuditoriaTab audit={audit} auditAi={auditAi} hasRules={!!bp} />
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
        <AnalisisTab signals={signals} measured={measured} shadowBets={shadowBets} />
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
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        {[
          { label: "Gasto Search/mes", value: fmtMoney(gasto), color: undefined },
          { label: "Ahorro disponible", value: fmtMoney(ahorro), color: ACCENT },
          { label: "Oportunidad/mes", value: fmtMoney(oport), color: BLUE },
          { label: "Propuestas", value: fmtNum(opts.length), color: undefined },
        ].map((k) => (
          <div key={k.label} style={{ ...CARD, marginBottom: 0 }}>
            <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
              {k.label}
            </p>
            <p className="text-2xl font-bold mt-2" style={k.color ? { color: k.color } : undefined}>
              {k.value}
            </p>
          </div>
        ))}
      </div>

      {ghStatus && (
        <div style={{ marginBottom: 16 }}>
          <Chip color={ghStatus === "ok" ? ACCENT : ghStatus === "contaminada" ? AMBER : MUTED}>
            GA4 {ghStatus}
          </Chip>
          {str_(gh.nota) && (
            <span style={{ fontSize: 12, color: MUTED, marginLeft: 8 }}>{str_(gh.nota)}</span>
          )}
        </div>
      )}

      {str_(biz.que_vende) && (
        <div style={CARD}>
          <H2>Negocio (IA)</H2>
          <p style={{ fontSize: 14 }}>
            <b>{str_(biz.que_vende)}</b>
            {str_(biz.cliente) ? <> · {str_(biz.cliente)}</> : null}
            {str_(biz.objetivo_real) ? (
              <>
                {" "}
                · objetivo: <span style={{ color: ACCENT }}>{str_(biz.objetivo_real)}</span>
              </>
            ) : null}
          </p>
          {str_(biz.momento) && (
            <p style={{ fontSize: 13, marginTop: 6, opacity: 0.7 }}>
              Momento: {str_(biz.momento)}
            </p>
          )}
          {competidores.length > 0 && (
            <p style={{ fontSize: 13, marginTop: 6, color: "#FF8A93" }}>
              competidores: {competidores.join(", ")}
            </p>
          )}
        </div>
      )}

      {trends.length > 0 && (
        <div style={CARD}>
          <H2>Momentum</H2>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
            {trends.map((t, i) => (
              <span key={i}>
                <span style={{ color: MUTED }}>{str_(t.campana) ?? "campaña"}</span>{" "}
                {signedPct(num_(t.mejora_pct))}
              </span>
            ))}
          </div>
        </div>
      )}

      {top3.length > 0 && (
        <div style={{ ...CARD, borderLeft: `3px solid ${ACCENT}` }}>
          <H2>Empieza por estas (mayor impacto)</H2>
          <ol style={{ paddingLeft: 20, fontSize: 14, lineHeight: 1.9 }}>
            {top3.map((o, i) => (
              <li key={i}>
                {TIPO_LABEL[str_(o.tipo) ?? ""] ?? str_(o.tipo) ?? "Movida"}{" "}
                <span style={{ color: MUTED }}>
                  {str_(o.target) ? `· ${str_(o.target)}` : ""} ·{" "}
                  {fmtMoney(Math.abs(optImp(o)))}/mes
                </span>
              </li>
            ))}
          </ol>
          <p style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
            El detalle y el botón de aprobar viven en la pestaña <b>Acciones</b>.
          </p>
        </div>
      )}

      {!hasAnything && (
        <Empty>
          Todavía no hay análisis para esta cuenta. Los resultados aparecerán aquí
          después del próximo análisis del optimizador.
        </Empty>
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
      <Empty>
        No hay acciones propuestas por ahora. Cuando el optimizador detecte
        desperdicio u oportunidad, aparecerán aquí para tu aprobación.
      </Empty>
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
    <div>
      <div
        style={{
          padding: "10px 14px",
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 13,
          background: "rgba(96,165,250,0.08)",
          border: "1px solid rgba(96,165,250,0.25)",
        }}
      >
        Modo propuesta: <b>aprobar registra la decisión — nada se ejecuta en Google
        Ads</b>. Tú (o tu equipo) aplican los cambios cuando quieran.
      </div>

      {cardsFromDet && opts.length > 0 && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 13,
            background: "rgba(251,191,36,0.08)",
            border: "1px solid rgba(251,191,36,0.25)",
            color: AMBER,
          }}
        >
          El razonamiento de IA no está disponible ahora — mostrando el plan del
          motor determinista (aterrizado en los números).
        </div>
      )}

      {opts.length > 0 && (
        <div style={{ ...CARD, borderLeft: `3px solid ${ACCENT}` }}>
          <p
            className="text-xs uppercase tracking-wide"
            style={{ opacity: 0.5, marginBottom: 8 }}
          >
            Tu plan en 1 vistazo
          </p>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "baseline" }}>
            <span>
              <b style={{ fontSize: 22, color: ACCENT }}>{fmtMoney(ahorroT)}</b>{" "}
              <span style={{ fontSize: 12, color: MUTED }}>/mes ahorras</span>
            </span>
            <span>
              <b style={{ fontSize: 22, color: BLUE }}>{fmtMoney(oportT)}</b>{" "}
              <span style={{ fontSize: 12, color: MUTED }}>/mes capturas</span>
            </span>
            <span>
              <b style={{ fontSize: 22 }}>{opts.length}</b>{" "}
              <span style={{ fontSize: 12, color: MUTED }}>acciones</span>
            </span>
          </div>
        </div>
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
          <div key={i} style={{ ...CARD, borderLeft: `3px solid ${ACCENT}` }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 240 }}>
                <p style={{ fontSize: 15, fontWeight: 700 }}>
                  {label}{" "}
                  {conf != null && (
                    <Chip color={conf >= 70 ? ACCENT : conf >= 45 ? AMBER : MUTED}>
                      confianza {Math.round(conf)}%
                    </Chip>
                  )}
                  {o._det ? (
                    <span style={{ fontSize: 11, color: MUTED, marginLeft: 6 }}>
                      motor determinista
                    </span>
                  ) : null}
                </p>
                <p style={{ fontSize: 13, marginTop: 4, opacity: 0.8 }}>
                  {str_(o.accion) ?? ""}{" "}
                  {target && <span style={{ color: MUTED }}>{target}</span>}
                </p>
              </div>
              {vl && imp != null && (
                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <p
                    className="text-xs uppercase tracking-wide"
                    style={{ opacity: 0.5 }}
                  >
                    {vl.label}
                  </p>
                  <p style={{ fontSize: 19, fontWeight: 800, color: vl.color }}>
                    {fmtMoney(Math.abs(imp))}/mes
                  </p>
                </div>
              )}
            </div>

            {str_(o.expected_impact) && (
              <p style={{ fontSize: 13, marginTop: 8 }}>
                <b style={{ color: BLUE }}>Qué pasará:</b> {str_(o.expected_impact)}
              </p>
            )}
            {detalle.length > 0 && (
              <ul style={{ fontSize: 13, marginTop: 8, paddingLeft: 18, lineHeight: 1.6 }}>
                {detalle.map((d, j) => (
                  <li key={j}>{d}</li>
                ))}
              </ul>
            )}
            {str_(o.porque) && (
              <p style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
                <b>Por qué:</b> {str_(o.porque)}
              </p>
            )}
            <div style={{ marginTop: 12 }}>
              <ApproveControl
                ctx={ctx}
                recKey={keys[`opt-${i}`]}
                title={title}
                detail={{ tipo, target, impacto_estimado_mxn_mes: imp }}
              />
            </div>
          </div>
        );
      })}

      {detTable.length > 0 && (
        <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
          <div style={{ padding: "16px 16px 4px" }}>
            <H2>Recomendaciones deterministas (el grounding)</H2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>Acción</th>
                <th style={TH}>Target</th>
                <th style={{ ...TH, textAlign: "right" }}>$ en juego</th>
                <th style={{ ...TH, textAlign: "right" }}>Confianza</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {detTable.map((d, i) => {
                const cf = num_(d.confidence);
                return (
                  <tr key={i}>
                    <td style={TD}>{str_(d.action_family) ?? "—"}</td>
                    <td style={TD}>{str_(d.target) ?? "—"}</td>
                    <td style={{ ...TD, textAlign: "right", color: ACCENT }}>
                      {fmtMoney(num_(d.dollars_at_stake))}
                    </td>
                    <td style={{ ...TD, textAlign: "right" }}>
                      {cf != null ? `${Math.round(cf * 100)}%` : "—"}
                    </td>
                    <td style={TD}>
                      <ApproveControl
                        ctx={ctx}
                        recKey={keys[`det-${i}`]}
                        title={`${str_(d.action_family) ?? ""}: ${str_(d.target) ?? ""}`.slice(0, 80)}
                        compact
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
      <div key={dkey} style={CARD}>
        <H2>{label}</H2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>Segmento</th>
                <th style={{ ...TH, textAlign: "right" }}>Gasto</th>
                <th style={{ ...TH, textAlign: "right" }}>Conv</th>
                <th style={{ ...TH, textAlign: "right" }}>CVR</th>
                <th style={TH}>Vs cuenta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const v = segVerdict(num_(r.cvr), acctCvr, Boolean(r.low_vol));
                const cvr = num_(r.cvr);
                return (
                  <tr key={i}>
                    <td style={TD}>{str_(r.seg) ?? "—"}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{fmtMoney(num_(r.cost))}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{fmtNum(num_(r.conv))}</td>
                    <td style={{ ...TD, textAlign: "right" }}>
                      {cvr != null ? `${(cvr * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td style={{ ...TD, color: v.color, whiteSpace: "nowrap" }}>{v.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {adjustable.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>
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
                    gap: 10,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: "6px 0",
                    borderTop: "1px solid rgba(128,128,128,0.1)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 120, fontSize: 13 }}>{seg}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: mod >= 0 ? ACCENT : AMBER }}>
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
      </div>
    );
  }).filter(Boolean);

  if (blocks.length === 0) {
    return (
      <Empty>
        Los datos por segmento (dispositivo/edad/género/ingreso/día/hora) se
        refrescan semanalmente — aparecerán después del próximo refresco pesado.
      </Empty>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
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

function CalidadTab({ diag }: { diag: Dict }) {
  const lowQs = asArr(diag.low_qs);
  const withProblem = lowQs
    .filter((r) => Array.isArray(r.componentes_debiles) && (r.componentes_debiles as unknown[]).length > 0)
    .sort((a, b) => (num_(b.cost) ?? 0) - (num_(a.cost) ?? 0))
    .slice(0, 8);
  const total = withProblem.reduce((s, r) => s + (num_(r.cost) ?? 0), 0);
  const landing = asArr(diag.landing);

  if (withProblem.length === 0 && lowQs.length === 0 && landing.length === 0) {
    return (
      <Empty>
        Sin problemas de calidad detectados — o los datos por keyword llegan en el
        próximo refresco pesado.
      </Empty>
    );
  }

  return (
    <div>
      {withProblem.length > 0 ? (
        <div style={CARD}>
          <H2>Calidad: dónde pagas de más</H2>
          <p style={{ fontSize: 13, color: MUTED, marginBottom: 10 }}>
            En estas búsquedas tu Quality Score bajo te encarece cada clic. Arregla
            el anuncio o la landing y pagas menos por lo mismo. En juego:{" "}
            <b style={{ color: ACCENT }}>~{fmtMoney(total)}/mes</b>.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={TH}>Keyword</th>
                  <th style={{ ...TH, textAlign: "right" }}>QS</th>
                  <th style={TH}>Problema</th>
                  <th style={TH}>Arreglo</th>
                </tr>
              </thead>
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
                    <tr key={i}>
                      <td style={{ ...TD, fontWeight: 600 }}>
                        {str_(r.keyword) ?? "—"}
                        {str_(r.ad_group) && (
                          <span style={{ color: MUTED, fontWeight: 400 }}>
                            {" "}
                            · {str_(r.ad_group)}
                          </span>
                        )}
                      </td>
                      <td style={{ ...TD, textAlign: "right", color: qs != null && qs <= 4 ? RED : AMBER }}>
                        {qs != null ? `${qs}/10` : "—"}
                      </td>
                      <td style={TD}>{prob}</td>
                      <td style={{ ...TD, color: BLUE }}>{fix}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
            El arreglo de cada una vive como tarjeta en <b>Acciones</b>.
          </p>
        </div>
      ) : lowQs.length > 0 ? (
        <div style={CARD}>
          <H2>Keywords con Quality Score bajo</H2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={TH}>Keyword</th>
                  <th style={{ ...TH, textAlign: "right" }}>QS</th>
                  <th style={{ ...TH, textAlign: "right" }}>Gasto</th>
                </tr>
              </thead>
              <tbody>
                {lowQs.slice(0, 12).map((r, i) => (
                  <tr key={i}>
                    <td style={TD}>{str_(r.keyword) ?? "—"}</td>
                    <td style={{ ...TD, textAlign: "right" }}>
                      {num_(r.qs) != null ? `${num_(r.qs)}/10` : "—"}
                    </td>
                    <td style={{ ...TD, textAlign: "right" }}>{fmtMoney(num_(r.cost))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {landing.length > 0 && (
        <div style={CARD}>
          <H2>Landings</H2>
          <ul style={{ fontSize: 13, paddingLeft: 18, lineHeight: 1.8 }}>
            {landing.slice(0, 10).map((l, i) => {
              const url = str_(l.url) ?? str_(l.final_url) ?? str_(l.landing) ?? "—";
              const estado = str_(l.veredicto) ?? str_(l.status) ?? null;
              return (
                <li key={i}>
                  <span style={{ wordBreak: "break-all" }}>{url}</span>
                  {estado && <span style={{ color: MUTED }}> · {estado}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Auditoría — grade hero + categorías con checks + enfoque IA
// ===========================================================================

function AuditoriaTab({
  audit,
  auditAi,
  hasRules,
}: {
  audit: AccountFull["audit"];
  auditAi: Dict;
  hasRules: boolean;
}) {
  if (!audit || !audit.grade) {
    return <Empty>Aún no hay datos suficientes para auditar esta cuenta.</Empty>;
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
  const statusIcon: Record<string, [string, string]> = {
    fail: ["✕", RED],
    warn: ["⚠", AMBER],
    pass: ["✓", ACCENT],
  };
  const order: Record<string, number> = { fail: 0, warn: 1, pass: 2 };

  return (
    <div>
      <div
        style={{
          ...CARD,
          display: "flex",
          gap: 18,
          alignItems: "center",
          borderLeft: `4px solid ${gcol}`,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `3px solid ${gcol}`,
            borderRadius: 14,
            color: gcol,
            fontSize: 38,
            fontWeight: 800,
            flex: "none",
          }}
        >
          {audit.grade}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <p style={{ fontSize: 17, fontWeight: 800 }}>
            Estructura {audit.score != null ? `${audit.score}/100` : "—"}
          </p>
          <p style={{ fontSize: 13, color: gcol, fontWeight: 700 }}>
            {audit.n_fail ?? 0} falla(s) · {audit.n_warn ?? 0} advertencia(s)
          </p>
          <p style={{ fontSize: 13, marginTop: 2, opacity: 0.8 }}>
            {msg[(audit.grade || "").charAt(0).toUpperCase()] ?? ""}
          </p>
          {adjGrade && (
            <p style={{ fontSize: 12, marginTop: 4 }}>
              <Chip color={PURPLE}>IA</Chip>{" "}
              <span style={{ color: MUTED }}>ajustado al contexto:</span>{" "}
              <b style={{ color: gradeColor(adjGrade) }}>
                {adjGrade}
                {num_(auditAi.score_ajustado) != null
                  ? ` · ${num_(auditAi.score_ajustado)}/100`
                  : ""}
              </b>
            </p>
          )}
        </div>
      </div>

      {hasRules && (
        <div style={{ ...CARD, borderLeft: `3px solid ${PURPLE}`, padding: "12px 16px" }}>
          <p style={{ fontSize: 13 }}>
            <b>Reglas de negocio activas</b>
            {audit.n_suppressed
              ? ` · ${audit.n_suppressed} hallazgo(s) suprimido(s) por regla`
              : ""}{" "}
            · edítalas en la pestaña <b>Reglas</b>.
          </p>
        </div>
      )}

      {enfoque && (
        <div style={{ ...CARD, borderLeft: `3px solid ${PURPLE}` }}>
          <H2>Enfoque para esta cuenta (IA)</H2>
          <p style={{ fontSize: 14, lineHeight: 1.5 }}>{enfoque}</p>
          {str_(auditAi.justificacion) && (
            <p style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              {str_(auditAi.justificacion)}
            </p>
          )}
        </div>
      )}

      {(audit.categories ?? []).map((cat, ci) => {
        const cs = cat.score ?? 0;
        const ccol = cs >= 80 ? ACCENT : cs >= 50 ? AMBER : RED;
        const checks = [...asArr(cat.checks)].sort(
          (a, b) => (order[str_(a.status) ?? ""] ?? 3) - (order[str_(b.status) ?? ""] ?? 3)
        );
        return (
          <details key={ci} open={cs < 80} style={{ ...CARD, padding: 16 }}>
            <summary
              style={{
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 12,
                listStyle: "none",
              }}
            >
              <b style={{ minWidth: 170, fontSize: 14 }}>{cat.label ?? "Categoría"}</b>
              <span
                style={{
                  flex: 1,
                  maxWidth: 150,
                  height: 7,
                  background: "rgba(128,128,128,0.2)",
                  borderRadius: 4,
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
              <span style={{ color: ccol, fontWeight: 700, fontSize: 13 }}>{cs}</span>
            </summary>
            <div style={{ marginTop: 8 }}>
              {checks.length === 0 && (
                <p style={{ fontSize: 13, color: MUTED }}>Sin checks en esta categoría.</p>
              )}
              {checks.map((c, i) => {
                const st = str_(c.status) ?? "";
                const [icon, icol] = statusIcon[st] ?? ["•", MUTED];
                const suppressed = Boolean(c.suppressed);
                return (
                  <div
                    key={i}
                    style={{
                      padding: "9px 0",
                      borderBottom: "1px solid rgba(128,128,128,0.1)",
                      opacity: suppressed ? 0.5 : 1,
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                    }}
                  >
                    <span style={{ color: icol, flex: "none", fontWeight: 700 }}>{icon}</span>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600 }}>{str_(c.title) ?? "—"}</p>
                      {str_(c.evidence) && (
                        <p style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                          {str_(c.evidence)}
                        </p>
                      )}
                      {str_(c.fix) && st !== "pass" && (
                        <p style={{ fontSize: 12, color: BLUE, marginTop: 3 }}>
                          → {str_(c.fix)}
                        </p>
                      )}
                      {suppressed && (
                        <p style={{ fontSize: 11, marginTop: 4 }}>
                          <Chip color={PURPLE}>
                            regla de negocio
                            {str_(c.suppress_reason) ? `: ${str_(c.suppress_reason)}` : ""} · no
                            penaliza
                          </Chip>
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
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
      <Empty>
        El plan estratégico (IA) aparecerá aquí después del próximo análisis con
        razonamiento.
      </Empty>
    );
  }

  return (
    <div>
      {(bizEntries.length > 0 || competidores.length > 0) && (
        <div style={CARD}>
          <H2>Perfil de negocio (IA)</H2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {bizEntries.map(([k, v]) => (
              <div
                key={k}
                style={{
                  padding: 12,
                  borderRadius: 8,
                  background: "rgba(128,128,128,0.06)",
                  border: "1px solid rgba(128,128,128,0.12)",
                }}
              >
                <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5 }}>
                  {humanize(k)}
                </p>
                <p style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{v}</p>
              </div>
            ))}
          </div>
          {competidores.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p className="text-xs uppercase tracking-wide" style={{ opacity: 0.5, marginBottom: 6 }}>
                Competidores
              </p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {competidores.map((c, i) => (
                  <Chip key={i} color="#FF8A93">
                    {c}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {(diagGeneral || stratMoves.length > 0) && (
        <div style={{ ...CARD, borderLeft: `3px solid ${PURPLE}` }}>
          <H2>Estrategia de cuenta (IA)</H2>
          {diagGeneral && <p style={{ fontSize: 13, lineHeight: 1.6 }}>{diagGeneral}</p>}
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
                  padding: 12,
                  borderRadius: 9,
                  background: "rgba(167,139,250,0.06)",
                  border: "1px solid rgba(167,139,250,0.18)",
                }}
              >
                <p style={{ fontSize: 14, fontWeight: 700 }}>
                  {tipo ? `${tipo.charAt(0).toUpperCase()}${tipo.slice(1)}: ` : ""}
                  {que ?? "—"}{" "}
                  {conf != null && (
                    <Chip color={conf >= 70 ? ACCENT : conf >= 45 ? AMBER : MUTED}>
                      confianza {Math.round(conf)}%
                    </Chip>
                  )}
                </p>
                {str_(m.porque) && (
                  <p style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>{str_(m.porque)}</p>
                )}
                {str_(m.impacto) && (
                  <p style={{ fontSize: 12, color: "#34D399", marginTop: 3 }}>
                    → {str_(m.impacto)}
                  </p>
                )}
                {pasos.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: "pointer", fontSize: 12, color: PURPLE, fontWeight: 700 }}>
                      Ver plan API · {pasos.length} pasos (dry-run, no ejecuta)
                    </summary>
                    <ol style={{ fontSize: 12, marginTop: 6, paddingLeft: 18, lineHeight: 1.6 }}>
                      {pasos.map((p, j) => (
                        <li key={j}>
                          {str_(p.descripcion) ?? "—"}
                          {str_(p.tool) && (
                            <span style={{ color: "#34D399" }}> · {str_(p.tool)}</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <div style={{ marginTop: 10 }}>
                  <ApproveControl
                    ctx={ctx}
                    recKey={keys[`strat-${i}`]}
                    title={`estrategia/${tipo ?? ""}: ${que ?? ""}`.slice(0, 120)}
                    detail={{ tipo, que }}
                    compact
                  />
                  <span style={{ fontSize: 11, color: MUTED, marginLeft: 8 }}>
                    dry-run · no ejecuta
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {saturation.length > 0 && (
        <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
          <div style={{ padding: "16px 16px 4px" }}>
            <H2>Techo de mercado / saturación</H2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>Campaña</th>
                <th style={{ ...TH, textAlign: "right" }}>IS</th>
                <th style={{ ...TH, textAlign: "right" }}>Perd. budget</th>
                <th style={TH}>Veredicto</th>
              </tr>
            </thead>
            <tbody>
              {saturation.map((c, i) => (
                <tr key={i}>
                  <td style={TD}>{str_(c.name) ?? "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {num_(c.is) != null ? `${num_(c.is)}%` : "—"}
                  </td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {num_(c.lost_budget) != null ? `${num_(c.lost_budget)}%` : "—"}
                  </td>
                  <td style={TD}>{str_(c.verdict) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
}: {
  signals: Dict;
  measured: Dict[];
  shadowBets: Dict[];
}) {
  const trends = asArr(signals.trends);
  const forecasts = asArr(signals.forecasts).filter((f) => !f.low_data);

  const empty =
    trends.length === 0 && forecasts.length === 0 && measured.length === 0 && shadowBets.length === 0;
  if (empty) {
    return (
      <Empty>
        Las señales medidas (momentum, forecasts, el loop de medición y las
        apuestas sombra) aparecerán aquí cuando el sistema acumule historial.
      </Empty>
    );
  }

  return (
    <div>
      {trends.length > 0 && (
        <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
          <div style={{ padding: "16px 16px 4px" }}>
            <H2>Momentum por campaña</H2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>Campaña</th>
                <th style={{ ...TH, textAlign: "right" }}>Mejora</th>
              </tr>
            </thead>
            <tbody>
              {trends.slice(0, 12).map((t, i) => (
                <tr key={i}>
                  <td style={TD}>{str_(t.campana) ?? "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{signedPct(num_(t.mejora_pct))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {forecasts.length > 0 && (
        <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
          <div style={{ padding: "16px 16px 4px" }}>
            <H2>Forecast (CPA a 7 días)</H2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>Campaña</th>
                <th style={{ ...TH, textAlign: "right" }}>CPA actual → 7d</th>
                <th style={TH}>Tendencia</th>
                <th style={TH}>Pacing</th>
              </tr>
            </thead>
            <tbody>
              {forecasts.slice(0, 10).map((f, i) => {
                const cn = num_(f.cpa_actual);
                const cp = num_(f.cpa_predicho_7d);
                const chg = num_(f.cambio_cpa_pct);
                const tend = str_(f.tendencia);
                const tcol =
                  tend === "empeorando" ? RED : tend === "mejorando" ? "#34D399" : MUTED;
                const pacing = str_(asDict(f.pacing).estado);
                return (
                  <tr key={i}>
                    <td style={TD}>{str_(f.campana) ?? str_(f.campaign) ?? "—"}</td>
                    <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap" }}>
                      {cn != null && cp != null ? (
                        <>
                          {fmtMoney(cn)} → <span style={{ color: tcol }}>{fmtMoney(cp)}</span>
                          {chg != null ? ` (${chg > 0 ? "+" : ""}${chg}%)` : ""}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ ...TD, color: tcol }}>{tend ?? "—"}</td>
                    <td style={TD}>{pacing ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {measured.length > 0 && (
        <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
          <div style={{ padding: "16px 16px 4px" }}>
            <H2>Medido (de-confundido) · el loop</H2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>Acción</th>
                <th style={{ ...TH, textAlign: "right" }}>Efecto mediano</th>
                <th style={{ ...TH, textAlign: "right" }}>Win rate</th>
              </tr>
            </thead>
            <tbody>
              {measured.slice(0, 10).map((m, i) => {
                const wr = num_(m.win_rate);
                return (
                  <tr key={i}>
                    <td style={TD}>{str_(m.familia) ?? str_(m.action) ?? "—"}</td>
                    <td style={{ ...TD, textAlign: "right" }}>
                      {signedPct(num_(m.efecto_mediano_pct))}
                    </td>
                    <td style={{ ...TD, textAlign: "right" }}>
                      {wr != null ? `${Math.round(wr * 100)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shadowBets.length > 0 && (
        <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
          <div style={{ padding: "16px 16px 4px" }}>
            <H2>Apuestas sombra (paper-trading)</H2>
            <p style={{ fontSize: 12, color: MUTED, padding: "0 0 4px" }}>
              Lo que habría pasado si se hubieran aplicado las propuestas — el
              costo de no actuar.
            </p>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>Acción</th>
                <th style={TH}>Target</th>
                <th style={TH}>Estado</th>
                <th style={{ ...TH, textAlign: "right" }}>$ en juego</th>
                <th style={{ ...TH, textAlign: "right" }}>Perdido (USD)</th>
                <th style={{ ...TH, textAlign: "right" }}>Abierta</th>
              </tr>
            </thead>
            <tbody>
              {shadowBets.slice(0, 15).map((b, i) => (
                <tr key={i}>
                  <td style={TD}>{str_(b.action_family) ?? str_(b.kind) ?? "—"}</td>
                  <td style={TD}>{str_(b.target) ?? "—"}</td>
                  <td style={TD}>{str_(b.status) ?? "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {fmtMoney(num_(b.dollars_at_stake))}
                  </td>
                  <td style={{ ...TD, textAlign: "right", color: RED }}>
                    {fmtMoney(num_(b.missed_usd))}
                  </td>
                  <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap", opacity: 0.6 }}>
                    {fmtDate(str_(b.opened_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Reglas — declara las reglas de negocio que el sistema respeta
// ===========================================================================

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

  const INPUT: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    background: "rgba(128,128,128,0.08)",
    border: "1px solid rgba(128,128,128,0.25)",
    borderRadius: 8,
    padding: "9px 11px",
    fontSize: 14,
    color: "inherit",
  };

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
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <H2>Reglas de negocio</H2>
        {hasRules && <Chip color={PURPLE}>reglas activas</Chip>}
      </div>
      <p style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
        Lo que tú o el cliente saben y el sistema no puede adivinar. El sistema las
        respeta en todo (auditoría, recomendaciones): lo declarado manda sobre lo
        inferido. Vacío = se comporta como hoy.
      </p>

      {saved && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            marginBottom: 14,
            fontSize: 13,
            color: "#34D399",
            border: "1px solid rgba(16,185,129,0.4)",
            background: "rgba(16,185,129,0.08)",
          }}
        >
          ✓ Reglas guardadas — el sistema ya las respeta.
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            marginBottom: 14,
            fontSize: 13,
            color: "#F87171",
            border: "1px solid rgba(248,113,113,0.3)",
            background: "rgba(248,113,113,0.08)",
          }}
        >
          {error}
        </div>
      )}

      <div style={CARD}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
          Objetivo del cliente
        </label>
        <p style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
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

        <div style={{ display: "flex", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>
              CPA/CPL techo ($)
            </label>
            <input
              type="number"
              value={cpa}
              onChange={(e) => setCpa(e.target.value)}
              placeholder="ej. 500"
              style={INPUT}
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>
              ROAS meta
            </label>
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
            <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>
              Fase
            </label>
            <select value={fase} onChange={(e) => setFase(e.target.value)} style={INPUT}>
              {FASES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div style={CARD}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={marca}
            onChange={(e) => setMarca(e.target.checked)}
            style={{ marginTop: 3, accentColor: ACCENT }}
          />
          <span>
            <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>
              La inversión en mi marca es intencional
            </span>
            <span style={{ display: "block", fontSize: 12, color: MUTED }}>
              Defensa de marca a propósito — el sistema NO la marca como desperdicio
              ni penaliza la «fuga de marca».
            </span>
          </span>
        </label>
      </div>

      <div style={CARD}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
          Notas para el sistema
        </label>
        <textarea
          rows={3}
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          placeholder="Algo más que el sistema deba saber…"
          style={{ ...INPUT, fontFamily: "inherit", resize: "vertical" }}
        />
      </div>

      {(bp?.excluir_campanas?.length ?? 0) > 0 && (
        <p style={{ fontSize: 12, color: MUTED, marginBottom: 14 }}>
          Campañas que no se deben tocar (regla dura, se conservan al guardar):{" "}
          {bp!.excluir_campanas!.join(", ")}
        </p>
      )}

      <button
        onClick={save}
        disabled={saving}
        style={{
          padding: "10px 20px",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 700,
          color: "#052e22",
          background: saving ? "rgba(16,185,129,0.5)" : ACCENT,
          border: "none",
          cursor: saving ? "wait" : "pointer",
        }}
      >
        {saving ? "Guardando…" : "Guardar reglas"}
      </button>
    </div>
  );
}
