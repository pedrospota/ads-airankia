// ============================================================================
// /r/[account]/[token] — PUBLIC client report (no auth gate, no AppShell:
// the /r segment has no section layout, so only the root layout wraps it).
//
// The engine validates its own signed token on GET /r/{account}/{token} and
// returns a complete, self-styled report document. We proxy it server-side
// WITHOUT any key (fetchEnginePublicHtml) and inject it as-is — the engine's
// inline <style> restyles the body (white, print-friendly). On any error
// (invalid token = engine 404) we render a clean centered message.
// ============================================================================

import { fetchEnginePublicHtml } from "@/lib/sentinel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reporte de resultados",
  robots: { index: false, follow: false },
};

export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ account: string; token: string }>;
}) {
  const { account, token } = await params;

  let html: string | null = null;
  try {
    html = await fetchEnginePublicHtml(
      `/r/${encodeURIComponent(account)}/${encodeURIComponent(token)}`
    );
  } catch {
    html = null;
  }

  if (!html) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 32,
          background: "#0A0A0B",
          color: "#F7F8F8",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
          Enlace no válido
        </div>
        <p style={{ fontSize: 13.5, color: "#8A8F98", marginTop: 10, maxWidth: 420, lineHeight: 1.6 }}>
          Este enlace de reporte no existe o ya no está activo. Pide a tu agencia
          que te comparta un enlace nuevo.
        </p>
      </div>
    );
  }

  // Full-bleed injection: the engine page is a complete styled document —
  // strip nothing, just inject (browsers flatten the html/head/body tags and
  // apply its inline <style> globally).
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
