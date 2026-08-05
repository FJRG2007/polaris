/**
 * Classify + render the error thrown out of the main run try-block into a
 * pair of user-facing markdown bodies - one for the GitHub Actions job
 * summary tab, one for the PR progress comment.
 *
 * Classifications, in dispatch order (first match wins; the api-key
 * branch additionally folds in the activity-timeout hang body as a
 * sub-source so a hang masking an api-key error still surfaces the api-key
 * CTA):
 *
 *   1. `BillingError` - either the proxy-token mint already threw one (402
 *      handled inline) or the agent runtime surfaced an OpenRouter
 *      "key budget exhausted" string mid-run. Both render via
 *      `formatBillingErrorSummary` so the user sees actionable copy.
 *
 *   2. BYOK provider billing-exhausted (#835) - DeepSeek "Insufficient
 *      Balance", Anthropic "credit balance is too low", OpenCode Zen
 *      `CreditsError`, Gemini "spending cap". Checked before api-key auth
 *      because billing-exhausted responses often carry 401 status codes
 *      that `isApiKeyAuthError` would otherwise mis-classify.
 *
 *   3. API-key auth error - `isApiKeyAuthError` sniffs the raw error string
 *      (or the activity-timeout hang body when present, since that's where
 *      the underlying provider error often lands); `formatApiKeyErrorSummary`
 *      renders provider + console-link copy.
 *
 *   4. ProviderModelNotFoundError - configured model id no longer in the
 *      OpenCode catalog; renders a nudge to pick a different model.
 *
 *   4a. No-provider-available (#1077) - the model IS in the catalog but the
 *      provider declines to route it on this account's plan (OpenCode Zen's
 *      own refusal string). Same "pick another model" CTA, different reason.
 *
 *   4b. Plan rate ceiling - the provider refused the request for exceeding an
 *      allowance the ACCOUNT has (`Request too large ... on tokens per minute
 *      (TPM): Limit 8000, Requested 53681`), which the agent harness cannot
 *      tell from overflow and therefore reports as the give-up in 4c. Checked
 *      first, because the harness folds both messages into one string and this
 *      is the limit that was binding.
 *
 *   4c. Context-window overflow (#1116) - terminal `Prompt is too long` /
 *      `maximum context length is N tokens`. Actionable, so it renders on
 *      both surfaces rather than collapsing to the one-line comment.
 *
 *   5. Activity-timeout hang - `errorMessage` starts with
 *      `"activity timeout"` or `"agent still pending"` AND none of the
 *      above matched. The harness keeps structured diagnostic state on
 *      `toolState.agentDiagnostic`; `formatAgentHangBody` renders that into
 *      the job summary. The PR comment instead collapses to a one-line
 *      `**Run failed.** [View the logs →]` - the watchdog jargon, event
 *      counts, and benign stderr tail are operator-grade detail that only
 *      alarm the average user. The one exception is a hang masking billing
 *      exhaustion (#778), where `formatAgentHangBody` emits an actionable
 *      top-up CTA that the comment keeps verbatim.
 *
 *   6. Default - the job summary gets a plain-English lead sentence plus the
 *      raw error in a fenced code block under the `### ❌ Polaris failed`
 *      banner; the PR comment collapses to the same one-line logs link as
 *      the hang case, since the raw internal string helps nobody on the PR.
 *
 * Net: the actionable classifications (billing, API-key, model-not-found,
 * no-provider-available, rate-ceiling, context-overflow) render identical bodies on both
 * surfaces; the non-actionable ones (hang,
 * generic) keep the forensics in the Actions job summary and show a calm
 * one-liner in the PR comment, whose footer already carries Polaris
 * branding + rerun links.
 */

import type { AgentDiagnostic } from "./agentHangReport.ts";
import { formatAgentHangBody } from "./agentHangReport.ts";
import {
  formatApiKeyErrorSummary,
  isApiKeyAuthError,
  SECRETS_UNAVAILABLE_MARKER,
} from "./apiKeys.ts";
import { settingsLink } from "./apiUrl.ts";
import { BillingError, formatBillingErrorSummary } from "./billingErrors.ts";
import { MODEL_ACCESS_MARKER } from "./modelAccess.ts";
import {
  extractProviderId,
  isProviderBillingExhausted,
  isRouterKeylimitExhaustedError,
  parseRequestTooLargeRefusal,
  type RequestTooLargeRefusal,
} from "./providerErrors.ts";

export type RenderedRunError = {
  summary: string;
  comment: string;
};

function isProviderModelNotFoundError(message: string): boolean {
  return message.includes("ProviderModelNotFoundError");
}

