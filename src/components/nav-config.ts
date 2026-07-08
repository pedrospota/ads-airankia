/**
 * nav-config.ts — pure nav data shared by the sidebar and the ⌘K command
 * palette. No "use client", no React imports: this is what makes the
 * security-relevant Admin-nav gating unit-testable in isolation
 * (nav-config.test.ts) without a DOM or a browser environment.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface Destination {
  label: string;
  href: string;
  section: string;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Principal",
    items: [{ href: "/brands", label: "Marcas", icon: "brands" }],
  },
  {
    label: "Asistentes",
    items: [
      { href: "/copiloto", label: "Copiloto", icon: "copiloto" },
      { href: "/keywords", label: "Keywords", icon: "keywords" },
    ],
  },
  {
    label: "Rendimiento",
    items: [
      { href: "/performance/introduccion", label: "Introduccion", icon: "introduccion" },
      { href: "/performance", label: "Cockpit", icon: "cockpit" },
      { href: "/performance/recomendaciones", label: "Recomendaciones", icon: "recomendaciones" },
      { href: "/performance/diagnostics", label: "Diagnostico", icon: "diagnostics" },
      { href: "/performance/auditoria", label: "Auditoria MCC", icon: "auditoria" },
      { href: "/performance/simulacion", label: "Simulacion", icon: "simulacion" },
      { href: "/performance/backtest", label: "Backtest", icon: "backtest" },
      { href: "/performance/playbook", label: "Playbook", icon: "playbook" },
      { href: "/performance/qs", label: "QS", icon: "qs" },
      { href: "/performance/datalake", label: "Datalake", icon: "datalake" },
      { href: "/performance/costos", label: "Costos", icon: "costos" },
      { href: "/performance/salud", label: "Salud", icon: "salud" },
      { href: "/performance/ajustes", label: "Ajustes", icon: "ajustes" },
    ],
  },
  {
    label: "Seguridad",
    items: [
      { href: "/security", label: "Monitor", icon: "monitor" },
      { href: "/security/equipo", label: "Equipo", icon: "equipo" },
      { href: "/security/dominios", label: "Dominios", icon: "dominios" },
    ],
  },
  {
    label: "Inteligencia",
    items: [{ href: "/spy", label: "Ad Spy", icon: "spy" }],
  },
  {
    label: "Cuenta",
    items: [{ href: "/conexiones", label: "Conexiones", icon: "conexiones" }],
  },
];

// Centro de Mando (beta): additive group, spliced in right after "Principal"
// only when the flag+admin gate (threaded from AppShell) is on. NAV_GROUPS
// itself stays untouched so the ungated nav is byte-identical.
const COMMAND_GROUP: NavGroup = {
  label: "Centro de Mando",
  items: [
    { href: "/command", label: "Resumen", icon: "comando" },
    { href: "/command/crear", label: "Constructor", icon: "comando" },
    { href: "/command/acciones", label: "Acciones", icon: "comando" },
    { href: "/command/cuentas", label: "Cuentas", icon: "comando" },
    { href: "/command/bitacora", label: "Bitácora", icon: "comando" },
  ],
};

const DESTINATIONS: Destination[] = [
  // Rendimiento
  { label: "Cockpit", href: "/performance", section: "Rendimiento" },
  { label: "Recomendaciones", href: "/performance/recomendaciones", section: "Rendimiento" },
  { label: "Diagnostico", href: "/performance/diagnostics", section: "Rendimiento" },
  { label: "Auditoria MCC", href: "/performance/auditoria", section: "Rendimiento" },
  { label: "Simulacion", href: "/performance/simulacion", section: "Rendimiento" },
  { label: "Backtest", href: "/performance/backtest", section: "Rendimiento" },
  { label: "Playbook", href: "/performance/playbook", section: "Rendimiento" },
  { label: "QS", href: "/performance/qs", section: "Rendimiento" },
  { label: "Datalake", href: "/performance/datalake", section: "Rendimiento" },
  { label: "Costos", href: "/performance/costos", section: "Rendimiento" },
  { label: "Salud", href: "/performance/salud", section: "Rendimiento" },
  { label: "Ajustes", href: "/performance/ajustes", section: "Rendimiento" },
  { label: "Introduccion", href: "/performance/introduccion", section: "Rendimiento" },
  // Seguridad
  { label: "Monitor", href: "/security", section: "Seguridad" },
  { label: "Equipo", href: "/security/equipo", section: "Seguridad" },
  { label: "Dominios", href: "/security/dominios", section: "Seguridad" },
  // Principal
  { label: "Marcas", href: "/brands", section: "Principal" },
  // Inteligencia
  { label: "Ad Spy", href: "/spy", section: "Inteligencia" },
  { label: "Copiloto", href: "/copiloto", section: "Inteligencia" },
  { label: "Keywords", href: "/keywords", section: "Inteligencia" },
  // Cuenta
  { label: "Conexiones", href: "/conexiones", section: "Cuenta" },
];

// Centro de Mando (beta): only appended to the searchable index when
// `commandCenter` (threaded from AppShell's flag+admin gate) is true.
const COMMAND_DESTINATIONS: Destination[] = [
  { label: "Centro de Mando · Resumen", href: "/command", section: "Centro de Mando" },
  { label: "Centro de Mando · Constructor", href: "/command/crear", section: "Centro de Mando" },
  { label: "Centro de Mando · Acciones", href: "/command/acciones", section: "Centro de Mando" },
  { label: "Centro de Mando · Cuentas", href: "/command/cuentas", section: "Centro de Mando" },
  { label: "Centro de Mando · Bitácora", href: "/command/bitacora", section: "Centro de Mando" },
];

// The Admin entry was in the UNCONDITIONAL groups until v3.0 — every logged-in
// user saw a link to /admin (the route 401'd, but v3.0 introduces operators,
// so the nav itself must be role-aware). It is now appended ONLY for platform
// admins, mirroring how COMMAND_GROUP is spliced for command users.
const ADMIN_NAV_ITEM: NavItem = { href: "/admin", label: "Admin", icon: "admin" };
const ADMIN_DESTINATION: Destination = { label: "Admin", href: "/admin", section: "Cuenta" };

export function navGroups(commandCenter: boolean, isPlatformAdmin: boolean): NavGroup[] {
  const base = commandCenter
    ? [...NAV_GROUPS.slice(0, 1), COMMAND_GROUP, ...NAV_GROUPS.slice(1)]
    : NAV_GROUPS;
  if (!isPlatformAdmin) return base;
  return base.map((g) =>
    g.label === "Cuenta" ? { ...g, items: [...g.items, ADMIN_NAV_ITEM] } : g
  );
}

export function paletteDestinations(commandCenter: boolean, isPlatformAdmin: boolean): Destination[] {
  return [
    ...DESTINATIONS,
    ...(isPlatformAdmin ? [ADMIN_DESTINATION] : []),
    ...(commandCenter ? COMMAND_DESTINATIONS : []),
  ];
}
