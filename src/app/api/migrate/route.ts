import { NextResponse } from "next/server";
import { adsDb } from "@/lib/ads-db";
import { sql } from "drizzle-orm";

export async function POST() {
  const migrations = [
    // wallets
    sql`CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      workspace_id UUID NOT NULL,
      balance_cents INT NOT NULL DEFAULT 0,
      stripe_customer_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    // transactions
    sql`CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL,
      type TEXT NOT NULL,
      amount_cents INT NOT NULL,
      description TEXT,
      stripe_payment_intent_id TEXT,
      campaign_id UUID,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // campaigns
    sql`CREATE TABLE IF NOT EXISTS campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id UUID NOT NULL,
      workspace_id UUID NOT NULL,
      user_id UUID NOT NULL,
      google_campaign_id BIGINT,
      google_adgroup_id BIGINT,
      google_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      daily_budget_cents INT,
      total_budget_cents INT,
      spent_cents INT DEFAULT 0,
      landing_page_url TEXT,
      brand_name TEXT,
      brand_website TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    // placements
    sql`CREATE TABLE IF NOT EXISTS placements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      citation_count INT DEFAULT 0,
      models_citing TEXT[],
      gdn_available BOOLEAN DEFAULT true,
      google_criterion_id BIGINT,
      impressions INT DEFAULT 0,
      clicks INT DEFAULT 0,
      cost_cents INT DEFAULT 0,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // performance
    sql`CREATE TABLE IF NOT EXISTS performance (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL,
      date DATE NOT NULL,
      impressions INT DEFAULT 0,
      clicks INT DEFAULT 0,
      cost_cents INT DEFAULT 0,
      ctr NUMERIC(5,4) DEFAULT 0,
      avg_cpc_cents INT DEFAULT 0,
      conversions INT DEFAULT 0,
      UNIQUE(campaign_id, date)
    )`,
    // banner_assets
    sql`CREATE TABLE IF NOT EXISTS banner_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID,
      format TEXT NOT NULL,
      r2_url TEXT NOT NULL,
      drive_url TEXT,
      prompt_used TEXT,
      template TEXT,
      status TEXT NOT NULL DEFAULT 'generated',
      width INT,
      height INT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // ad_inventory
    sql`CREATE TABLE IF NOT EXISTS ad_inventory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      domain TEXT NOT NULL,
      has_gdn BOOLEAN DEFAULT false,
      gdn_pub_id TEXT,
      networks TEXT[],
      detection_method TEXT,
      checked_at TIMESTAMPTZ DEFAULT now()
    )`,
    // indexes
    sql`CREATE UNIQUE INDEX IF NOT EXISTS ad_inventory_domain_idx ON ad_inventory(domain)`,
    sql`CREATE INDEX IF NOT EXISTS idx_campaigns_brand ON campaigns(brand_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_campaigns_workspace ON campaigns(workspace_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_placements_campaign ON placements(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_performance_campaign_date ON performance(campaign_id, date)`,
    sql`CREATE INDEX IF NOT EXISTS idx_banner_campaign ON banner_assets(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id)`,

    // ========================================================================
    // SEARCH CAMPAIGN ENGINE — additive migration (Fase 1, task 1)
    // All ALTER ... ADD COLUMN IF NOT EXISTS + CREATE TABLE IF NOT EXISTS.
    // Existing Display rows backfill to campaign_type='display' via the DEFAULT.
    // ========================================================================

    // version ledger
    sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- campaigns: new search columns (additive, Display untouched) ---
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'display'`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS bidding_strategy TEXT`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_cpa_micros BIGINT`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_roas NUMERIC(10,4)`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS conversion_action_resource_name TEXT`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS billing_verified_at TIMESTAMPTZ`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS account_currency TEXT`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS account_timezone TEXT`,
    sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS active_plan_id UUID`,
    // belt-and-suspenders backfill if the column pre-existed nullable
    sql`UPDATE campaigns SET campaign_type = 'display' WHERE campaign_type IS NULL`,

    // --- performance: conversion-value columns ---
    sql`ALTER TABLE performance ADD COLUMN IF NOT EXISTS conversions_value_micros BIGINT DEFAULT 0`,
    sql`ALTER TABLE performance ADD COLUMN IF NOT EXISTS all_conversions NUMERIC(12,2) DEFAULT 0`,
    sql`ALTER TABLE performance ADD COLUMN IF NOT EXISTS cost_per_conv_micros BIGINT DEFAULT 0`,

    // --- agentic run substrate ---
    sql`CREATE TABLE IF NOT EXISTS agent_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID,
      brand_id UUID NOT NULL,
      workspace_id UUID NOT NULL,
      user_id UUID NOT NULL,
      flow TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'search',
      mode TEXT NOT NULL,
      auto_advance BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'queued',
      credential_scope JSONB,
      current_step_id UUID,
      cost_micros_llm BIGINT NOT NULL DEFAULT 0,
      error TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS agent_steps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL,
      parent_step_id UUID,
      agent TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NOT_STARTED',
      idempotency_key TEXT,
      input JSONB,
      output JSONB,
      user_override JSONB,
      rationale TEXT,
      model TEXT,
      prompt_version TEXT,
      tokens_in INT DEFAULT 0,
      tokens_out INT DEFAULT 0,
      cost_micros_llm BIGINT DEFAULT 0,
      attempt INT DEFAULT 0,
      max_loops INT DEFAULT 3,
      locked_by TEXT,
      lease_expires_at TIMESTAMPTZ,
      error TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS agent_events (
      seq BIGSERIAL PRIMARY KEY,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL,
      step_id UUID,
      type TEXT NOT NULL,
      data JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS campaign_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID,
      run_id UUID,
      version INT NOT NULL DEFAULT 1,
      plan JSONB NOT NULL,
      archetype_mix JSONB,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- campaign structure ---
    sql`CREATE TABLE IF NOT EXISTS ad_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL,
      google_adgroup_id BIGINT,
      name TEXT NOT NULL,
      theme TEXT,
      archetype TEXT,
      match_type_policy TEXT,
      default_cpc_micros BIGINT,
      cohesion NUMERIC(5,4),
      landing_page_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS keywords (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ad_group_id UUID,
      campaign_id UUID,
      text TEXT NOT NULL,
      match_type TEXT NOT NULL,
      bid_micros BIGINT,
      google_criterion_id BIGINT,
      avg_monthly_searches BIGINT,
      competition TEXT,
      top_of_page_bid_micros BIGINT,
      low_top_of_page_bid_micros BIGINT,
      intent TEXT,
      relevance_score NUMERIC(5,4),
      score NUMERIC(7,4),
      source TEXT,
      source_run_id UUID,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS negative_keywords (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID,
      ad_group_id UUID,
      shared_set_resource_name TEXT,
      text TEXT NOT NULL,
      match_type TEXT NOT NULL,
      negative_class TEXT,
      scope TEXT NOT NULL DEFAULT 'campaign',
      google_criterion_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS search_ads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ad_group_id UUID NOT NULL,
      campaign_id UUID,
      headlines JSONB NOT NULL,
      descriptions JSONB NOT NULL,
      final_urls TEXT[],
      path1 TEXT,
      path2 TEXT,
      ad_strength TEXT,
      google_ad_id BIGINT,
      is_control BOOLEAN DEFAULT false,
      policy_approval_status TEXT,
      policy_topics JSONB,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS rsa_variants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ad_group_id UUID NOT NULL,
      search_ad_id UUID,
      variant_label TEXT,
      headlines JSONB,
      descriptions JSONB,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- assets / extensions ---
    sql`CREATE TABLE IF NOT EXISTS campaign_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL,
      asset_type TEXT NOT NULL,
      data JSONB NOT NULL,
      google_asset_resource_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS asset_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      asset_id UUID NOT NULL,
      level TEXT NOT NULL,
      campaign_id UUID,
      ad_group_id UUID,
      google_asset_link_resource_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- landing page analysis ---
    sql`CREATE TABLE IF NOT EXISTS lp_analysis (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ad_group_id UUID,
      campaign_id UUID,
      url TEXT NOT NULL,
      message_match_score NUMERIC(5,4),
      mobile_ok BOOLEAN,
      http_status INT,
      speed_ms INT,
      fixes JSONB,
      applied BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- conversion tracking (account-level mirror) ---
    sql`CREATE TABLE IF NOT EXISTS conversion_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      google_account_id TEXT,
      campaign_id UUID,
      resource_name TEXT NOT NULL,
      google_id BIGINT,
      name TEXT,
      category TEXT,
      type TEXT,
      status TEXT,
      include_in_conversions BOOLEAN,
      primary_for_goal BOOLEAN,
      counting_type TEXT,
      attribution_model TEXT,
      value_micros BIGINT,
      is_paid_scoped BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- bidding ladder audit ---
    sql`CREATE TABLE IF NOT EXISTS bidding_ladder_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL,
      from_rung TEXT,
      to_rung TEXT,
      from_strategy TEXT,
      to_strategy TEXT,
      trigger_metric TEXT,
      trigger_value TEXT,
      conv_30d NUMERIC(12,2),
      decided_by TEXT,
      rationale TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- keyword research provenance ---
    sql`CREATE TABLE IF NOT EXISTS keyword_research_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID,
      run_id UUID,
      seeds JSONB,
      sources JSONB,
      rounds INT DEFAULT 0,
      total_ideas INT DEFAULT 0,
      kept INT DEFAULT 0,
      raw JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- google mutations ledger ---
    sql`CREATE TABLE IF NOT EXISTS google_mutations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID,
      campaign_id UUID,
      operation TEXT NOT NULL,
      temp_id TEXT,
      resource_name TEXT,
      run_label TEXT,
      request_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      response JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,

    // --- indexes for the new tables ---
    sql`CREATE INDEX IF NOT EXISTS idx_agent_runs_campaign ON agent_runs(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)`,
    sql`CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_agent_steps_claim ON agent_steps(status, lease_expires_at)`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_steps_idempotency_idx ON agent_steps(run_id, idempotency_key)`,
    sql`CREATE INDEX IF NOT EXISTS idx_agent_events_run_seq ON agent_events(run_id, seq)`,
    sql`CREATE INDEX IF NOT EXISTS idx_campaign_plans_campaign ON campaign_plans(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_ad_groups_campaign ON ad_groups(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_keywords_ad_group ON keywords(ad_group_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_keywords_campaign ON keywords(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_neg_keywords_campaign ON negative_keywords(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_neg_keywords_ad_group ON negative_keywords(ad_group_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_search_ads_ad_group ON search_ads(ad_group_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_rsa_variants_ad_group ON rsa_variants(ad_group_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_campaign_assets_campaign ON campaign_assets(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_asset_links_asset ON asset_links(asset_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_lp_analysis_ad_group ON lp_analysis(ad_group_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_conversion_actions_account ON conversion_actions(google_account_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_bidding_ladder_campaign ON bidding_ladder_events(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_kw_research_runs_campaign ON keyword_research_runs(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_google_mutations_run ON google_mutations(run_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_google_mutations_campaign ON google_mutations(campaign_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_google_mutations_resource ON google_mutations(resource_name)`,

    // record the migration version
    sql`INSERT INTO schema_migrations (version) VALUES ('002_search_engine') ON CONFLICT (version) DO NOTHING`,

    // ========================================================================
    // APP SETTINGS — LLM provider/model config + secrets (additive, Fase 2)
    // key/value store. value is JSON. Secrets here are never sent to the client.
    // ========================================================================
    sql`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    sql`INSERT INTO schema_migrations (version) VALUES ('003_app_settings') ON CONFLICT (version) DO NOTHING`,
  ];

  const results = [];
  for (const m of migrations) {
    try {
      await adsDb.execute(m);
      results.push("OK");
    } catch (e) {
      results.push(`ERR: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  return NextResponse.json({ results });
}
