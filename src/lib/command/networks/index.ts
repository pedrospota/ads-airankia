import type { CcNetwork, NetworkAdapter } from "../types";
import { googleAdapter } from "./google";
import { metaAdapter } from "./meta";

const ADAPTERS: Record<CcNetwork, NetworkAdapter> = {
  google_ads: googleAdapter,
  meta_ads: metaAdapter,
};

export function adapterFor(network: CcNetwork): NetworkAdapter {
  const adapter = ADAPTERS[network];
  if (!adapter) throw new Error(`Red no soportada: ${network}`);
  return adapter;
}
