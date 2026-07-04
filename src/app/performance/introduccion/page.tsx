import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";
import { PageHeader, Card, SectionLabel, Badge, UI } from "@/components/ui-kit";

// Auth reads cookies at request time — never prerender at build.
export const dynamic = "force-dynamic";

/**
 * First-run "Introducción" for the Performance section. Purely informational:
 * no data fetch, so it renders instantly even before any account is connected.
 * Auth-gated (redirect to /login) to match every other Performance page.
 */

interface Destino {
  href: string;
  label: string;
  desc: string;
}

const VISTAS_CLAVE: Destino[] = [
  {
    href: "/performance",
    label: "Cockpit",
    desc: "El portafolio priorizado por dólares en juego: dónde está el ahorro y la oportunidad, cuenta por cuenta.",
  },
  {
    href: "/performance/auditoria",
    label: "Auditoría MCC",
    desc: "La estructura de cada cuenta calificada de la A a la F, para ver de un vistazo qué está sano y qué no.",
  },
  {
    href: "/performance/simulacion",
    label: "Simulación",
    desc: "Paper trading: mide el efecto de una propuesta sobre datos reales antes de tocar nada en la cuenta.",
  },
  {
    href: "/performance/recomendaciones",
    label: "Recomendaciones",
    desc: "El listado accionable de propuestas, cada una con su impacto estimado y el porqué detrás.",
  },
  {
    href: "/copiloto",
    label: "Copiloto",
    desc: "Pregunta a tus datos en lenguaje natural y recibe la respuesta con el contexto de tus cuentas.",
  },
];

export default async function IntroduccionPage() {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Performance", href: "/performance" },
          { label: "Introducción" },
        ]}
      />

      <main style={{ maxWidth: UI.maxWidth, margin: "0 auto", padding: "40px 32px" }}>
        <PageHeader
          title="Bienvenido a Performance"
          subtitle="El optimizador de Google Ads de AI Rankia — qué hace y por dónde empezar"
        />

        {/* Qué hace el optimizador */}
        <Card style={{ marginBottom: 32 }}>
          <SectionLabel>El optimizador en una frase</SectionLabel>
          <p
            style={{
              fontFamily: UI.fontDisplay,
              fontSize: 21,
              lineHeight: 1.5,
              letterSpacing: "-0.01em",
              color: UI.text,
              margin: 0,
              textWrap: "balance",
              maxWidth: "62ch",
            }}
          >
            Analiza tus cuentas de Google Ads, propone cambios y mide su impacto —
            <span style={{ color: UI.accent }}> pero nunca ejecuta</span> por su
            cuenta.
          </p>
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.65,
              color: UI.muted,
              margin: "16px 0 0",
              maxWidth: "68ch",
            }}
          >
            Cada propuesta llega con su ahorro u oportunidad estimados y el
            razonamiento detrás. La decisión de aplicar siempre es tuya: aquí ves,
            comparas y simulas; el cambio en la cuenta lo haces tú cuando estés
            conforme.
          </p>
        </Card>

        {/* Vistas clave */}
        <SectionLabel style={{ marginBottom: 14 }}>Vistas clave</SectionLabel>
        <div
          className="grid grid-cols-1 md:grid-cols-2"
          style={{ gap: 16, marginBottom: 32 }}
        >
          {VISTAS_CLAVE.map((v) => (
            <Link
              key={v.href}
              href={v.href}
              style={{ textDecoration: "none", display: "block" }}
            >
              <Card
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      fontFamily: UI.fontDisplay,
                      fontSize: 18,
                      fontWeight: 500,
                      letterSpacing: "-0.01em",
                      color: UI.text,
                    }}
                  >
                    {v.label}
                  </span>
                  <span
                    aria-hidden="true"
                    style={{ color: UI.faint, fontSize: 16, lineHeight: 1 }}
                  >
                    →
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    color: UI.muted,
                    margin: 0,
                  }}
                >
                  {v.desc}
                </p>
              </Card>
            </Link>
          ))}
        </div>

        {/* Para empezar */}
        <Link href="/conexiones" style={{ textDecoration: "none", display: "block" }}>
          <Card
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 20,
              borderColor: `color-mix(in srgb, ${UI.accent} 28%, transparent)`,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ marginBottom: 8 }}>
                <Badge tone="accent">Para empezar</Badge>
              </div>
              <div
                style={{
                  fontFamily: UI.fontDisplay,
                  fontSize: 19,
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                  color: UI.text,
                  marginBottom: 6,
                }}
              >
                Conecta tus cuentas en Conexiones
              </div>
              <p
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.6,
                  color: UI.muted,
                  margin: 0,
                  maxWidth: "64ch",
                }}
              >
                En cuanto vincules una cuenta de Google Ads, el optimizador empieza
                a analizarla y las propuestas aparecen en el Cockpit.
              </p>
            </div>
            <span
              aria-hidden="true"
              style={{ color: UI.accent, fontSize: 20, lineHeight: 1, flexShrink: 0 }}
            >
              →
            </span>
          </Card>
        </Link>
      </main>
    </div>
  );
}
