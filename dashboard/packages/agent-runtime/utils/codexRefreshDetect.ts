/** Convert an on-disk OpenCode auth.json back to the Codex CLI shape so the
 * post-hook can write it to the Polaris secret store. Returns null when the
 * file's `openai` entry is missing, has the wrong type, or hasn't actually
 * refreshed (refresh token unchanged from `originalRefresh`). Lives in its
 * own module so `entryPost.ts` can import it without pulling in `codexHome.ts`
 * (which imports `./cli.ts` and node fs helpers). */
export function detectCodexRefresh(params: {
  authFileContent: string;
  originalRefresh: string;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.authFileContent);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = (parsed as Record<string, unknown>).openai;
  if (!oauth || typeof oauth !== "object") return null;
  const o = oauth as Record<string, unknown>;
  if (o.type !== "oauth") return null;
  if (typeof o.refresh !== "string" || typeof o.access !== "string") return null;
  if (o.refresh === params.originalRefresh) return null;

  const codexShape = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: o.access,
      refresh_token: o.refresh,
      ...(typeof o.accountId === "string" ? { account_id: o.accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  return `${JSON.stringify(codexShape, null, 2)}\n`;
}
