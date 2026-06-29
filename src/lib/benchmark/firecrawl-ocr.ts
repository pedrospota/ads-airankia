// ============================================================================
// Firecrawl OCR — extract text from ad image URLs.
// MCP server: https://automations.ideacharge.com/mcp/firecrawlscrapper
// Tool: ocr_image_simple_text
// Used in extended modes to pull text from transparency-center ad images.
// Called in parallel across all images — never throws, returns "" on failure.
// ============================================================================

const ENDPOINT = "https://automations.ideacharge.com/mcp/firecrawlscrapper";

export async function ocrImageText(imageUrl: string): Promise<string> {
  if (!imageUrl?.trim()) return "";
  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "ocr_image_simple_text",
          arguments: { url: imageUrl },
        },
        id: 1,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return "";

    // Handle SSE stream or plain JSON.
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await resp.text();
      // Extract last data: line with result content.
      const lines = text.split("\n").filter((l) => l.startsWith("data:"));
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(lines[i].slice(5));
          const content =
            d?.result?.content?.[0]?.text ??
            d?.params?.result?.content?.[0]?.text ??
            "";
          if (content) return String(content).trim();
        } catch {
          continue;
        }
      }
      return "";
    }

    const json = await resp.json();
    return (
      json?.result?.content?.[0]?.text ??
      json?.result?.content ??
      ""
    ).toString().trim();
  } catch {
    return "";
  }
}

/** OCR multiple image URLs in parallel, returning url→text map. */
export async function ocrImagesBatch(
  imageUrls: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(imageUrls.filter(Boolean))];
  const results = await Promise.all(
    unique.map(async (url) => [url, await ocrImageText(url)] as const)
  );
  return new Map(results.filter(([, text]) => text));
}
