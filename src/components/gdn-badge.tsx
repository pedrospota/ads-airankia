"use client";

interface AdInfo {
  hasGdn: boolean;
  gdnPubId: string | null;
  networks: string[];
}

export function GdnBadge({ adInfo }: { adInfo?: AdInfo; domain?: string }) {
  if (!adInfo) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500,
        background: 'rgba(161,161,170,0.15)', color: 'rgba(161,161,170,0.6)',
        border: '1px solid rgba(161,161,170,0.2)',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: 'rgba(161,161,170,0.4)' }} />
        Checking...
      </span>
    );
  }

  if (adInfo.hasGdn) {
    return (
      <div className="flex flex-wrap gap-1">
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500,
          background: 'rgba(16,185,129,0.15)', color: '#10B981',
          border: '1px solid rgba(16,185,129,0.3)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: '#10B981' }} />
          GDN
        </span>
        {adInfo.gdnPubId && (
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 6px', borderRadius: 99, fontSize: 10,
            background: 'rgba(16,185,129,0.08)', color: 'rgba(16,185,129,0.6)',
          }}>
            {adInfo.gdnPubId}
          </span>
        )}
      </div>
    );
  }

  if (adInfo.networks.length > 0) {
    return (
      <div className="flex flex-wrap gap-1">
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500,
          background: 'rgba(251,191,36,0.15)', color: '#FBBF24',
          border: '1px solid rgba(251,191,36,0.3)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: '#FBBF24' }} />
          Other Ads
        </span>
      </div>
    );
  }

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500,
      background: 'rgba(161,161,170,0.15)', color: 'rgba(161,161,170,0.6)',
      border: '1px solid rgba(161,161,170,0.2)',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: 'rgba(161,161,170,0.4)' }} />
      No Ads
    </span>
  );
}

export function NetworkPills({ networks }: { networks: string[] }) {
  if (networks.length === 0) return null;
  const shown = networks.slice(0, 4);
  const extra = networks.length - shown.length;

  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((n) => (
        <span key={n} style={{
          padding: '1px 6px', borderRadius: 99, fontSize: 10,
          background: 'rgba(99,102,241,0.1)', color: 'rgba(99,102,241,0.7)',
          border: '1px solid rgba(99,102,241,0.2)',
        }}>
          {n}
        </span>
      ))}
      {extra > 0 && (
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
          +{extra}
        </span>
      )}
    </div>
  );
}
