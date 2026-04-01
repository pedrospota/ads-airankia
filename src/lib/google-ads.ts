// Direct Google Ads REST API client — no MCP dependency

const CUSTOMER_ID = process.env.GOOGLE_ADS_ACCOUNT_ID || "3531706003";
const MCC_ID = process.env.GOOGLE_ADS_MCC_ID || "9539861409";
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET!;
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN!;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN!;

let cachedAccessToken: { token: string; expires: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expires) {
    return cachedAccessToken.token;
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) throw new Error(`OAuth token refresh failed: ${resp.status}`);
  const data = await resp.json();

  cachedAccessToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

function headers(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "developer-token": DEVELOPER_TOKEN,
    "login-customer-id": MCC_ID,
    "Content-Type": "application/json",
  };
}

const BASE = `https://googleads.googleapis.com/v19/customers/${CUSTOMER_ID}`;

// Create a campaign budget
export async function createBudget(name: string, dailyAmountMicros: number): Promise<string> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaignBudgets:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        create: {
          name,
          amountMicros: String(Math.max(dailyAmountMicros, 1000000)), // min $1
          deliveryMethod: "STANDARD",
        },
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.results[0].resourceName; // customers/XXX/campaignBudgets/YYY
}

// Create a Display campaign (always PAUSED)
export async function createCampaign(name: string, budgetResourceName: string): Promise<{ resourceName: string; id: string }> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaigns:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        create: {
          name,
          status: "PAUSED",
          advertisingChannelType: "DISPLAY",
          campaignBudget: budgetResourceName,
          manualCpc: {},
          networkSettings: {
            targetContentNetwork: true,
            targetGoogleSearch: false,
            targetSearchNetwork: false,
          },
        },
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  const rn = data.results[0].resourceName;
  const id = rn.split("/").pop()!;
  return { resourceName: rn, id };
}

// Create a DISPLAY_STANDARD ad group
export async function createAdGroup(campaignId: string, name: string): Promise<{ resourceName: string; id: string }> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/adGroups:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        create: {
          name,
          campaign: `customers/${CUSTOMER_ID}/campaigns/${campaignId}`,
          type: "DISPLAY_STANDARD",
          status: "ENABLED",
          cpcBidMicros: "100000", // $0.10 default CPC
        },
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  const rn = data.results[0].resourceName;
  const id = rn.split("/").pop()!;
  return { resourceName: rn, id };
}

// Add managed placements (domains) to an ad group
export async function addPlacements(adGroupId: string, domains: string[]): Promise<{ success: string[]; failed: string[] }> {
  const token = await getAccessToken();
  const uniqueDomains = [...new Set(domains)];
  const success: string[] = [];
  const failed: string[] = [];

  // Batch in groups of 10 to avoid API limits
  for (let i = 0; i < uniqueDomains.length; i += 10) {
    const batch = uniqueDomains.slice(i, i + 10);
    const operations = batch.map((url) => ({
      create: {
        adGroup: `customers/${CUSTOMER_ID}/adGroups/${adGroupId}`,
        status: "ENABLED",
        placement: { url },
      },
    }));

    try {
      const resp = await fetch(`${BASE}/adGroupCriteria:mutate`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          operations,
          partialFailure: true,
        }),
      });

      const data = await resp.json();
      if (data.error) {
        failed.push(...batch);
      } else {
        // Check partial failures
        if (data.partialFailureError) {
          // Some succeeded, some failed
          batch.forEach((d, idx) => {
            const result = data.results?.[idx];
            if (result?.resourceName) success.push(d);
            else failed.push(d);
          });
        } else {
          success.push(...batch);
        }
      }
    } catch {
      failed.push(...batch);
    }
  }

  return { success, failed };
}

// Pause or enable a campaign
export async function setCampaignStatus(campaignId: string, status: "PAUSED" | "ENABLED"): Promise<void> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaigns:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${CUSTOMER_ID}/campaigns/${campaignId}`,
          status,
        },
        updateMask: "status",
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
}

// Update daily budget
export async function updateBudget(budgetId: string, dailyAmountMicros: number): Promise<void> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/campaignBudgets:mutate`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${CUSTOMER_ID}/campaignBudgets/${budgetId}`,
          amountMicros: String(Math.max(dailyAmountMicros, 1000000)),
        },
        updateMask: "amountMicros",
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
}

// Get campaign performance
export async function getCampaignPerformance(campaignId: string): Promise<{
  impressions: number; clicks: number; costMicros: number; status: string;
}> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE}/googleAds:searchStream`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      query: `SELECT campaign.id, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE campaign.id = ${campaignId}`,
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  const row = data[0]?.results?.[0];
  return {
    impressions: Number(row?.metrics?.impressions || 0),
    clicks: Number(row?.metrics?.clicks || 0),
    costMicros: Number(row?.metrics?.costMicros || 0),
    status: row?.campaign?.status || "UNKNOWN",
  };
}
