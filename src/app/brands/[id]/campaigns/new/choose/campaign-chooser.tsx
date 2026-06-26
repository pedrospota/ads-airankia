"use client";

import Link from "next/link";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";

// Two clear paths, in plain words. The Búsqueda engine is the flagship (most
// autonomous), so it's marked "Recomendado" and shown first. No jargon: we say
// what the user GETS, not the Google product name.
export function CampaignChooser({
  brandId,
  brandName,
}: {
  brandId: string;
  brandName: string;
}) {
  const { colors } = useTheme();

  const options = [
    {
      href: `/brands/${brandId}/campaigns/new/search`,
      emoji: "🔎",
      title: "Anuncios en Google",
      desc: "Tu anuncio aparece cuando alguien busca en Google justo lo que tú ofreces. La IA lo prepara casi sola: tú solo revisas y activas.",
      foot: "Lo más fácil y automático — recomendado",
      recommended: true,
    },
    {
      href: `/brands/${brandId}/campaigns/new`,
      emoji: "🖼️",
      title: "Anuncios con imagen",
      desc: "Creamos banners con tu marca y tus imágenes para que se muestren en webs, blogs y apps donde está tu público.",
      foot: "Ideal si quieres que te vean con imágenes",
      recommended: false,
    },
  ];

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Marcas", href: "/brands" },
          { label: brandName, href: `/brands/${brandId}/citations` },
          { label: "Nueva campaña" },
        ]}
      />

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div style={{ textAlign: "center", marginBottom: 8 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.5px", color: colors.text }}>
            ¿Qué quieres hacer?
          </h1>
          <p style={{ fontSize: 15, color: colors.textMuted, marginTop: 8 }}>
            Elige cómo quieres anunciar <strong>{brandName}</strong>. Puedes
            cambiar de idea cuando quieras.
          </p>
        </div>

        <div
          role="list"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: 16,
            marginTop: 28,
          }}
        >
          {options.map((o) => (
            <Link
              key={o.href}
              href={o.href}
              role="listitem"
              style={{
                display: "block",
                position: "relative",
                textDecoration: "none",
                background: colors.bgCard,
                border: `1px solid ${o.recommended ? colors.accent : colors.border}`,
                borderRadius: 16,
                padding: "22px 24px",
              }}
            >
              {o.recommended && (
                <span
                  style={{
                    position: "absolute",
                    top: 16,
                    right: 16,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    color: "#000",
                    background: colors.accent,
                    borderRadius: 999,
                    padding: "3px 10px",
                  }}
                >
                  RECOMENDADO
                </span>
              )}
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div
                  aria-hidden="true"
                  style={{
                    fontSize: 34,
                    lineHeight: 1,
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {o.emoji}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2 style={{ fontSize: 19, fontWeight: 700, color: colors.text }}>
                    {o.title}
                  </h2>
                  <p style={{ fontSize: 14, color: colors.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                    {o.desc}
                  </p>
                  <p style={{ fontSize: 12.5, color: o.recommended ? colors.accent : colors.textFaint, marginTop: 10, fontWeight: 600 }}>
                    {o.foot} →
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <p style={{ textAlign: "center", fontSize: 12.5, color: colors.textFaint, marginTop: 22 }}>
          ¿No estás seguro? Empieza por <strong>Anuncios en Google</strong>: es
          la opción más sencilla y la IA hace casi todo por ti.
        </p>
      </main>
    </div>
  );
}
