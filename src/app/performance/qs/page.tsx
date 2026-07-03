// ============================================================================
// /performance/qs — explicador educativo del algoritmo de Quality Score.
// Port NATIVO del contenido del motor (qs_algoritmo): los 3 componentes del
// QS, cómo los pondera Google, cómo este sistema los mide más fino y cómo los
// convierte en acciones. Contenido estático — sin llamadas al motor.
// ============================================================================

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { PageHeader, Card, SectionLabel, Badge, UI } from "@/components/ui-kit";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Contenido (fiel a las ideas del motor, reescrito nativo)
// ---------------------------------------------------------------------------

const COMPONENTES: Array<{
  color: string;
  titulo: string;
  descripcion: string;
  medimos: string;
  peso: string;
}> = [
  {
    color: "#6AA6FF",
    titulo: "CTR esperado",
    descripcion: "Probabilidad de que tu anuncio reciba clic cuando se muestra.",
    medimos: "CTR real vs. esperado + keyword en el titular + IA que evalúa el copy.",
    peso: "~3.5 de 10",
  },
  {
    color: "#A78BFA",
    titulo: "Relevancia del anuncio",
    descripcion: "Qué tan de cerca tu anuncio coincide con la intención de la búsqueda.",
    medimos: "IA semántica: match keyword ↔ anuncio ↔ landing (embeddings).",
    peso: "~2 de 10",
  },
  {
    color: "#34D399",
    titulo: "Experiencia de landing",
    descripcion: "Qué tan relevante, útil y rápida es tu página de destino.",
    medimos: "PageSpeed / Core Web Vitals medido (score 0–100) — sin gastar cuota de Ads.",
    peso: "~3.5 de 10",
  },
];

const FUENTES: Array<{ titulo: string; url: string }> = [
  {
    titulo: "QS es diagnóstico, no input de subasta (Google)",
    url: "https://support.google.com/google-ads/answer/6167118",
  },
  {
    titulo: "Los 3 componentes del Quality Score (Google)",
    url: "https://support.google.com/google-ads/answer/6167130",
  },
  {
    titulo: "Cómo se calcula el Ad Rank — 6 factores (Google)",
    url: "https://support.google.com/google-ads/answer/1722122",
  },
  {
    titulo: "Quality Score — campos de la API (Google Ads API)",
    url: "https://developers.google.com/google-ads/api/reference/rpc/v23/AdGroupCriterion.QualityInfo",
  },
  {
    titulo: "Descomposición del QS por componente (Geddes / Adalysis)",
    url: "https://adalysis.com/google-ads-quality-score/",
  },
  {
    titulo: "Ad Strength no predice rendimiento (Optmyzr, 1M de anuncios)",
    url: "https://www.optmyzr.com/blog/google-rsa-performance-study/",
  },
  {
    titulo: "Velocidad → ventas: caso Vodafone (A/B, +8%)",
    url: "https://web.dev/case-studies/vodafone",
  },
];

const P: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.6,
  color: UI.text,
  margin: "8px 0 0",
};

const MUTED_NOTE: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: UI.muted,
  margin: "10px 0 0",
};

