/**
 * Google Ads connections helper — OAuth, token crypto and account discovery.
 *
 * ⚠️ SERVER-ONLY. This module reads GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET /
 * GOOGLE_ADS_DEVELOPER_TOKEN / CONNECTIONS_KEY and handles refresh tokens in
 * plaintext in memory. NEVER import it from a client component ("use client") —
 * secrets must never reach the browser. Only use it from route handlers,
 * server components or server actions.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Google Ads API version. Google sunsets versions ~yearly (v19 and earlier now
// return 404; v21 is the current stable — see src/lib/google-ads.ts). Override
// via env when Google rotates again.
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v21";

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Public base URL of this app (no trailing slash). */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://ads.airankia.com").replace(/\/+$/, "");
}

/**
 * OAuth redirect URI. ⚠️ This EXACT URI must be registered as an authorized
 * redirect URI on the OAuth client (GOOGLE_ADS_CLIENT_ID) in its GCP console:
 *   https://ads.airankia.com/api/connections/callback
 */
export function oauthRedirectUri(): string {
  return `${appBaseUrl()}/api/connections/callback`;
}

// ---------------------------------------------------------------------------
// AES-256-GCM secret storage (refresh tokens at rest).
// Stored format: "ivHex:tagHex:cipherHex".
// ---------------------------------------------------------------------------

function encryptionKey(): Buffer {
  const hex = process.env.CONNECTIONS_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error(
      "CONNECTIONS_KEY no está configurada (se esperan 64 caracteres hex = clave AES-256)."
    );
  }
  return Buffer.from(hex.trim(), "hex");
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const parts = (stored ?? "").split(":");
  if (parts.length !== 3) {
    throw new Error("Secreto almacenado con formato inválido (se esperaba iv:tag:cipher).");
  }
  const [ivHex, tagHex, cipherHex] = parts;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// OAuth (authorization-code flow with offline access)
// ---------------------------------------------------------------------------

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

function clientId(): string {
  const id = process.env.GOOGLE_ADS_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_ADS_CLIENT_ID no está configurado en el servidor.");
  return id;
}

function clientSecret(): string {
  const secret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_ADS_CLIENT_SECRET no está configurado en el servidor.");
  return secret;
}

/** Google consent-screen URL. `state` is echoed back on the callback (CSRF). */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: oauthRedirectUri(),
    response_type: "code",
    // adwords for the Ads API + openid/email so the id_token tells us WHICH
    // Google account was connected.
    scope: `${GOOGLE_ADS_SCOPE} openid email`,
    access_type: "offline",
    prompt: "consent", // always re-issue a refresh_token
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Node's fetch has no default timeout — bound every Google call so a slow
// dependency fails fast instead of hanging the route handler.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Decode the payload of a JWT (id_token) WITHOUT verifying the signature.
 *  Safe here: the token comes straight from Google's token endpoint over TLS. */
function decodeJwtPayload(idToken: string): Record<string, unknown> | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface ExchangedCode {
  refreshToken: string;
  /** Google account email that granted access (from the id_token), if present. */
  email: string | null;
  scopes: string | null;
}

/** Exchange the authorization code for a refresh token + connected email. */
export async function exchangeCode(code: string): Promise<ExchangedCode> {
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: oauthRedirectUri(),
      grant_type: "authorization_code",
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok) {
    throw new Error(
      `Google rechazó el código de autorización (${res.status}): ${data.error_description || data.error || "error desconocido"}`
    );
  }
  if (!data.refresh_token) {
    // Happens if the consent screen skipped offline access (shouldn't with
    // prompt=consent, but be explicit).
    throw new Error(
      "Google no devolvió un refresh token. Revoca el acceso de la app en tu cuenta de Google y vuelve a intentarlo."
    );
  }

  let email: string | null = null;
  if (data.id_token) {
    const payload = decodeJwtPayload(data.id_token);
    if (payload && typeof payload.email === "string") email = payload.email;
  }

  return {
    refreshToken: data.refresh_token,
    email,
    scopes: typeof data.scope === "string" ? data.scope : null,
  };
}

/** Mint a short-lived access token from a refresh token. */
export async function mintAccessToken(refreshToken: string): Promise<string> {
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `No se pudo refrescar el acceso a Google Ads (${res.status}): ${data.error_description || data.error || "error desconocido"}`
    );
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Account discovery — listAccessibleCustomers + per-customer GAQL describe
// ---------------------------------------------------------------------------

export interface DiscoveredAccount {
  customer_id: string;
  descriptive_name: string | null;
  currency: string | null;
  time_zone: string | null;
  is_manager: boolean;
}

function developerToken(): string {
  const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN no está configurado en el servidor.");
  return token;
}

/** Describe one customer via GAQL. Defensive: returns nulls when the query
 *  fails (e.g. cancelled account) so the id is still kept. */
async function describeCustomer(
  accessToken: string,
  customerId: string
): Promise<DiscoveredAccount> {
  const fallback: DiscoveredAccount = {
    customer_id: customerId,
    descriptive_name: null,
    currency: null,
    time_zone: null,
    is_manager: false,
  };
  try {
    const res = await fetchWithTimeout(
      `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": developerToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1",
        }),
      },
      10000
    );
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      results?: Array<{
        customer?: {
          descriptiveName?: string;
          currencyCode?: string;
          timeZone?: string;
          manager?: boolean;
        };
      }>;
    };
    const c = data.results?.[0]?.customer;
    if (!c) return fallback;
    return {
      customer_id: customerId,
      descriptive_name: c.descriptiveName ?? null,
      currency: c.currencyCode ?? null,
      time_zone: c.timeZone ?? null,
      is_manager: Boolean(c.manager),
    };
  } catch {
    return fallback;
  }
}

/**
 * List the Google Ads accounts the refresh token can access, enriched with
 * name/currency/timezone/manager where possible. Throws only when the initial
 * listAccessibleCustomers call fails (per-customer describe never throws).
 */
export async function listAccessibleCustomers(
  refreshToken: string
): Promise<DiscoveredAccount[]> {
  const accessToken = await mintAccessToken(refreshToken);

  const res = await fetchWithTimeout(
    `https://googleads.googleapis.com/${API_VERSION}/customers:listAccessibleCustomers`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": developerToken(),
      },
    },
    15000
  );
  const data = (await res.json().catch(() => ({}))) as {
    resourceNames?: string[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      `Google Ads no devolvió las cuentas accesibles (${res.status}): ${data.error?.message || "error desconocido"}`
    );
  }

  const ids = (data.resourceNames ?? [])
    .map((rn) => String(rn).split("/").pop() ?? "")
    .filter(Boolean)
    .slice(0, 100); // defensive cap for huge MCC users

  // Describe in small batches so one slow customer doesn't serialize the rest.
  const accounts: DiscoveredAccount[] = [];
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const described = await Promise.all(
      batch.map((id) => describeCustomer(accessToken, id))
    );
    accounts.push(...described);
  }
  return accounts;
}
