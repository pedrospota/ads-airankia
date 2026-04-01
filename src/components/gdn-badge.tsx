"use client";

interface AdInfo {
  hasGdn: boolean;
  gdnPubId: string | null;
  networks: string[];
}

export function GdnBadge({ adInfo, domain }: { adInfo?: AdInfo; domain?: string }) {
  if (!adInfo) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500, background: 'rgba(161,161,170,0.15)', color: 'rgba(161,161,170,0.6)', border: '1px solid rgba(161,161,170,0.2)' }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: 'rgba(161,161,170,0.4)' }} />
        Checking...
      </span>
    );
  }

  const isYouTube = adInfo.networks.includes("YouTube");

  if (isYouTube) {
    return (
      <div className="flex flex-wrap gap-1">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500, background: 'rgba(239,68,68,0.15)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.3)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#EF4444"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
          YouTube
        </span>
      </div>
    );
  }

  if (adInfo.hasGdn) {
    return (
      <div className="flex flex-wrap gap-1">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500, background: 'rgba(16,185,129,0.15)', color: '#10B981', border: '1px solid rgba(16,185,129,0.3)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: '#10B981' }} />
          GDN
        </span>
        {adInfo.gdnPubId && (
          <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 6px', borderRadius: 99, fontSize: 10, background: 'rgba(16,185,129,0.08)', color: 'rgba(16,185,129,0.6)' }}>
            {adInfo.gdnPubId}
          </span>
        )}
      </div>
    );
  }

  if (adInfo.networks.length > 0) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500, background: 'rgba(251,191,36,0.15)', color: '#FBBF24', border: '1px solid rgba(251,191,36,0.3)' }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: '#FBBF24' }} />
        Other Ads
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500, background: 'rgba(161,161,170,0.15)', color: 'rgba(161,161,170,0.6)', border: '1px solid rgba(161,161,170,0.2)' }}>
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
          background: n === "YouTube" ? 'rgba(239,68,68,0.1)' : n === "Google" ? 'rgba(66,133,244,0.1)' : 'rgba(99,102,241,0.1)',
          color: n === "YouTube" ? 'rgba(239,68,68,0.7)' : n === "Google" ? 'rgba(66,133,244,0.7)' : 'rgba(99,102,241,0.7)',
          border: `1px solid ${n === "YouTube" ? 'rgba(239,68,68,0.2)' : n === "Google" ? 'rgba(66,133,244,0.2)' : 'rgba(99,102,241,0.2)'}`,
        }}>
          {n}
        </span>
      ))}
      {extra > 0 && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>+{extra}</span>}
    </div>
  );
}