export default async function QsAlgoritmoPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Algoritmo de QS" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Algoritmo de Quality Score"
          subtitle="Cómo funciona el QS de verdad (validado contra la documentación oficial de Google) y cómo este sistema lo mide más fino de lo que Google muestra — ese es el moat"
        />

        {/* El insight clave */}
        <Card
          style={{
            background: "rgba(16,185,129,0.05)",
            border: "1px solid rgba(16,185,129,0.3)",
            marginBottom: 32,
          }}
        >
          <SectionLabel style={{ color: UI.accent }}>El insight clave</SectionLabel>
          <p style={{ ...P, margin: 0, maxWidth: 720 }}>
            El Quality Score 1–10 es un <strong>diagnóstico</strong>, NO un input de la
            subasta (Google: <em>&ldquo;these scores are not inputs in the ad auction&rdquo;</em>).
            Perseguir el número es un error. Lo que importa es{" "}
            <strong>cuál de los 3 componentes falla</strong> — y arreglarlo baja tu CPC real
            (más calidad = menor costo por clic).
          </p>
        </Card>

        {/* Los 3 componentes */}
        <SectionLabel>Los 3 componentes · lo que Google da vs. lo que medimos</SectionLabel>
        <div
          className="grid grid-cols-1 md:grid-cols-3"
          style={{ gap: 16, marginBottom: 12 }}
        >
          {COMPONENTES.map((c) => (
            <Card key={c.titulo} style={{ borderLeft: `3px solid ${c.color}` }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: UI.text }}>{c.titulo}</div>
              <p style={P}>{c.descripcion}</p>
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, color: UI.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Google te da
                </div>
                <p style={{ ...P, marginTop: 4 }}>
                  Bucket grueso: <Badge tone="muted">bajo</Badge>{" "}
                  <Badge tone="muted">medio</Badge> <Badge tone="muted">alto</Badge>
                </p>
              </div>
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: c.color,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  Nosotros medimos
                </div>
                <p style={{ ...P, marginTop: 4 }}>{c.medimos}</p>
              </div>
              <div style={{ marginTop: 12 }}>
                <Badge tone="muted">peso estimado: {c.peso}</Badge>
              </div>
            </Card>
          ))}
        </div>
        <p style={{ ...MUTED_NOTE, marginBottom: 32, maxWidth: 720 }}>
          Los pesos (~3.5 landing + ~3.5 CTR esperado + ~2 relevancia + 1 base = 10) son la
          heurística de industria de Geddes/Adalysis — Google no publica la ponderación
          exacta. Por eso el $ ahorrable se pondera: landing y CTR ~35% cada uno,
          relevancia ~20%.
        </p>

        {/* Cómo se convierte en acciones */}
        <SectionLabel>Cómo lo calculamos y lo convertimos en acciones</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16, marginBottom: 12 }}>
          <Card>
            <div style={{ fontSize: 15, fontWeight: 600, color: UI.text }}>
              Determinista — los hechos
            </div>
            <p style={P}>
              Scorear cada componente, encontrar el <strong>cuello de botella</strong> (el
              que más gasta), estimar el <strong>$ ahorrable</strong> (CPC → calidad,
              direccional) y priorizar por dólares. Reproducible, auditable, no alucina.
            </p>
          </Card>
          <Card>
            <div style={{ fontSize: 15, fontWeight: 600, color: UI.text }}>
              IA — el juicio
            </div>
            <p style={P}>
              Decidir qué fix importa dado el negocio, <strong>generar el copy nuevo</strong>{" "}
              (RSA) y juzgar la relevancia semántica. El matiz que ninguna regla codifica.
            </p>
          </Card>
        </div>
        <p style={{ ...MUTED_NOTE, marginBottom: 32, maxWidth: 720 }}>
          El moat es la <strong>combinación</strong>: un piso determinista de verdad sobre el
          que la IA razona sin inventar. Y como Google solo expone buckets gruesos, medimos
          más fino (PageSpeed para landing, IA para relevancia) → un QS propio, granular y
          predictivo.
        </p>

        {/* Evidencia */}
        <SectionLabel>Evidencia · cuánto pesa cada palanca</SectionLabel>
        <p style={{ ...MUTED_NOTE, margin: "0 0 16px", maxWidth: 720 }}>
          Research profundo con fuentes verificadas adversarialmente. Con esto calibramos el{" "}
          <strong>$ ahorrable</strong> — y marcamos claro qué es dato vs. heurística.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 16, marginBottom: 32 }}>
          <Card style={{ borderLeft: `3px solid ${UI.accent}` }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: UI.text }}>
              Pesos por componente (Geddes/Adalysis)
            </div>
            <p style={P}>
              QS = 1 + landing <strong>(~3.5)</strong> + CTR esperado <strong>(~3.5)</strong>{" "}
              + relevancia <strong>(~2)</strong>, sobre 10. Por eso el $ ahorrable pondera
              landing y CTR ~35% cada uno, relevancia ~20%.
            </p>
            <div style={{ marginTop: 12 }}>
              <Badge tone="warn">heurística de industria (evidencia media)</Badge>
            </div>
            <p style={MUTED_NOTE}>Google no publica los pesos.</p>
          </Card>

          <Card style={{ borderLeft: `3px solid ${UI.danger}` }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: UI.text }}>
              Mito: el Ad Strength
            </div>
            <p style={P}>
              El <strong>Ad Strength NO es factor del QS ni de la subasta</strong> (Google +
              Optmyzr sobre 1M de anuncios + Adalysis). Anuncios &ldquo;Excellent&rdquo;
              tuvieron <strong>peor CPA</strong> ($28.68) que &ldquo;Average&rdquo; ($12.43).
              Por eso NO recomendamos copy solo por subir Ad Strength — el lever real es la{" "}
              <strong>keyword en el titular / relevancia</strong>.
            </p>
            <div style={{ marginTop: 12 }}>
              <Badge tone="ok">dato primario (estudios grandes + docs de Google)</Badge>
            </div>
          </Card>

          <Card style={{ borderLeft: "3px solid #6AA6FF" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: UI.text }}>QS ↔ CPC</div>
            <p style={P}>
              Más calidad = menor CPC, relación <strong>inversa</strong> (CPC ≈ AdRank del de
              abajo / tu calidad). Pero el % exacto por punto <strong>no existe publicado</strong>{" "}
              — las cifras de WordStream (16%/punto, 50%) <strong>fallaron verificación</strong>.
              Por eso nuestro $ es direccional y acotado, nunca una promesa.
            </p>
            <div style={{ marginTop: 12 }}>
              <Badge tone="warn">dirección = dato · magnitud = heurística acotada</Badge>
            </div>
          </Card>

          <Card style={{ borderLeft: `3px solid ${UI.accent}` }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: UI.text }}>
              Landing / velocidad
            </div>
            <p style={P}>
              Palanca real: Vodafone mejoró LCP 31% → <strong>+8% ventas</strong> (A/B
              controlado); Agrofy mejoró LCP 70% → <strong>76% menos abandono</strong>. Por
              eso medimos PageSpeed / Core Web Vitals de verdad.
            </p>
            <div style={{ marginTop: 12 }}>
              <Badge tone="ok">dato primario (single-company, publicado por Google)</Badge>
            </div>
          </Card>
        </div>

        {/* Fuentes */}
        <SectionLabel>Fuentes (oficiales + estudios verificados)</SectionLabel>
        <Card>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
            {FUENTES.map((f) => (
              <li key={f.url} style={{ fontSize: 13.5, lineHeight: 1.6 }}>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: UI.accent, textDecoration: "none" }}
                >
                  {f.titulo}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </div>
  );
}
