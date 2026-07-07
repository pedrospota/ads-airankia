// POST /api/command/blueprint/suggest
// Per-field AI suggest for the blueprint editor: given ONE field the operator
// is filling (group_name | keywords | headline | description) plus free-form
// context, returns an AI-drafted value that already respects Google's limits.
// The AI never executes anything — the operator still has to accept it, and
// this route re-validates the returned value server-side before it ever
// reaches the client, exactly like the /advance re-validation elsewhere:
// never trust a value round-tripped through the client (or the model).
import { NextRequest, NextResponse } from "next/server";
import { getCommandAccess, commandDenied } from "@/lib/command/access";
import { suggestField, SUGGEST_SCHEMAS, type SuggestKind } from "@/lib/command/blueprint/suggest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SuggestBody {
  kind?: unknown;
  context?: unknown;
}

const VALID_KINDS: ReadonlySet<SuggestKind> = new Set(["group_name", "keywords", "headline", "description"]);

function isSuggestKind(v: unknown): v is SuggestKind {
  return typeof v === "string" && VALID_KINDS.has(v as SuggestKind);
}

export async function POST(request: NextRequest) {
  const access = await getCommandAccess();
  if (!access) return commandDenied();

  let body: SuggestBody;
  try {
    body = (await request.json()) as SuggestBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!isSuggestKind(body.kind)) {
    return NextResponse.json(
      { error: "kind inválido: debe ser group_name, keywords, headline o description" },
      { status: 400 }
    );
  }
  const context = typeof body.context === "string" ? body.context : undefined;

  try {
    const { value, warnings } = await suggestField({ kind: body.kind, context });

    // Mandatory re-validation: suggestField already clamps, but this route is
    // the trust boundary — re-check the field's own schema before responding
    // so a bug upstream can never surface an out-of-spec value to the UI.
    const parsed = SUGGEST_SCHEMAS[body.kind].safeParse(value);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "La sugerencia generada no cumple los límites del campo." },
        { status: 500 }
      );
    }

    return NextResponse.json({ value: parsed.data, warnings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
