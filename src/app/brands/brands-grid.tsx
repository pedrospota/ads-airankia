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
  const { colors } = useTheme();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {brands.map((brand) => (
        <Link
          key={brand.id}
          href={`/brands/${brand.id}/citations`}
          className="group p-6 rounded-xl transition-colors"
          style={{ background: colors.bgCard, border: `1px solid ${colors.border}` }}
        >
          <div className="flex items-start gap-4">
            {brand.logo_url ? (
              <img
                src={brand.logo_url}
                alt={brand.name}
                className="w-12 h-12 rounded-lg object-cover"
                style={{ background: colors.bg }}
              />
            ) : (
              <div className="w-12 h-12 rounded-lg flex items-center justify-center font-bold text-lg"
                style={{ background: colors.bg, color: colors.textFaint }}>
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
  );
}
