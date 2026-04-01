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
