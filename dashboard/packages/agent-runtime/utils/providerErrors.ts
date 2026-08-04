type ProviderErrorPattern = { regex: RegExp; label: string };

/** Stable label for the BYOK provider-billing-exhausted classification. */
export const PROVIDER_BILLING_EXHAUSTED_LABEL = "provider billing exhausted";

// status codes are only treated as provider errors when they are adjacent to
// a recognised status key. this rejects commit SHAs that happen to contain
// "429", version strings, file hashes, etc.
const statusKey = `\\b(?:status[_ ]?code|http[_ ]?status|status)["']?\\s*[:=]\\s*["']?`;

const PROVIDER_ERROR_PATTERNS: ProviderErrorPattern[] = [
  // billing-payload patterns come BEFORE bare status-code patterns. providers
  // commonly return 401 / 429 for billing/quota exhaustion (OpenCode Zen
  // `CreditsError` / `FreeUsageLimitError`, Gemini `RESOURCE_EXHAUSTED` +
  // "spending cap", Anthropic "Insufficient balance" / "credit balance is
  // too low"). these are non-retryable and require user-billing action -
  // distinct from a transient auth error or rate-limit. status-code patterns
  // would otherwise win and surface "auth error (401)" / "rate limited (429)"
  // with no billing hint. see #778, #835.
  { regex: /\bCreditsError\b/, label: PROVIDER_BILLING_EXHAUSTED_LABEL },
  { regex: /\bFreeUsageLimitError\b/, label: PROVIDER_BILLING_EXHAUSTED_LABEL },
  { regex: /Insufficient balance/i, label: PROVIDER_BILLING_EXHAUSTED_LABEL },
  { regex: /credit balance is too low/i, label: PROVIDER_BILLING_EXHAUSTED_LABEL },
  // "spending cap" (Gemini) and "spending limit" (xAI, #1076) are the same
  // condition in two house styles - a configured ceiling was reached.
  { regex: /spending (?:cap|limit)/i, label: PROVIDER_BILLING_EXHAUSTED_LABEL },
  // xAI exhausts credits and the monthly ceiling in one 403 whose status code
  // sits nowhere near a `status:` key, so no status pattern below fires (#1076).
  { regex: /used all available credits/i, label: PROVIDER_BILLING_EXHAUSTED_LABEL },
  // the OpenRouter shapes `isRouterKeylimitExhaustedError` matches. on a Router
  // run those mean the POLARIS wallet is empty and `renderRunError` returns a
  // `BillingError` before ever reaching this list; on a BYOK run the very same
  // wire text means the user's OWN OpenRouter wallet is empty, and this entry is
  // what gives them the right dashboard instead of ours. see #1135.
  {
    regex: /requires more credits|Key limit exceeded \(total limit\)/i,
    label: PROVIDER_BILLING_EXHAUSTED_LABEL,
  },
  // auth patterns must come BEFORE rate-limit patterns. OpenRouter 401 error
  // payloads carry `x-ratelimit-*` response headers in the dump, and the
  // free-form rate-limit regex below would otherwise win on word-boundary
  // matches inside header names. canonical 401 messages: OpenRouter returns
  // `{"error":{"message":"User not found","code":401}}` for disabled or
  // invalid keys (https://openai.luzhipeng.com/docs/api/reference/errors-and-debugging).
  { regex: new RegExp(`${statusKey}401\\b`, "i"), label: "auth error (401)" },
  { regex: new RegExp(`${statusKey}403\\b`, "i"), label: "auth error (403)" },
  { regex: /\bUser not found\b/i, label: "auth error (invalid/disabled key)" },
  { regex: /\bInvalid authentication\b/i, label: "auth error (invalid credentials)" },
  { regex: /\bNo auth credentials found\b/i, label: "auth error (missing credentials)" },
  { regex: new RegExp(`${statusKey}429\\b`, "i"), label: "rate limited (429)" },
  { regex: new RegExp(`${statusKey}500\\b`, "i"), label: "provider 500 error" },
  { regex: new RegExp(`${statusKey}503\\b`, "i"), label: "provider unavailable (503)" },
  // matches `rate limit`, `rate limited`, `rate limits exceeded`,
  // `rate_limit_error`, `rate_limit_exceeded`. the leading `\b` + `[_ ]`
  // separator rejects `x-ratelimit-*` / `anthropic-ratelimit-*` response
  // headers (no separator between "rate" and "limit") which routinely
  // appear in dumped 401 / 4xx error JSON.
  { regex: /\brate[_ ]limit/i, label: "rate limited" },
  { regex: /\bRESOURCE_EXHAUSTED\b/, label: "quota exhausted" },
  // Google gRPC `INTERNAL` status. word-boundary anchors reject
  // `INTERNAL_SERVER_ERROR` (HTTP 500 message that may appear in unrelated
  // log lines) and identifiers like `INTERNALS`.
  { regex: /\bINTERNAL\b/, label: "provider internal error" },
  { regex: /\bUNAVAILABLE\b/, label: "provider unavailable" },
  // matches `quota`, `insufficient_quota`, `quota_exceeded`, `quotaExceeded`.
  // word-character lookarounds would reject `_quota` / `quotaX`; `quota` is
  // specific enough that a plain substring match is safe.
  { regex: /quota/i, label: "quota error" },
  // explicit zero-quota response, e.g. `{"limit": 0}`. the `\b` anchor
  // around `limit` rejects keys like `time_limit` or `field_limit`.
  { regex: /["']?\blimit\b["']?\s*:\s*0\b/, label: "zero quota" },
];

/**
 * Result of a provider-error scan: the classification label plus a
 * human-readable excerpt centered on the matched line. The excerpt is what
 * gets surfaced in `» provider error detected (...)` log lines - see
 * `extractExcerpt` for the windowing/byte-cap policy.
 */
export type ProviderErrorMatch = {
  label: string;
  excerpt: string;
};

// roughly half a wide terminal line by 4-5 lines of context; large enough
// to capture a structured error payload (request id, retry-after, model)
// plus its immediate stack/headers, small enough to not flood the log.
const EXCERPT_MAX_BYTES = 600;
const LINES_BEFORE = 1;
const LINES_AFTER = 2;

export function findProviderErrorMatch(text: string): ProviderErrorMatch | null {
  for (const entry of PROVIDER_ERROR_PATTERNS) {
    const m = entry.regex.exec(text);
    if (!m) continue;
    return { label: entry.label, excerpt: extractExcerpt(text, m.index) };
  }
  return null;
}

export function detectProviderError(text: string): string | null {
  return findProviderErrorMatch(text)?.label ?? null;
}

/**
 * Slice a context window around `matchIndex`: the matched line plus
 * `LINES_BEFORE`/`LINES_AFTER` neighbours. If the windowed slice exceeds
 * `EXCERPT_MAX_BYTES` (giant adjacent lines, e.g. JSON tool-schema dumps),
 * fall back to the matched line alone, head-truncated if still too long.
 * Replaces the old `chunk.substring(0, 500)` head-anchored excerpt which
 * surfaced whatever happened to be at the front of the stderr buffer
 * instead of the error itself. See issue #703.
 */
function extractExcerpt(text: string, matchIndex: number): string {
  const lineStart = text.lastIndexOf("\n", matchIndex - 1) + 1;
  const lineEndRaw = text.indexOf("\n", matchIndex);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;

  let start = lineStart;
  for (let i = 0; i < LINES_BEFORE && start > 0; i++) {
    const prev = text.lastIndexOf("\n", start - 2);
    start = prev < 0 ? 0 : prev + 1;
  }

  let end = lineEnd;
  for (let i = 0; i < LINES_AFTER && end < text.length; i++) {
    const next = text.indexOf("\n", end + 1);
    end = next < 0 ? text.length : next;
  }

  let excerpt = text.slice(start, end);
  if (excerpt.length > EXCERPT_MAX_BYTES) {
    excerpt = text.slice(lineStart, lineEnd);
    if (excerpt.length > EXCERPT_MAX_BYTES) excerpt = excerpt.slice(0, EXCERPT_MAX_BYTES);
  }
  return excerpt.trim();
}

/**
 * OpenRouter's response when the per-run key's remaining budget can't cover
 * the agent's `max_tokens` reservation. Distinct from a generic provider error
 * because it's a Polaris billing concern, not an upstream outage - the user's
 * Router wallet ran out (or the key budget was undersized at mint time and the
 * agent ran out of headroom partway through).
 *
 * Match must be specific to this exact OpenRouter error class. Generic "credits"
 * or "limit" text shows up in unrelated errors and would mis-classify them.
 *
 * Sample:
 *   `APIError: This request requires more credits, or fewer max_tokens.
 *    You requested up to 32000 tokens, but can only afford 22800.`
 *
 * second shape (#1071): OpenRouter's cumulative-cap 403, `Key limit exceeded
 * (total limit). Manage it using <keys url>`. same billing condition, different
 * wire message. the parenthetical stays IN the match: this predicate runs first
 * in `renderRunError`, so the bare phrase would outrank every other classifier
 * on a BYOK user's own capped key. our mint hardcodes `limit_reset: null`
 * (`utils/openrouter.ts`), so only the total-limit variant is producible.
 */
// `/s` (dotAll) lets `.*?` cross newlines so we still detect the error if any
// upstream layer reformats the message onto multiple lines. Without it, a
// single inserted `\n` would silently bypass the BillingError reclassification
// and the user would see the generic `❌ Polaris failed` dump instead of the
// actionable top-up CTA.
const ROUTER_KEYLIMIT_EXHAUSTED_PATTERN =
  /requires more credits.*?fewer max_tokens|requested up to \d+ tokens.*?can only afford|Key limit exceeded \(total limit\)/is;

export function isRouterKeylimitExhaustedError(text: string): boolean {
  return ROUTER_KEYLIMIT_EXHAUSTED_PATTERN.test(text);
}

/**
 * BYOK billing-exhausted: provider rejected the request because the user's
 * provider wallet is empty (DeepSeek "Insufficient Balance", Anthropic
 * "credit balance is too low", OpenCode Zen `CreditsError` /
 * `FreeUsageLimitError`, Gemini "spending cap"). Distinct from
 * `isRouterKeylimitExhaustedError` - that's Polaris's Router wallet, this
 * is the user's own provider account.
 */
export function isProviderBillingExhausted(text: string): boolean {
  return findProviderErrorMatch(text)?.label === PROVIDER_BILLING_EXHAUSTED_LABEL;
}

/**
 * Extract `providerID=foo` from agent error logs (OpenCode emits this on
 * `provider error detected (...)` lines). Returns the lowercase provider
 * slug, or null when absent. Used to render a provider-specific dashboard
 * link in the BYOK billing-exhausted summary.
 */
export function extractProviderId(text: string): string | null {
  const match = text.match(/\bproviderID=([a-z0-9_-]+)/i);
  return match ? match[1].toLowerCase() : null;
}
