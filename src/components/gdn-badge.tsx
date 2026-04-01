import { isGdnAvailable } from "@/lib/queries";

export function GdnBadge({ domain }: { domain: string }) {
  const available = isGdnAvailable(domain);

  if (available) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        GDN
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-500/20 text-zinc-500 border border-zinc-500/30">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
      Unknown
    </span>
  );
}
