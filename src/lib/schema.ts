import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  date,
  bigint,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  googleCampaignId: bigint("google_campaign_id", { mode: "number" }),
  googleAdgroupId: bigint("google_adgroup_id", { mode: "number" }),
  googleAccountId: text("google_account_id"),
  status: text("status").default("draft").notNull(),
  budgetTier: text("budget_tier"),
  dailyBudgetCents: integer("daily_budget_cents"),
  landingPageUrl: text("landing_page_url"),
  brandName: text("brand_name"),
  brandWebsite: text("brand_website"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  userId: uuid("user_id").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  status: text("status").default("incomplete").notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const placements = pgTable("placements", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  url: text("url").notNull(),
  domain: text("domain").notNull(),
  citationCount: integer("citation_count").default(0),
  modelsCiting: text("models_citing").array(),
  gdnAvailable: boolean("gdn_available").default(true),
  googleCriterionId: bigint("google_criterion_id", { mode: "number" }),
  impressions: integer("impressions").default(0),
  clicks: integer("clicks").default(0),
  costCents: integer("cost_cents").default(0),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const performance = pgTable(
  "performance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .references(() => campaigns.id)
      .notNull(),
    date: date("date").notNull(),
    impressions: integer("impressions").default(0),
    clicks: integer("clicks").default(0),
    costCents: integer("cost_cents").default(0),
    ctr: numeric("ctr", { precision: 5, scale: 4 }).default("0"),
    avgCpcCents: integer("avg_cpc_cents").default(0),
    conversions: integer("conversions").default(0),
  },
  (table) => [
    uniqueIndex("perf_campaign_date_idx").on(table.campaignId, table.date),
  ]
);

export const bannerAssets = pgTable("banner_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  format: text("format").notNull(),
  r2Url: text("r2_url").notNull(),
  driveUrl: text("drive_url"),
  promptUsed: text("prompt_used"),
  template: text("template"),
  status: text("status").default("generated").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
