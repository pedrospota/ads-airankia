import type { CcActionStatus } from "./types";

const TRANSITIONS: Record<CcActionStatus, CcActionStatus[]> = {
  proposed: ["approved", "rejected", "expired"],
  // approved→approved is a legal self-loop: the executor re-records gate_results on a
  // gate-blocked execution while the action legitimately stays approved for retry.
  approved: ["executing", "rejected", "expired", "approved"],
  executing: ["executed", "failed"],
  executed: ["verified", "rolled_back"],
  verified: ["rolled_back"],
  failed: ["approved", "rejected"],
  rolled_back: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: CcActionStatus, to: CcActionStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: CcActionStatus, to: CcActionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transición inválida: ${from} → ${to}`);
  }
}
