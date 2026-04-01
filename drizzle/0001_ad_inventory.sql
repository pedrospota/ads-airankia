CREATE TABLE ad_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  has_gdn BOOLEAN DEFAULT false,
  gdn_pub_id TEXT,
  networks TEXT[],
  detection_method TEXT,
  checked_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX ad_inventory_domain_idx ON ad_inventory(domain);
