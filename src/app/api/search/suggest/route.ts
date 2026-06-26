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
        "Objetivo de la campaña en 1-2 frases, EN PRIMERA PERSONA como si lo escribiera el dueño del negocio. Español sencillo, sin jerga ni anglicismos.",
    },
    budgetDailyUsd: {
      type: "number",
      description: "Presupuesto diario sugerido para empezar (número entero).",
    },
    reason: {
      type: "string",
      description: "Una sola frase explicando por qué ese presupuesto.",
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
    `Nombre de la marca: ${brand.name ?? "(sin nombre)"}`,
    brand.industry ? `Sector / actividad: ${brand.industry}` : null,
    brand.website ? `Sitio web: ${brand.website}` : null,
    brand.description ? `Descripción: ${brand.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const system =
    "Eres un experto en Google Ads que ayuda a personas SIN conocimientos técnicos. " +
    "Escribe SIEMPRE en español sencillo, cercano y claro, sin jerga ni anglicismos.";

  const prompt = [
    "A partir de la información de este negocio, propón:",
    "1) Un objetivo de campaña de Google (búsqueda), redactado EN PRIMERA PERSONA, como si lo hubiera escrito el dueño (1-2 frases concretas, sin tecnicismos).",
    `2) Un presupuesto diario razonable para empezar (número entero, mínimo ${BUDGET.minDailyUsd}).`,
    "3) Una breve razón (1 frase) de por qué ese presupuesto.",
    "",
    "Información del negocio:",
    context,
  ].join("\n");

  try {
    const { data } = await callStructured<Suggestion>({
      agentId: "planner",
      system,
      prompt,
      schema: SCHEMA,
      toolName: "proponer_campania",
      toolDescription:
        "Devuelve un objetivo y un presupuesto diario sugeridos para la campaña.",
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
            : "No pudimos generar la sugerencia. Inténtalo de nuevo.",
      },
      { status: 500 },
    );
  }
}
