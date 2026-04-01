-- Topup wallet (prepaid credit like Google Ads)
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  balance_cents INT NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id) NOT NULL,
  type TEXT NOT NULL, -- topup | spend | refund
  amount_cents INT NOT NULL,
  description TEXT,
  stripe_payment_intent_id TEXT,
  campaign_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Campaigns (updated: removed subscription tiers, added total budget + spent)
CREATE TABLE IF NOT EXISTS campaigns (
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
);

CREATE TABLE IF NOT EXISTS placements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id),
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
);

CREATE TABLE IF NOT EXISTS performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) NOT NULL,
  date DATE NOT NULL,
  impressions INT DEFAULT 0,
  clicks INT DEFAULT 0,
  cost_cents INT DEFAULT 0,
  ctr NUMERIC(5,4) DEFAULT 0,
  avg_cpc_cents INT DEFAULT 0,
  conversions INT DEFAULT 0,
  UNIQUE(campaign_id, date)
);

CREATE TABLE IF NOT EXISTS banner_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id),
  format TEXT NOT NULL,
  r2_url TEXT NOT NULL,
  drive_url TEXT,
  prompt_used TEXT,
  template TEXT,
  status TEXT NOT NULL DEFAULT 'generated',
  width INT,
  height INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_brand ON campaigns(brand_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_workspace ON campaigns(workspace_id);
CREATE INDEX IF NOT EXISTS idx_placements_campaign ON placements(campaign_id);
CREATE INDEX IF NOT EXISTS idx_performance_campaign_date ON performance(campaign_id, date);
CREATE INDEX IF NOT EXISTS idx_banner_campaign ON banner_assets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);
