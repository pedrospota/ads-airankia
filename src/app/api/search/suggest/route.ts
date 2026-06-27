import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-auth";
import { createSupabaseReadClient } from "@/lib/supabase-server";
import { callStructured } from "@/lib/llm";
import { BUDGET } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/search/suggest
// Uses the business context we already have on file (name, sector, website) to
// draft, with AI, a friendly campaign objective + a starting daily budget — so
// the user can create a campaign without filling anything in by hand.

interface SuggestBody {
  brandId: string;
}

interface Suggestion {
  objective: string;
  budgetDailyUsd: number;
  reason: string;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["objective", "budgetDailyUsd", "reason"],
  properties: {
    objective: {
      type: "string",
      description:
        "Campaign objective in 1-2 sentences, in FIRST PERSON as if the business owner wrote it. Plain, friendly language, no jargon. Written in the brand's own main language.",
    },
    budgetDailyUsd: {
      type: "number",
      description: "Suggested daily budget to start with (whole number).",
    },
    reason: {
      type: "string",
      description:
        "A single sentence explaining why that budget, in the brand's own main language.",
    },
  },
};

export async function POST(request: NextRequest) {
  const authClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: SuggestBody;
  try {
    body = (await request.json()) as SuggestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.brandId) {
    return NextResponse.json({ error: "brandId is required" }, { status: 400 });
  }

  const {
    data: { session },
  } = await authClient.auth.getSession();
  const readClient = createSupabaseReadClient(session?.access_token);
  const { data: brand, error: brandError } = await readClient
    .from("brand_project")
    .select("id, name, industry, website, description:business_entity_description")
    .eq("id", body.brandId)
    .single();

  if (brandError || !brand) {
    console.error("[search/suggest] brand lookup failed", brandError);
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }

  const context = [
    `Brand name: ${brand.name ?? "(no name)"}`,
    brand.industry ? `Industry / activity: ${brand.industry}` : null,
    brand.website ? `Website: ${brand.website}` : null,
    brand.description ? `Description: ${brand.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const system =
    "You are a Google Ads expert who helps people with NO technical knowledge. " +
    "Write in plain, friendly, clear language, with no jargon. " +
    "Write the objective and the reason in the BRAND'S OWN MAIN LANGUAGE — the " +
    "language of its website and the customers it serves (e.g. an English-speaking " +
    "business → English; a Spanish one → Spanish). Match that language exactly.";

  const prompt = [
    "Based on this business's information, propose:",
    "1) A Google Search campaign objective, written in FIRST PERSON as if the owner wrote it (1-2 concrete sentences, no jargon).",
    `2) A reasonable daily budget to start with (whole number, minimum ${BUDGET.minDailyUsd}).`,
    "3) A short reason (1 sentence) for that budget.",
    "",
    "Write the objective and reason in the brand's own main language (infer it from the name, website and description).",
    "",
    "Business information:",
    context,
  ].join("\n");

  try {
    const { data } = await callStructured<Suggestion>({
      agentId: "planner",
      system,
      prompt,
      schema: SCHEMA,
      toolName: "suggest_campaign",
      toolDescription:
        "Return a suggested objective and daily budget for the campaign.",
      maxTokens: 600,
      temperature: 0.4,
    });

    const budget = Math.max(
      BUDGET.minDailyUsd,
      Math.round(data.budgetDailyUsd || BUDGET.minDailyUsd),
    );
    return NextResponse.json({
      objective: (data.objective ?? "").trim(),
      budgetDailyUsd: budget,
      reason: (data.reason ?? "").trim(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "We couldn't generate the suggestion. Please try again.",
      },
      { status: 500 },
    );
  }
}
