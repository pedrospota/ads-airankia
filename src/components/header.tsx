"use client";

import Link from "next/link";

export function Header({
  breadcrumbs,
  action,
}: {
  breadcrumbs?: { label: string; href?: string }[];
  action?: React.ReactNode;
}) {
  return (
    <header style={{ borderBottom: '1px solid #1C1C23', padding: '16px 24px', background: '#0A0A0E' }}>
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/brands" className="flex items-center gap-2">
            <img
              src="/airankia-logo-light.png"
              alt="AI Rankia"
              style={{ height: 28, width: 'auto' }}
            />
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(16,185,129,0.15)',
              color: '#10B981',
              border: '1px solid rgba(16,185,129,0.3)',
              letterSpacing: '0.05em',
            }}>
              ADS
            </span>
          </Link>
          {breadcrumbs?.map((crumb, i) => (
            <span key={i} className="flex items-center gap-3">
              <span style={{ color: '#38383F' }}>/</span>
              {crumb.href ? (
                <Link href={crumb.href} style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
                  {crumb.label}
                </Link>
              ) : (
                <span style={{ color: '#fff', fontSize: 13, fontWeight: 500 }}>
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {action}
        </div>
      </div>
    </header>
  );
}
