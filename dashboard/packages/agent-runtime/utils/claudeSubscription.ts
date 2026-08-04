import { resolveModelSlug } from "../models.ts";

/**
 * identity block Anthropic's OAuth gate validates on `/v1/messages` calls
 * authenticated with a Claude Code OAuth token. haiku is currently exempt
 * but sending it costs nothing and survives the exemption being removed.
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// fallback probe model for runs with no explicit model (claude-code picks its
// own default there, so per-model accuracy is moot - only whether the
// subscription answers at all). registry-resolved so the models-bump cron
// keeps the id fresh.
const fallbackResolve = resolveModelSlug("anthropic/claude-haiku");
if (!fallbackResolve) {
  throw new Error("claudeSubscription preflight: anthropic/claude-haiku missing from registry");
}
const FALLBACK_PROBE_MODEL = fallbackResolve.slice(fallbackResolve.indexOf("/") + 1);

export type SubscriptionPreflight = { usable: true } | { usable: false; reason: string };

/**
 * preflight a Claude subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`)
 * with a 1-token Messages call, so the agent can fall back to
 * `ANTHROPIC_API_KEY` when the subscription is exhausted or revoked instead
 * of failing the whole run at its first model call. rides the same de-facto
 * OAuth surface Claude Code itself uses: Bearer auth + the
 * `claude-code-20250219,oauth-2025-04-20` betas + the identity system prompt.
 *
 * probes the run's own model when known - subscription limits can be
 * per-model ("You've hit your Opus limit"), so a cheaper stand-in could pass
 * preflight and still leave the run dead on arrival.
 *
 * fail-open by design: only 401 (revoked/expired token), 403 (Anthropic
 * `permission_error` - the credential isn't entitled to serve this run, e.g.
 * an org disabled Claude Code subscription access, #1072) and 429
 * (session/weekly/per-model limit) mark the token unusable. network errors,
 * 5xx, and request-shape drift (400) all keep today's subscription-first
 * behavior, so the preflight can never fail a run that would have worked -
 * the worst wrong answer is a run that bills the API key instead of the
 * subscription.
 */
export async function preflightClaudeSubscription(params: {
  token: string;
  /** bare Anthropic model id the run will use (e.g. "claude-fable-5") */
  model: string | undefined;
}): Promise<SubscriptionPreflight> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.token}`,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-app": "cli",
      },
      body: JSON.stringify({
        model: params.model ?? FALLBACK_PROBE_MODEL,
        max_tokens: 1,
        system: CLAUDE_CODE_IDENTITY,
        messages: [{ role: "user", content: "ok" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // network failure / timeout says nothing about the credential
    return { usable: true };
  }
  if (res.status !== 401 && res.status !== 403 && res.status !== 429) return { usable: true };
  const body = await res.text().catch(() => "");
  return { usable: false, reason: `${res.status}: ${extractApiErrorMessage(body)}` };
}

/** pull `error.message` out of an Anthropic error payload, else a raw excerpt */
function extractApiErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      return parsed.error.message;
    }
  } catch {
    // not json - fall through to the raw excerpt
  }
  return body.slice(0, 200);
}
