"use client";

import { useMode, type AppMode } from "@/components/mode-provider";
import { useTheme } from "@/components/theme-provider";

const OPTIONS: { value: AppMode; label: string }[] = [
  { value: "clasico", label: "Clásico" },
  { value: "nuevo", label: "Nuevo" },
];

export function ModeSwitch() {
  const { mode, setMode } = useMode();
  const { colors } = useTheme();

  return (
    <div
      className="flex items-center"
      role="group"
      aria-label="Cambiar interfaz"
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 2,
        gap: 2,
      }}
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => setMode(opt.value)}
            aria-pressed={active}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              background: active ? colors.accent : "transparent",
              color: active ? "#FFFFFF" : colors.textMuted,
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
