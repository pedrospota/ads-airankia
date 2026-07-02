import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { Header } from "@/components/header";

// Auth is cookie-based per-request, so never prerender this page.
export const dynamic = "force-dynamic";

const ACCENT = "#10b981";
const CARD_STYLE: React.CSSProperties = {
  background: "rgba(128,128,128,0.06)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: 12,
  padding: 24,
};

export default async function ConexionesPage() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen">
      <Header breadcrumbs={[{ label: "Conexiones" }]} />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Conexiones</h1>
          <p className="mt-2" style={{ opacity: 0.4 }}>
            Conecta tus cuentas de Google Ads y asígnalas a tus marcas
          </p>
        </div>

        <div style={{ ...CARD_STYLE, maxWidth: 640 }}>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold">Google Ads</h2>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: "rgba(16,185,129,0.12)",
                color: ACCENT,
                border: "1px solid rgba(16,185,129,0.3)",
                letterSpacing: "0.03em",
              }}
            >
              Próximamente — F3
            </span>
          </div>

          <p className="text-sm mb-3" style={{ opacity: 0.6, lineHeight: 1.6 }}>
            Aquí podrás conectar tus cuentas de Google Ads una por una y
            asignar cada cuenta a la marca que le corresponda. Una vez
            conectadas, el optimizador las analizará automáticamente y sus
            datos alimentarán las secciones de Performance y Seguridad.
          </p>
          <p className="text-sm mb-6" style={{ opacity: 0.6, lineHeight: 1.6 }}>
            Esta funcionalidad todavía no está disponible: llegará en la fase
            F3 de la plataforma.
          </p>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Disponible próximamente (F3)"
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              background: "rgba(16,185,129,0.15)",
              color: ACCENT,
              border: "1px solid rgba(16,185,129,0.3)",
              opacity: 0.5,
              cursor: "not-allowed",
            }}
          >
            Conectar Google Ads
          </button>
        </div>
      </main>
    </div>
  );
}
