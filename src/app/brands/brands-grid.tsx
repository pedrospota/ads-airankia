"use client";

import Link from "next/link";
import { useTheme } from "@/components/theme-provider";

interface Brand {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  logo_url: string | null;
}

export function BrandsGrid({ brands }: { brands: Brand[] }) {
  const { theme, colors } = useTheme();

  // Every brand leads to its campaigns dashboard, from which the user can
  // review existing Search campaigns or start a new one.
  const hrefFor = (id: string) => `/brands/${id}/campaigns`;

  const hoverShadow =
    theme === "dark" ? "0 4px 16px rgba(0,0,0,0.35)" : "0 4px 16px rgba(0,0,0,0.08)";

  return (
    <>
      {/* Hover choreography (150ms) — inline styles can't express :hover. */}
      <style>{`
        .brand-card{transition:transform 150ms ease,border-color 150ms ease,box-shadow 150ms ease;}
        .brand-card:hover{transform:translateY(-1px);border-color:${colors.borderStrong} !important;box-shadow:${hoverShadow};}
      `}</style>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {brands.map((brand) => (
        <Link
          key={brand.id}
          href={hrefFor(brand.id)}
          className="brand-card rise group p-6 rounded-xl"
          style={{
            background: colors.bgCard,
            border: `1px solid ${colors.border}`,
            borderTopColor: theme === "dark" ? "rgba(255,255,255,0.11)" : colors.border,
          }}
        >
          <div className="flex items-start gap-4">
            {brand.logo_url ? (
              <img
                src={brand.logo_url}
                alt={brand.name}
                className="w-12 h-12 rounded-lg object-cover"
                style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
              />
            ) : (
              <div className="w-12 h-12 rounded-lg flex items-center justify-center font-bold text-lg"
                aria-hidden="true"
                style={{
                  background: colors.bg,
                  color: colors.textFaint,
                  border: `1px solid ${colors.border}`,
                }}>
                {brand.name.charAt(0)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold truncate" style={{ color: colors.text }}>
                {brand.name}
              </h3>
              {brand.industry && (
                <p className="text-sm mt-1 truncate" style={{ color: colors.textMuted }}>
                  {brand.industry}
                </p>
              )}
              {brand.website && (
                <p className="text-xs mt-1 truncate" style={{ color: colors.textFaint }}>
                  {brand.website}
                </p>
              )}
            </div>
          </div>
        </Link>
      ))}
      </div>
    </>
  );
}
