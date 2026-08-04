/**
 * Pure-stdlib (fetch + Buffer) Codex OAuth refresh + JWT exp decoding.
 *
 * Lives here (not in codexAuth.ts) so the Next.js server side can import it
 * via polaris/internal without dragging in node:child_process / spawn /
 * mkdtemp from the rest of codexAuth.ts. Used by:
 *   - action/utils/codexAuth.ts (re-exports refreshCodexAuthBody)
 *   - utils/codexSecretRotation.ts (server-side maybeRotate at run-context)
 *
 * See wiki/codex-auth.md for the end-to-end refresh lifecycle.
 */

export interface CodexAuthBody {
  auth_mode: "chatgpt";
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/** OAuth client id Codex CLI and OpenCode both use against `auth.openai.com`.
 * Same chain - a refresh token minted via `codex login --device-auth` can be
 * refreshed against this client_id. */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

/** thrown when the OAuth provider rejects the refresh token (4xx). callers
 * can distinguish "race-lost / token revoked" from network errors via
 * `instanceof OAuthInvalidGrantError`. */
export class OAuthInvalidGrantError extends Error {
  public readonly status: number;
  constructor(status: number, body: string) {
    super(`Codex token refresh failed: ${status} ${body}`);
    this.name = "OAuthInvalidGrantError";
    this.status = status;
  }
}

/** force one refresh round-trip against the OAuth provider. returns the
 * rotated Codex-shaped blob (the auth.json body verbatim). does NOT persist
 * - caller is responsible for writing back to wherever the token lives.
 *
 * server-side callers (maybeRotateCodexSecret) hold a DB row lock around
 * this call so concurrent runs serialize: first one rotates, subsequent
 * ones see the fresh value and skip. The 10s timeout is critical for that
 * use: it caps how long a stalled auth.openai.com holds the row lock,
 * keeping us well under the enclosing 30s transaction budget so the lock
 * always releases and queued callers get a turn instead of timing out on
 * the tx wrapper. Real OAuth latency is sub-second; 10s is generous. */
export async function refreshCodexAuthBody(body: CodexAuthBody): Promise<CodexAuthBody> {
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: body.tokens.refresh_token,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status >= 400 && response.status < 500) {
      throw new OAuthInvalidGrantError(response.status, text);
    }
    throw new Error(`Codex token refresh failed: ${response.status} ${text}`);
  }
  const tokens = (await response.json()) as OAuthTokenResponse;
  const idToken = tokens.id_token ?? body.tokens.id_token;
  const accountId = body.tokens.account_id;
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(idToken ? { id_token: idToken } : {}),
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

/** decode the access_token's JWT payload and return its `exp` claim in ms
 * since epoch. returns null if the token isn't a parseable JWT or has no
 * `exp` claim - caller falls back to "treat as expired".
 *
 * We don't verify the JWT signature (we'd need OpenAI's JWKS); we're only
 * using the claim as a freshness hint. The actual auth check happens
 * server-side at OpenAI when the token is used - trusting a fake JWT here
 * would just delay the inevitable 401 from OpenAI. No security boundary
 * at this decode step. */
export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let payload: { exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  return payload.exp * 1000;
}

/** parse + validate a Codex auth.json body from its JSON-string form.
 * returns null on any shape mismatch - caller treats as "no codex auth". */
export function parseCodexAuthBody(raw: string): CodexAuthBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed as Record<string, unknown>;
  if (v.auth_mode !== "chatgpt") return null;
  const tokens = v.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || t.access_token.length === 0) return null;
  if (typeof t.refresh_token !== "string" || t.refresh_token.length === 0) return null;
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      ...(typeof t.id_token === "string" ? { id_token: t.id_token } : {}),
      ...(typeof t.account_id === "string" ? { account_id: t.account_id } : {}),
    },
    ...(typeof v.last_refresh === "string" ? { last_refresh: v.last_refresh } : {}),
  };
}

/** serialize a CodexAuthBody to its canonical on-disk form. */
export function stringifyCodexAuthBody(body: CodexAuthBody): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}
