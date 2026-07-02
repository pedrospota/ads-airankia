"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { useTheme } from "@/components/theme-provider";
import {
  Card,
  Badge,
  DataTable,
  THead,
  Row,
  Cell,
  EmptyState,
  PrimaryButton,
  SecondaryButton,
  GhostDangerButton,
} from "@/components/ui-kit";

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
  tone: "ok" | "warn" | "danger" | "muted";
  /** What the main button says for this state. */
  action: string;
}

// Friendly, plain-Spanish status derived from the campaign + run state.
function statusFor(item: CampaignListItem): StatusInfo {
  const inGoogle = item.googleCampaignId != null;
  if (inGoogle && item.campaignStatus === "active") {
    return { label: "Active", tone: "ok", action: "View details" };
  }
  if (inGoogle) {
    // Created in Google but not enabled (paused / draft row).
    return { label: "Created · paused", tone: "warn", action: "View and turn on" };
  }
  // Not in Google yet → still being built or unfinished.
  if (item.runStatus === "running" || item.runStatus === "queued") {
    return { label: "Being created…", tone: "muted", action: "Continue" };
  }
  if (item.runStatus === "awaiting_approval") {
    return { label: "Waiting for your review", tone: "muted", action: "Review" };
  }
  if (item.runStatus === "failed" || item.runStatus === "aborted") {
    return { label: "Unfinished", tone: "danger", action: "Resume" };
  }
  // Completed-but-not-activated, or a fresh draft.
  return { label: "Ready to turn on", tone: "warn", action: "Review and turn on" };
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

  // Theme-aware button overrides: primary is "ink on paper" (white in dark,
  // near-black in light — the quiet, premium move); secondary follows the
  // theme border/text so both themes stay coherent.
  const primaryStyle: React.CSSProperties = {
    background: colors.text,
    color: colors.bg,
    border: `1px solid ${colors.text}`,
  };
  const secondaryStyle: React.CSSProperties = {
    background: "transparent",
    color: colors.text,
    border: `1px solid ${colors.border}`,
  };
  const smallBtn: React.CSSProperties = { padding: "5px 10px", fontSize: 12.5 };
  const cardTheme: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
  };

  // The two ways to create a campaign, shown as prominent cards at the top of
  // the hub. Search is the flagship (most autonomous) so it goes first.
  const createOptions = [
    {
      href: newHref,
      title: "Search campaign",
      desc: "Your ad shows up when someone searches Google for what you offer. The AI builds it; you just review and turn it on.",
      recommended: true,
    },
    {
      href: `/brands/${brandId}/campaigns/new/display`,
      title: "Display — retargeting de citas (banners IA)",
      desc: "Detectamos dónde te citan las IAs y creamos banners con tu marca para aparecer exactamente en esos sitios, blogs y apps.",
      recommended: false,
    },
  ];

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

  const baseCols = [
    { label: "Campaign" },
    { label: "Status", width: 170 },
    { label: "Budget/day", align: "right" as const, width: 110 },
    { label: "Created", width: 130 },
    { label: "", align: "right" as const },
  ];
  const cols = selectMode ? [{ label: "", width: 44 }, ...baseCols] : baseCols;

  return (
    <div>
      <Header
        breadcrumbs={[
          { label: "Brands", href: "/brands" },
          { label: brandName, href: `/brands/${brandId}/citations` },
          { label: "Campaigns" },
        ]}
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* The citation-intelligence feature keeps its own front door: see WHERE
                the AIs cite you (feeds the Display retargeting + AI banners flow). */}
            <SecondaryButton
              href={`/brands/${brandId}/citations`}
              style={secondaryStyle}
            >
              Citas de IA
            </SecondaryButton>
            <SecondaryButton
              href={`/brands/${brandId}/benchmark`}
              style={secondaryStyle}
            >
              Benchmark
            </SecondaryButton>
            {selectable.length > 0 &&
              (selectMode ? (
                <SecondaryButton
                  onClick={exitSelectMode}
                  disabled={bulkDeleting}
                  style={secondaryStyle}
                >
                  Done
                </SecondaryButton>
              ) : (
                <SecondaryButton
                  onClick={() => setSelectMode(true)}
                  style={{ ...secondaryStyle, color: colors.textMuted }}
                >
                  Select to clean up
                </SecondaryButton>
              ))}
            <SecondaryButton
              href={`/brands/${brandId}/benchmark`}
              style={secondaryStyle}
            >
              Spy on competitors
            </SecondaryButton>
            <PrimaryButton href={newHref} style={primaryStyle}>
              New campaign
            </PrimaryButton>
          </div>
        }
      />

      <main style={{ marginTop: 24 }}>
        {/* Create-a-campaign hub: the two creators (Search and Display) as
            clear siblings. This replaces the old /campaigns/new/choose
            pre-screen — same two options, now always visible. */}
        <section style={{ marginBottom: 32 }}>
          <h1
            style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              lineHeight: 1.25,
              color: colors.text,
              margin: 0,
            }}
          >
            Create a campaign
          </h1>
          <p style={{ fontSize: 13.5, color: colors.textMuted, margin: "6px 0 20px" }}>
            Choose how you want to advertise {brandName}.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 16,
            }}
          >
            {createOptions.map((o) => (
              <Card key={o.href} style={cardTheme}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h2
                    style={{
                      fontSize: 15,
                      fontWeight: 550,
                      color: colors.text,
                      margin: 0,
                    }}
                  >
                    {o.title}
                  </h2>
                  {o.recommended && <Badge tone="accent">Recomendada</Badge>}
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: colors.textMuted,
                    margin: "8px 0 0",
                    lineHeight: 1.55,
                  }}
                >
                  {o.desc}
                </p>
                <div style={{ marginTop: 16 }}>
                  {o.recommended ? (
                    <PrimaryButton href={o.href} style={primaryStyle}>
                      Crear
                    </PrimaryButton>
                  ) : (
                    <SecondaryButton href={o.href} style={secondaryStyle}>
                      Crear
                    </SecondaryButton>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </section>

        <div style={{ marginBottom: 16 }}>
          <h2
            style={{
              fontSize: 11,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: colors.textMuted,
              margin: 0,
            }}
          >
            Your Search campaigns
          </h2>
          <p style={{ fontSize: 13, color: colors.textMuted, margin: "8px 0 0", maxWidth: 620 }}>
            Here you can see all your campaigns and where each one stands. You
            can come back anytime to review them, turn them on, or pick up one
            you left halfway.
          </p>
        </div>

        {items.length === 0 ? (
          <Card style={{ ...cardTheme, padding: 0 }}>
            <EmptyState
              title="You don't have any campaigns yet"
              hint="Create your first campaign in just a few minutes. We take care of everything and leave it paused so you decide when to start."
              action={
                <PrimaryButton href={newHref} style={primaryStyle}>
                  Create my first campaign
                </PrimaryButton>
              }
            />
          </Card>
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
                  ...cardTheme,
                }}
              >
                <span style={{ fontSize: 13, color: colors.textMuted }}>
                  Pick the test campaigns you want to delete for good.
                </span>
                <SecondaryButton
                  onClick={toggleSelectAll}
                  disabled={bulkDeleting}
                  style={{ ...secondaryStyle, ...smallBtn }}
                >
                  {selectedRunIds.size === selectable.length
                    ? "Clear all"
                    : "Select all"}
                </SecondaryButton>
              </div>
            )}

            <div style={{ paddingBottom: selectMode ? 88 : 0 }}>
              <Card style={{ ...cardTheme, padding: 0 }}>
                {/* Theme-aware row hover (overrides the kit's dark default). */}
                <style>{`.uik-row:hover td{background:${colors.hover} !important;}`}</style>
                <DataTable>
                  <THead cols={cols} />
                  <tbody>
                    {items.map((item) => {
                      const s = statusFor(item);
                      const resumeHref = item.runId
                        ? `${newHref}?run=${item.runId}`
                        : newHref;
                      const canSelect = Boolean(item.runId);
                      const isSelected = canSelect
                        ? selectedRunIds.has(item.runId as string)
                        : false;
                      const cellTheme: React.CSSProperties = {
                        color: colors.text,
                        borderBottom: `1px solid ${colors.border}`,
                      };
                      return (
                        <Row key={item.campaignId}>
                          {selectMode && (
                            <Cell style={cellTheme}>
                              <button
                                type="button"
                                aria-label={
                                  canSelect
                                    ? isSelected
                                      ? "Selected to delete"
                                      : "Select to delete"
                                    : "Can't be deleted here"
                                }
                                aria-pressed={isSelected}
                                disabled={!canSelect || bulkDeleting}
                                onClick={() =>
                                  canSelect && toggleSelected(item.runId as string)
                                }
                                title={
                                  canSelect
                                    ? isSelected
                                      ? "Selected to delete"
                                      : "Select to delete"
                                    : "Can't be deleted here"
                                }
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: 18,
                                  height: 18,
                                  borderRadius: 5,
                                  border: `1.5px solid ${
                                    isSelected ? colors.danger : colors.border
                                  }`,
                                  background: isSelected
                                    ? colors.danger
                                    : "transparent",
                                  color: "#FFFFFF",
                                  fontSize: 12,
                                  lineHeight: 1,
                                  cursor: canSelect ? "pointer" : "not-allowed",
                                  opacity: canSelect ? 1 : 0.4,
                                  padding: 0,
                                }}
                              >
                                {isSelected ? "✓" : ""}
                              </button>
                            </Cell>
                          )}
                          <Cell style={cellTheme}>
                            <div
                              style={{
                                fontWeight: 500,
                                maxWidth: 320,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {item.displayName}
                            </div>
                            {item.landingPageUrl && (
                              <div
                                style={{
                                  fontSize: 12,
                                  color: colors.textFaint,
                                  marginTop: 2,
                                  maxWidth: 320,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.landingPageUrl}
                              </div>
                            )}
                          </Cell>
                          <Cell style={cellTheme}>
                            <Badge tone={s.tone}>{s.label}</Badge>
                          </Cell>
                          <Cell align="right" mono style={cellTheme}>
                            {item.dailyBudgetCents != null
                              ? `${CURRENCY}${(item.dailyBudgetCents / 100).toFixed(2)}`
                              : "—"}
                          </Cell>
                          <Cell
                            style={{
                              ...cellTheme,
                              color: colors.textMuted,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {formatDate(item.createdAt) || "—"}
                          </Cell>
                          <Cell align="right" style={cellTheme}>
                            {!selectMode && (
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "flex-end",
                                  gap: 8,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.runId && item.campaignStatus !== "active" && (
                                  <GhostDangerButton
                                    onClick={() => discard(item.runId!)}
                                    disabled={discardingId === item.runId}
                                    style={{ ...smallBtn, color: colors.danger }}
                                  >
                                    {discardingId === item.runId
                                      ? "Discarding…"
                                      : "Discard"}
                                  </GhostDangerButton>
                                )}
                                {item.deepLink && (
                                  <SecondaryButton
                                    href={item.deepLink}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ ...secondaryStyle, ...smallBtn }}
                                  >
                                    Google Ads ↗
                                  </SecondaryButton>
                                )}
                                <SecondaryButton
                                  href={resumeHref}
                                  style={{ ...secondaryStyle, ...smallBtn }}
                                >
                                  {s.action}
                                </SecondaryButton>
                              </div>
                            )}
                          </Cell>
                        </Row>
                      );
                    })}
                  </tbody>
                </DataTable>
              </Card>
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
                    maxWidth: 1150,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13.5,
                      color: colors.textMuted,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {selectedRunIds.size === 0
                      ? "Nothing selected"
                      : `${selectedRunIds.size} selected`}
                  </span>
                  <button
                    type="button"
                    onClick={bulkDelete}
                    disabled={bulkDeleting || selectedRunIds.size === 0}
                    style={{
                      padding: "8px 14px",
                      borderRadius: 8,
                      background: colors.danger,
                      border: `1px solid ${colors.danger}`,
                      color: "#FFFFFF",
                      fontWeight: 550,
                      fontSize: 13,
                      lineHeight: "16px",
                      opacity: bulkDeleting || selectedRunIds.size === 0 ? 0.5 : 1,
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
