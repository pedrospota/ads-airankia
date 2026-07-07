# OSS Harvest Verdict — what we adopt, from where, and why

Date: 2026-07-07. All repos verified live against the GitHub API and read in full by
analysis agents (clones under session scratchpad `harvest/`). This document records
the decisions; the Centro de Mando plan was amended accordingly.

## Fit ranking (proven record × update cadence × license × fit to our goals)

| # | Repo | Stars/activity | License | Role for us |
|---|---|---|---|---|
| 1 | **coreyhaines31/marketingskills** | 36,960★ · pushed 2026-07-06 | MIT | **Copy**: the ads playbooks (TCPL kill/graduate/scale engine, fatigue bands, Google gates, RSA validator) — Copiloto grounding + gate constants |
| 2 | **AgriciDaniel/claude-ads** | 6,768★ · active | MIT | **Copy**: 130 Google+Meta check tables, scoring function (drop-in Python→TS), check-catalog.yaml, top-25 write-gating pre-flight |
| 3 | **nowork-studio/NotFair** | 3,079★ · active | MIT | **Copy**: safe-executor contract (post-write live read-back verification, approval template), meta-math/ppc-math, policy-registry pattern, eval harness |
| 4 | **mikusnuz/meta-ads-mcp** | 56★ · v25.0, 134 tools | MIT | **Adapt**: Meta write-op surface (creation hierarchy, audiences, block lists, rules), API pinning + gotchas |
| 5 | **FGRibreau/mcp-google-ads** | 8★ · pushed today | MIT | **Adopt patterns**: one-shot bypass, format validators, op allowlist, atomic partialFailure=false, next_action_hint |
| 6 | **attainmentlabs/meta-ads-mcp** | 3★ | MIT | **Adopt patterns**: fail-closed audit preflight, audit-on-failure, caps in lowest layer, integer minor units |
| 7 | **pipeboard-co/meta-ads-mcp** | 1,052★ · pushed 2026-07-05 | **BSL 1.1 — STUDY ONLY** | Facts only (error subcodes, API gotchas, PAUSED-default invariant). **No code/text copying** — non-compete Additional Use Grant; Apache-2.0 only from 2029-01-01 |
| — | irinabuht12-oss/google-meta-ads-ga4-mcp | 1,037★ but 46 forks, stale since April | MIT | **Skip** — star/fork ratio anomalous, 3 months stale; nothing it has that #4/#5 lack |
| — | amekala/ads-mcp, brijr/meta-mcp | 66★/188★ | **No license** | **Skip** — unlicensed, cannot copy |
| — | googleads/google-ads-mcp (official) | 718★ | Apache-2.0 | Read-only by design; not useful for the write rail |

## Validation of our architecture

The safety teardown found **our rail is ahead of every reference implementation**:
neither guardrail repo has drift detection (FGRibreau trusts caller-supplied
`current_bid` — spoofable), blast-radius/day limits, learning-phase awareness,
server-side validateOnly, or before/after snapshots + rollback recipes. Pipeboard's
advertised "confirmation on every write" lives in their closed hosted proxy, not the
OSS. Conclusion: keep our design; adopt their hygiene deltas below.

## Amendments folded into the implementation plan

1. **Meta API pin → `v25.0`** (was v23.0 default). Single constant; verify latest GA
   on Meta's changelog at ship time. Budgets to Meta as **integer cents in strings**;
   `special_ad_categories` always sent (default `[]`) on any future create ops.
2. **`appsecret_proof`** on every Meta call when `META_APP_SECRET` is set
   (HMAC-SHA256(app_secret, token)) — required practice for system-user tokens.
3. **New gate `ABS_BUDGET_CAP`** — absolute per-entity daily-budget ceiling
   (`cc_settings.max_daily_budget_micros`, null = disabled), enforced in the gate
   engine AND re-checked inside each adapter (defense in depth, per attainmentlabs).
4. **New gate `META_LEARNING_RESET`** (warning) — Meta budget delta >20% resets the
   learning phase (NotFair/marketingskills "significant edit" threshold); surfaced as
   evidence even when the delta gate passes.
5. **Fail-closed ledger**: the executor's pending-row insert already precedes any
   network call — codified as an invariant (if the ledger write fails, no mutation
   happens). Failed/blocked outcomes are persisted (`gate_results`, `failed` rows).
6. **Post-write live read-back** (NotFair safe-executor): our executor already
   re-snapshots `after`; rule added — never report success from the mutation
   response alone; the Bitácora shows verified state.
7. **New Task 15 — Knowledge pack**: copy the MIT playbooks into
   `docs/knowledge/ads/` with `ATTRIBUTION.md` (MIT notices for marketingskills,
   claude-ads, NotFair + lineage footers), and distill the numeric thresholds into
   `src/lib/command/knowledge.ts` (constants powering `source='regla'` suggestions
   and future gate tuning: TCPL multiples, +20%/5d scaling, 3× kill rule, frequency
   bands, Google 30-conv smart-bidding floor, budget-step caps, learning "50 in 7").
8. **Roadmap (v1.5+, not v1)**: Meta write expansion in mikusnuz priority order —
   ad-level status → creation hierarchy (PAUSED default, ODAX objectives) →
   targeting replace → image upload + simple creatives → custom/lookalike audiences →
   publisher block lists (Meta's "negatives") → budget schedules → automated rules →
   CAPI events. Google: adopt FGRibreau format-validator gate class + op denylist
   when we add RSA/creation ops.

## Attribution obligations

Any copied file keeps its MIT copyright + permission notice. `ATTRIBUTION.md` will
credit: coreyhaines31/marketingskills (MIT © 2025 Corey Haines; lineage: Ivan
Falco's ads-skills), AgriciDaniel/claude-ads (MIT © 2026 agricidaniel),
nowork-studio/NotFair (MIT © 2026 Toprank Contributors), mikusnuz/meta-ads-mcp
(MIT © 2025 mikusnuz). Numeric thresholds are facts (not copyrightable) — kept with
courtesy source comments. Nothing from pipeboard (BSL) or unlicensed repos.
