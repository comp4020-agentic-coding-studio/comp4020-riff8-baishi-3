// Small helpers shared by the API routes.

export const MAX_BODY = 4096;

export async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "request too large" });
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return json(400, { ok: false, error: "expected a JSON object" });
    return v as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, error: "expected a JSON body" });
  }
}

export const json = (status: number, body: unknown): Response => Response.json(body, { status });
