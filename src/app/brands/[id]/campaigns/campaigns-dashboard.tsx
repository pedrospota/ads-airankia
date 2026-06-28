"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";

// One row in the Search campaigns list. Built server-side in page.tsx.
export interface CampaignListItem {
  campaignId: string;
  runId: string | null;
  displayName: string;
  campaignStatus: string; // draft | active | paused | exhausted | stopped
  runStatus: string | null; // queued|running|awaiting_approval|completed|failed|aborted
  googleCampaignId: string | null;
  dailyBudgetCents: number | null;
  landingPageUrl: string | null;
  createdAt: string | null; // ISO
  deepLink: string | null;
}

interface DashboardProps {
  brandId: string;
  brandName: string;
  items: CampaignListItem[];
}

// Symbol shown next to budgets (display only; Google charges in account currency).
const CURRENCY = "€";

interface StatusInfo {
  label: string;
  color: string;
  bg: string;
  /** What the main button says for this state. */
  action: string;
}

// Friendly, plain-Spanish status derived from the campaign + run state.
function statusFor(item: CampaignListItem): StatusInfo {
  const inGoogle = item.googleCampaignId != null;
  if (inGoogle && item.campaignStatus === "active") {
    return {
      label: "Active",
      color: "#10B981",
      bg: "rgba(16,185,129,0.12)",
      action: "View details",
    };
  }
  if (inGoogle) {
    // Created in Google but not enabled (paused / draft row).
    return {
      label: "Created · paused",
      color: "#FBBF24",
      bg: "rgba(251,191,36,0.12)",
      action: "View and turn on",
    };
  }
  // Not in Google yet → still being built or unfinished.
  if (item.runStatus === "running" || item.runStatus === "queued") {
    return {
      label: "Being created…",
      color: "#3B82F6",
      bg: "rgba(59,130,246,0.12)",
      action: "Continue",
    };
  }
  if (item.runStatus === "awaiting_approval") {
    return {
      label: "Waiting for your review",
      color: "#3B82F6",
      bg: "rgba(59,130,246,0.12)",
      action: "Review",
    };
  }
  if (item.runStatus === "failed" || item.runStatus === "aborted") {
    return {
      label: "Unfinished",
      color: "#F87171",
      bg: "rgba(248,113,113,0.12)",
      action: "Resume",
    };
  }
  // Completed-but-not-activated, or a fresh draft.
  return {
    label: "Ready to turn on",
    color: "#FBBF24",
    bg: "rgba(251,191,36,0.12)",
    action: "Review and turn on",
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function CampaignsDashboard({ brandId, brandName, items }: DashboardProps) {
  const { colors } = useTheme();
  const router = useRouter();
  const newHref = `/brands/${brandId}/campaigns/new/search`;

  // Which campaign (by run id) is currently being discarded.
  const [discardingId, setDiscardingId] = useState<string | null>(null);

  // Clean-up mode: an opt-in multi-select for permanently deleting test
  // campaigns. Hidden by default so the normal (non-expert) user never sees
  // destructive controls — you turn it on explicitly when you want to tidy up.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // In-flight bulk delete, cancelled if the component unmounts mid-run.
  const bulkAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => bulkAbortRef.current?.abort(), []);

  // Only campaigns with a run can be cleaned up here (the delete route is keyed
  // by run id, exactly like Discard).
  const selectable = items.filter((i) => i.runId);

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedRunIds(new Set());
  }

  function toggleSelected(runId: string) {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedRunIds((prev) => {
      if (prev.size === selectable.length) return new Set();
      return new Set(selectable.map((i) => i.runId as string));
    });
  }

  // Permanently delete every selected campaign. Each id is deleted independently
  // (its own ownership check + transaction server-side); we report how many went
  // through. Unlike Discard, this physically removes the rows — it can't be undone.
  async function bulkDelete() {
    const ids = Array.from(selectedRunIds);
    if (ids.length === 0) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Permanently delete ${ids.length} campaign${ids.length === 1 ? "" : "s"}?\n\n` +
          "This removes them from Google Ads (nothing was spent — they were paused) " +
          "and erases them here for good. This can't be undone.",
      )
    ) {
      return;
    }

    bulkAbortRef.current?.abort();
    const controller = new AbortController();
    bulkAbortRef.current = controller;

    setBulkDeleting(true);
    try {
      const results = await Promise.allSettled(
        ids.map((runId) =>
          fetch(`/api/search/runs/${runId}/delete`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
          }).then(async (r) => {
            const data = (await r.json()) as { ok?: boolean; error?: string };
            if (!r.ok || !data.ok) {
              throw new Error(data.error || "delete failed");
            }
            return runId;
          }),
        ),
      );

      if (controller.signal.aborted) return;

      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0 && typeof window !== "undefined") {
        const firstErr = results.find((r) => r.status === "rejected") as
          | PromiseRejectedResult
          | undefined;
        window.alert(
          `${ids.length - failed} of ${ids.length} deleted. ` +
            `${failed} couldn't be deleted` +
            (firstErr?.reason instanceof Error
              ? ` (${firstErr.reason.message})`
              : "") +
            ".",
        );
      }
      exitSelectMode();
      router.refresh();
    } catch (e) {
      if (controller.signal.aborted) return;
      if (typeof window !== "undefined") {
        window.alert(
          e instanceof Error ? e.message : "We couldn't delete the campaigns.",
        );
      }
    } finally {
      if (bulkAbortRef.current === controller) bulkAbortRef.current = null;
      setBulkDeleting(false);
    }
  }

  // Discard / undo: safe at any time because Search campaigns are created
  // PAUSED and never spend. Removes it from Google (if it got there) and drops
  // it from this list. The end user is the one clicking, so this is the only
  // place that touches their account from the dashboard.
  async function discard(runId: string) {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "We're going to remove this campaign from your Google Ads account.\n\nNothing has been spent (it was paused) and you can create another one whenever you want.\n\nAre you sure you want to discard it?",
      )
    ) {
      return;
    }
    setDiscardingId(runId);
    try {
      const r = await fetch(`/api/search/runs/${runId}/discard`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !data.ok) {
        throw new Error(data.error || "We couldn't discard the campaign.");
      }
      router.refresh();
    } catch (e) {
      if (typeof window !== "undefined") {
        window.alert(
          e instanceof Error ? e.message : "We couldn't discard the campaign.",
        );
      }
    } finally {
      setDiscardingId(null);
    }
  }

  return (
    <div className="min-h-screen">
      <Header
        breadcrumbs={[
          { label: "Brands", href: "/brands" },
          { label: brandName, href: `/brands/${brandId}/citations` },
          { label: "Campaigns" },
        ]}
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {selectable.length > 0 &&
              (selectMode ? (
                <button
                  onClick={exitSelectMode}
                  disabled={bulkDeleting}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 10,
                    background: "transparent",
                    border: `1px solid ${colors.border}`,
                    color: colors.text,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: bulkDeleting ? "not-allowed" : "pointer",
                  }}
                >
                  Done
                </button>
              ) : (
                <button
                  onClick={() => setSelectMode(true)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 10,
                    background: "transparent",
                    border: `1px solid ${colors.border}`,
                    color: colors.textMuted,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Select to clean up
                </button>
              ))}
            <Link
              href={newHref}
              style={{
                padding: "8px 16px",
                borderRadius: 10,
                background: colors.accent,
                color: "#000",
                fontWeight: 700,
                fontSize: 13,
                textDecoration: "none",
              }}
            >
              + New campaign
            </Link>
          </div>
        }
      />

      <main className="max-w-3xl mx-auto px-6 py-8">
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            Your Search campaigns
          </h1>
          <p style={{ fontSize: 14, color: colors.textMuted }}>
            Here you can see all your campaigns and where each one stands. You
            can come back anytime to review them, turn them on, or pick up one
            you left halfway.
          </p>
        </div>

        {items.length === 0 ? (
          <div
            style={{
              background: colors.bgCard,
              border: `1px solid ${colors.border}`,
              borderRadius: 14,
              padding: 40,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 12 }}>🚀</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
              You don't have any campaigns yet
            </h2>
            <p
              style={{
                fontSize: 14,
                color: colors.textMuted,
                marginBottom: 20,
                maxWidth: 380,
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              Create your first campaign in just a few minutes. We take care of
              everything and leave it paused so you decide when to start.
            </p>
            <Link
              href={newHref}
              style={{
                display: "inline-block",
                padding: "11px 22px",
                borderRadius: 10,
                background: colors.accent,
                color: "#000",
                fontWeight: 700,
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              Create my first campaign
            </Link>
          </div>
        ) : (
          <>
            {selectMode && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 12,
                  padding: "10px 14px",
                  borderRadius: 12,
                  background: colors.bgCard,
                  border: `1px solid ${colors.border}`,
                }}
              >
                <span style={{ fontSize: 13, color: colors.textMuted }}>
                  Pick the test campaigns you want to delete for good.
                </span>
                <button
                  onClick={toggleSelectAll}
                  disabled={bulkDeleting}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    background: "transparent",
                    border: `1px solid ${colors.border}`,
                    color: colors.text,
                    fontWeight: 600,
                    fontSize: 12.5,
                    whiteSpace: "nowrap",
                    cursor: bulkDeleting ? "not-allowed" : "pointer",
                  }}
                >
                  {selectedRunIds.size === selectable.length
                    ? "Clear all"
                    : "Select all"}
                </button>
              </div>
            )}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                paddingBottom: selectMode ? 88 : 0,
              }}
            >
              {items.map((item) => {
                const s = statusFor(item);
                const resumeHref = item.runId
                  ? `${newHref}?run=${item.runId}`
                  : newHref;
                const canSelect = Boolean(item.runId);
                const isSelected = canSelect
                  ? selectedRunIds.has(item.runId as string)
                  : false;
                return (
                  <div
                    key={item.campaignId}
                    onClick={
                      selectMode && canSelect
                        ? () => toggleSelected(item.runId as string)
                        : undefined
                    }
                    style={{
                      background: isSelected
                        ? "rgba(248,113,113,0.08)"
                        : colors.bgCard,
                      border: `1px solid ${
                        isSelected ? "rgba(248,113,113,0.5)" : colors.border
                      }`,
                      borderRadius: 14,
                      padding: 18,
                      cursor:
                        selectMode && canSelect ? "pointer" : "default",
                      opacity: selectMode && !canSelect ? 0.5 : 1,
                    }}
                  >
                    {selectMode && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginBottom: 12,
                          fontSize: 13,
                          fontWeight: 600,
                          color: canSelect
                            ? isSelected
                              ? "#F87171"
                              : colors.textMuted
                            : colors.textFaint,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 18,
                            height: 18,
                            borderRadius: 5,
                            border: `1.5px solid ${
                              isSelected ? "#F87171" : colors.border
                            }`,
                            background: isSelected ? "#F87171" : "transparent",
                            color: "#000",
                            fontSize: 12,
                            lineHeight: 1,
                          }}
                        >
                          {isSelected ? "✓" : ""}
                        </span>
                        {canSelect
                          ? isSelected
                            ? "Selected to delete"
                            : "Tap to select"
                          : "Can't be deleted here"}
                      </div>
                    )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <h3
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          marginBottom: 4,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.displayName}
                      </h3>
                      <p style={{ fontSize: 12.5, color: colors.textFaint }}>
                        {formatDate(item.createdAt)}
                        {item.dailyBudgetCents != null
                          ? ` · ${CURRENCY}${(item.dailyBudgetCents / 100).toFixed(
                              2
                            )}/day`
                          : ""}
                      </p>
                    </div>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 11.5,
                        fontWeight: 600,
                        padding: "4px 10px",
                        borderRadius: 999,
                        color: s.color,
                        background: s.bg,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.label}
                    </span>
                  </div>

                  {item.landingPageUrl && (
                    <p
                      style={{
                        fontSize: 12.5,
                        color: colors.textMuted,
                        marginBottom: 14,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      🔗 {item.landingPageUrl}
                    </p>
                  )}

                  {!selectMode && (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Link
                      href={resumeHref}
                      style={{
                        padding: "8px 16px",
                        borderRadius: 9,
                        background: "transparent",
                        border: `1px solid ${colors.accent}`,
                        color: colors.accent,
                        fontWeight: 600,
                        fontSize: 13,
                        textDecoration: "none",
                      }}
                    >
                      {s.action}
                    </Link>
                    {item.deepLink && (
                      <a
                        href={item.deepLink}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          padding: "8px 16px",
                          borderRadius: 9,
                          background: "transparent",
                          border: `1px solid ${colors.border}`,
                          color: colors.text,
                          fontWeight: 600,
                          fontSize: 13,
                          textDecoration: "none",
                        }}
                      >
                        View in Google Ads ↗
                      </a>
                    )}
                    {item.runId && item.campaignStatus !== "active" && (
                      <button
                        onClick={() => discard(item.runId!)}
                        disabled={discardingId === item.runId}
                        style={{
                          marginLeft: "auto",
                          padding: "8px 12px",
                          borderRadius: 9,
                          background: "transparent",
                          border: "none",
                          color: colors.textFaint,
                          fontWeight: 600,
                          fontSize: 12.5,
                          textDecoration: "underline",
                          cursor:
                            discardingId === item.runId
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        {discardingId === item.runId
                          ? "Discarding…"
                          : "Discard"}
                      </button>
                    )}
                  </div>
                  )}
                  </div>
                );
              })}
            </div>
            {selectMode && (
              <div
                style={{
                  position: "fixed",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 40,
                  display: "flex",
                  justifyContent: "center",
                  padding: "12px 16px calc(12px + env(safe-area-inset-bottom))",
                  background: colors.bg,
                  borderTop: `1px solid ${colors.border}`,
                }}
              >
                <div
                  style={{
                    width: "100%",
                    maxWidth: 768,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 13.5, color: colors.textMuted }}>
                    {selectedRunIds.size === 0
                      ? "Nothing selected"
                      : `${selectedRunIds.size} selected`}
                  </span>
                  <button
                    onClick={bulkDelete}
                    disabled={bulkDeleting || selectedRunIds.size === 0}
                    style={{
                      padding: "10px 18px",
                      borderRadius: 10,
                      background:
                        bulkDeleting || selectedRunIds.size === 0
                          ? "rgba(248,113,113,0.25)"
                          : "#F87171",
                      border: "none",
                      color:
                        bulkDeleting || selectedRunIds.size === 0
                          ? colors.textFaint
                          : "#000",
                      fontWeight: 700,
                      fontSize: 13.5,
                      cursor:
                        bulkDeleting || selectedRunIds.size === 0
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {bulkDeleting
                      ? "Deleting…"
                      : `Delete ${selectedRunIds.size || ""} permanently`}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
