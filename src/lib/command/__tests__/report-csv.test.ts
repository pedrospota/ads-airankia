import { describe, it, expect } from "bun:test";
import { executionsToCsv, type ExecutionDto } from "../report-csv";

function row(overrides: Partial<ExecutionDto> = {}): ExecutionDto {
  return {
    id: "exec-1",
    actionId: "action-1",
    network: "google_ads",
    accountRef: "123-456-7890",
    operation: "campaigns:mutate",
    validateOnly: false,
    status: "done",
    actor: "buyer@agency.com",
    createdAt: "2026-07-08T14:32:00.000Z",
    actionType: "budget_update",
    entityName: "Campaña Brand ES",
    actionStatus: "verified",
    before: { status: "ENABLED", dailyBudgetMicros: 10_000_000 },
    after: { status: "ENABLED", dailyBudgetMicros: 12_000_000 },
    rollbackNote: "budget_update(10.00)",
    rationale: "Subir para aprovechar el pico del fin de semana",
    ...overrides,
  };
}

describe("executionsToCsv", () => {
  it("prefixes a UTF-8 BOM", () => {
    const csv = executionsToCsv([row()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("emits the exact header row", () => {
    const csv = executionsToCsv([]);
    const [header] = csv.slice(1).split("\r\n");
    expect(header).toBe(
      "Fecha,Red,Cuenta,Entidad,Acción,Antes → Después,Actor,Estado,Verificada,Por qué,Reversión"
    );
  });

  it("uses CRLF line endings between records, including a trailing terminator", () => {
    const csv = executionsToCsv([row(), row({ id: "exec-2" })]);
    const body = csv.slice(1); // drop BOM
    expect(body).toContain("\r\n");
    // header + 2 data rows + trailing terminator = 3 CRLF separators.
    expect(body.split("\r\n").length - 1).toBe(3);
  });

  it("quotes a field containing a comma, a quote, and a newline (RFC-4180 round-trip)", () => {
    const tricky = 'Nota, con "comillas"\ny salto de línea';
    const csv = executionsToCsv([row({ rationale: tricky })]);
    const dataLine = csv.slice(1).split("\r\n")[1];
    // RFC-4180: wrapped in quotes, internal quotes doubled, raw comma/newline
    // preserved verbatim inside the quoted field.
    const expectedEncoded = '"Nota, con ""comillas""\ny salto de línea"';
    expect(dataLine).toContain(expectedEncoded);
  });

  it('maps actionStatus==="verified" to "Sí" and anything else to an empty cell', () => {
    const verifiedFields = executionsToCsv([row({ actionStatus: "verified" })])
      .slice(1).split("\r\n")[1].split(",");
    const executedFields = executionsToCsv([row({ actionStatus: "executed" })])
      .slice(1).split("\r\n")[1].split(",");
    expect(verifiedFields[8]).toBe("Sí");
    expect(executedFields[8]).toBe("");
  });

  it('renders a null rationale as an empty "Por qué" cell', () => {
    const fields = executionsToCsv([row({ rationale: null })])
      .slice(1).split("\r\n")[1].split(",");
    expect(fields[9]).toBe("");
  });

  it("renders no data rows (only the header) for an empty input", () => {
    const csv = executionsToCsv([]);
    const body = csv.slice(1);
    expect(body.split("\r\n").length - 1).toBe(1); // header + trailing terminator only
  });
});