/**
 * Terminal context-window overflow (#1116). The run did real work - 5-12
 * minutes of it - and then died with no review, so the generic branch's
 * one-line comment hides the only two levers the user has: a larger-context
 * model, or a smaller PR. Covers the Claude CLI (`Prompt is too long`), the
 * OpenRouter/opencode endpoint rejection (`maximum context length is N
 * tokens`), and opencode's post-compaction give-up.
 */
function isContextOverflowError(message: string): boolean {
  return (
    /Prompt is too long/i.test(message) ||
    /Input exceeds context window/i.test(message) ||
    /maximum context length is \d+ tokens/i.test(message) ||
    /Session too large to compact/i.test(message)
  );
}

/**
 * OpenCode Zen's own server-side refusal (its `zen.api.error.noProviderAvailable`
 * string), not a CLI or catalog fault: the model is real and listed, but the
 * account's plan cannot be routed to it. Distinct from
 * `ProviderModelNotFoundError`, where the id is gone from the catalog entirely.
 * Reached most often by auto-select landing on a Zen free-tier model for an
 * account with no Zen relationship. See #1077.
 */
function isNoProviderAvailableError(message: string): boolean {
  return /\bNo provider available\b/i.test(message);
}

function formatNoProviderAvailableSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {  return [
    "**The provider refused to serve this model.** It's listed in the catalog, but the account this run used has no access to it - so the request was accepted and then declined.",
    "",
    "This often happens when Polaris auto-selects a model your account can't reach. Pin an explicit model for this repo, or add credentials for the provider that was picked.",
    "",
    settingsLink("Model settings", input.owner, input.name),
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

function formatContextOverflowSummary(input: { owner: string; name: string; raw: string }): string {  return [
    "**This run exceeded the model's context window.** Polaris read more than the model could hold, so it stopped before finishing.",
    "",
    "Pick a model with a larger context window, or give the run less to read - a narrower task, or a smaller diff to review - and re-trigger.",
    "",
    settingsLink("Model settings", input.owner, input.name),
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

/**
 * A per-minute (or per-day) allowance on the account, which is a different
 * failure from the one above and must not be described as one.
 *
 * The remedy is the whole difference. A context window belongs to the model, so
 * a smaller job or a bigger model answers it. An allowance belongs to the plan,
 * and no job is small enough: an agent re-sends its instructions and its tool
 * definitions on every request, so the first turn of the shortest possible run
 * is already tens of thousands of tokens. Telling somebody in that position to
 * split their work sends them somewhere with nothing at the end of it.
 */
function formatRateCeilingSummary(input: {
  owner: string;
  name: string;
  raw: string;
  refusal: RequestTooLargeRefusal;
}): string {
  const { limit, requested, unit } = input.refusal;
  return [
    `**Your provider plan is capped below what a single request needs.** The cap is ${limit.toLocaleString("en-US")} ${unit}; this run asked for ${requested.toLocaleString("en-US")}.`,
    "",
    "That is a limit on the account, not on the model - the model had room. A shorter task will not get under it either: an agent sends its instructions and its tools with every request, so even the first one is bigger than the cap.",
    "",
    "Raise the limit with the provider (a paid tier usually does it), or point this repository at a provider whose allowance fits. The provider's own message below names the plan that was in effect.",
    "",
    settingsLink("Model settings", input.owner, input.name),
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

/**
 * Generic failure copy for any shape not caught by a more specific classifier
 * (billing / api-key / hang / model-not-found). A plain-English lead sentence
 * so the user isn't staring at a raw internal string like
 * `opencode prompt failed: fetch failed`, followed by the actual error in a
 * fenced code block for anyone who needs the detail. Shared by both surfaces;
 * the job summary adds the `### ❌ Polaris failed` banner on top.
 */
function formatGenericFailure(errorMessage: string): string {
  return [
    "Polaris ran into an unexpected error and couldn't finish this run. The underlying error is below - re-trigger Polaris to try again, and reach out to support if it keeps happening.",
    "",
    "```",
    errorMessage,
    "```",
  ].join("\n");
}

/**
 * Minimal PR-comment body for non-actionable failures (hangs, unexpected
 * errors). The forensic detail (event counts, stderr tail, raw error) stays
 * in the Actions job summary; the comment the average user sees is one calm
 * line plus a link to the logs. The footer appended by `reportErrorToComment`
 * already carries rerun / model context.
 */
function formatMinimalFailureComment(repo: { owner: string; name: string }): string {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return "**Run failed.**";
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const url = `${server}/${repo.owner}/${repo.name}/actions/runs/${runId}`;
  return `**Run failed.** [View the logs →](${url})`;
}

/**
 * Best-known billing top-up URL per provider. Conservative list: only
 * providers we've actually classified billing-exhaustion shapes for in
 * `providerErrors.ts`. Unknown providers fall through to a generic CTA.
 */
const PROVIDER_BILLING_URLS: Record<string, string> = {
  deepseek: "https://platform.deepseek.com/top_up",
  anthropic: "https://console.anthropic.com/settings/billing",
  openai: "https://platform.openai.com/account/billing",
  google: "https://aistudio.google.com/usage",
  opencode: "https://opencode.ai/zen",
  xai: "https://console.x.ai/team/default/billing",
  openrouter: "https://openrouter.ai/settings/credits",
};

/**
 * `extractProviderId` only fires when the harness emits `providerID=...`
 * (OpenCode log shape). Direct-provider errors (e.g. Anthropic SDK throwing
 * `"Your credit balance is too low to access the Anthropic API"`) carry no
 * such tag, so map their distinctive copy to a provider id here so the
 * dashboard link is reachable.
 *
 * Pattern is intentionally tight (Anthropic-specific phrasing only) to
 * avoid mis-tagging non-Anthropic billing-exhausted errors that happen to
 * mention `"Anthropic API"` in passing - the broader phrase appears in
 * fallback-chain agent prompt text and OpenCode harness logs.
 */
function detectProviderId(message: string): string | null {
  const harnessId = extractProviderId(message);
  if (harnessId) return harnessId;
  if (/credit balance is too low/i.test(message)) return "anthropic";
  // xAI's exhaustion arrives via the opencode `session.error` path, which
  // carries no `providerID=` tag. its team-scoped phrasing is distinctive
  // enough to map on its own. see #1076.
  if (/used all available credits/i.test(message)) return "xai";
  // same gap, and it is the ONLY path #1135 is about: `providerID=` is folded in
  // by `withServerStderr`, which runs only on a `session.create` failure, so a
  // mid-run credit exhaustion arrives as bare wire text. without this the BYOK
  // fall-through lands on the linkless generic copy and the openrouter entry in
  // PROVIDER_BILLING_URLS is dead. see #1135.
  if (/requires more credits|Key limit exceeded \(total limit\)|openrouter\.ai/i.test(message)) {
    return "openrouter";
  }
  return null;
}

function formatProviderBillingExhausted(input: { errorMessage: string }): string {
  const providerId = detectProviderId(input.errorMessage);
  const dashboardUrl = providerId ? PROVIDER_BILLING_URLS[providerId] : undefined;

  const headline = providerId
    ? `**Your \`${providerId}\` account is out of credit.**`
    : "**Your provider account is out of credit.**";
  const cta = dashboardUrl
    ? `[Top up \`${providerId}\` →](${dashboardUrl})`
    : "Top up your provider account, then re-trigger Polaris.";

  return [
    headline,
    "",
    "Polaris detected a billing-exhausted response from your provider - the agent stopped before completing this run.",
    "",
    cta,
    "",
    `\`\`\`\n${input.errorMessage}\n\`\`\``,
  ].join("\n");
}

function formatProviderModelNotFoundSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {
  return (
    `The configured model is no longer available in OpenCode's catalog. ` +
    `Pick a different model in the Polaris console for \`${input.owner}/${input.name}\`, ` +
    `or contact support if this persists.\n\n` +
    `\`\`\`\n${input.raw}\n\`\`\``
  );
}

export function renderRunError(input: {
  errorMessage: string;
  repo: { owner: string; name: string };
  agentDiagnostic: AgentDiagnostic | undefined;
  /** the run is spending Polaris's Router wallet (a proxy key was minted), not
   * the user's own provider credential. `payload.proxyModel` at both call
   * sites. */
  routerActive: boolean;
}): RenderedRunError {
  // reclassify mid-run OpenRouter "key budget exhausted" as BillingError so
  // the user gets the same actionable copy as a /api/proxy-token 402.
  //
  // gated on `routerActive`: the identical wire text is emitted when a BYOK
  // customer's OWN OpenRouter wallet runs dry, and sending them to top up a
  // Polaris Router balance they don't use is advice that cannot work. on a BYOK
  // run this falls through to the provider-billing branch below, which now
  // matches the same shapes and links openrouter.ai instead. see #1135.
  const billingError =
    input.routerActive && isRouterKeylimitExhaustedError(input.errorMessage)
      ? new BillingError(input.errorMessage, { code: "router_keylimit_exhausted" })
      : null;

  if (billingError) {
    const body = formatBillingErrorSummary(billingError, input.repo.owner);
    return { summary: body, comment: body };
  }

  // model-access gate (explicit `--model`/family flag the run can't serve):
  // the thrown message already IS the rendered markdown body (built by
  // `buildModelAccessError`), so surface it verbatim on both surfaces.
  if (input.errorMessage.includes(MODEL_ACCESS_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // run-context couldn't hand over Polaris-stored secrets. same verbatim
  // contract as the model-access body above, and checked before the api-key
  // branch below so it can't be rewritten into a "go add a key" CTA - the key
  // is already there.
  if (input.errorMessage.includes(SECRETS_UNAVAILABLE_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // gated on isHang because the harness sets `agentDiagnostic` on entry, so
  // any non-hang throw that hits the outer catch (e.g. post-success
  // output_schema validator, or a late cleanup throw after the run already
  // succeeded) would otherwise render "Polaris failed" with stale event
  // counts and silently drop the real errorMessage.
  const isHang =
    input.errorMessage.startsWith("activity timeout") ||
    input.errorMessage.startsWith("agent still pending");
  const hangBody = isHang
    ? formatAgentHangBody({
        diagnostic: input.agentDiagnostic,
        isHang: true,
        errorMessage: input.errorMessage,
      })
    : null;

  // BYOK provider billing-exhausted (DeepSeek "Insufficient Balance",
  // Anthropic "credit balance is too low", OpenCode Zen `CreditsError` /
  // `FreeUsageLimitError`, Gemini "spending cap"). distinct from the Router
  // billing branches above - Router uses `BillingError`, this uses the agent
  // log payload classified by `isProviderBillingExhausted`. see #835.
  //
  // checked BEFORE api-key auth: providers commonly return 401 (DeepSeek,
  // Gemini) or include `"API Error: 401"` in the error body for billing
  // exhaustion, which `isApiKeyAuthError` would otherwise match - surfacing
  // a "rotate your key" CTA when the actual fix is "top up credits".
  if (isProviderBillingExhausted(input.errorMessage)) {
    const body = formatProviderBillingExhausted({ errorMessage: input.errorMessage });
    return { summary: `### ❌ Polaris failed\n\n${body}`, comment: body };
  }

  const apiKeySource = hangBody ?? input.errorMessage;
  const apiKeyErrorSummary = isApiKeyAuthError(apiKeySource)
    ? formatApiKeyErrorSummary({
        owner: input.repo.owner,
        name: input.repo.name,
        raw: apiKeySource,
      })
    : null;

  if (apiKeyErrorSummary) {
    return { summary: apiKeyErrorSummary, comment: apiKeyErrorSummary };
  }

  if (isProviderModelNotFoundError(input.errorMessage)) {
    const body = formatProviderModelNotFoundSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: body, comment: body };
  }

  if (isNoProviderAvailableError(input.errorMessage)) {
    const body = formatNoProviderAvailableSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Polaris failed\n\n${body}`, comment: body };
  }

  // BEFORE context overflow, and this order is the point of the branch: a
  // provider refusing a request for exceeding the account's allowance reads to
  // the agent harness as overflow, so it compacts, is refused again, and stops
  // with a give-up that says the session was too large. Both messages then
  // arrive as one string, and the plan cap is the limit that was actually
  // binding - the model's window was never reached.
  const rateCeiling = parseRequestTooLargeRefusal(input.errorMessage);
  if (rateCeiling) {
    const body = formatRateCeilingSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
      refusal: rateCeiling,
    });
    return { summary: `### ❌ Polaris failed\n\n${body}`, comment: body };
  }

  // actionable, so it renders identically on both surfaces rather than
  // collapsing the comment to the hang/generic one-liner. see #1116.
  if (isContextOverflowError(input.errorMessage)) {
    const body = formatContextOverflowSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Polaris failed\n\n${body}`, comment: body };
  }

  if (hangBody) {
    // a hang masking billing exhaustion (#778) renders an actionable top-up
    // CTA inside `hangBody` - keep that in the comment. every other hang is
    // non-actionable noise for the average user, so the comment collapses to
    // a one-liner and the diagnostic stays in the Actions job summary.
    const isBillingExhausted =
      input.agentDiagnostic?.lastProviderError === "provider billing exhausted";
    return {
      summary: `### ❌ Polaris failed\n\n${hangBody}`,
      comment: isBillingExhausted ? hangBody : formatMinimalFailureComment(input.repo),
    };
  }

  const genericBody = formatGenericFailure(input.errorMessage);
  return {
    summary: `### ❌ Polaris failed\n\n${genericBody}`,
    comment: formatMinimalFailureComment(input.repo),
  };
}
