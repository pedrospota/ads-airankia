CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  google_campaign_id BIGINT,
  google_adgroup_id BIGINT,
  google_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  budget_tier TEXT,
  daily_budget_cents INT,
  landing_page_url TEXT,
  brand_name TEXT,
  brand_website TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id),
  user_id UUID NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  status TEXT NOT NULL DEFAULT 'incomplete',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE placements (
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

CREATE TABLE performance (
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

CREATE TABLE banner_assets (
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

CREATE INDEX idx_campaigns_brand ON campaigns(brand_id);
CREATE INDEX idx_campaigns_workspace ON campaigns(workspace_id);
CREATE INDEX idx_placements_campaign ON placements(campaign_id);
CREATE INDEX idx_performance_campaign_date ON performance(campaign_id, date);
CREATE INDEX idx_banner_campaign ON banner_assets(campaign_id);
