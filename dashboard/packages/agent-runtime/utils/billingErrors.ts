/**
 * Classification and copy for the two ways the control plane can refuse a run
 * outright, plus the mid-run case where a model provider stops answering.
 *
 * Polaris bills nobody. Models run on the operator's own provider keys, held in
 * Integrations, so there is no card, balance or plan behind any of this. What
 * survives from that shape is the distinction that actually matters to a reader
 * of a pull request: a refusal somebody can act on (`BillingError` - the key is
 * missing, or the provider says the account behind it is out of credit) versus
 * one nobody can (`TransientError` - the instance or the provider is briefly
 * unavailable, and the next dispatch will probably work).
 *
 * Both are raised by utils/proxy.ts on the way in and by
 * utils/runErrorRenderer.ts when a provider returns 402 mid-run. The bodies are
 * markdown, written into both the job summary and the progress comment.
 */

import { settingsLink } from "./apiUrl.ts";

/**
 * A refusal the operator can resolve: no provider key for the configured model,
 * or a provider that rejected the key it was given.
 *
 * `code` discriminates the cases the control plane names explicitly; `null` is
 * an unclassified provider refusal, which is rendered generically rather than
 * guessed at.
 */
export class BillingError extends Error {
  code: string | null;

  constructor(message: string, opts: { code?: string | null } = {}) {
    super(message);
    this.name = "BillingError";
    this.code = opts.code ?? null;
  }
}

/**
 * A failure that is nobody's to fix: the instance answered 503, or the provider
 * did. Framed separately so a reader does not go looking for a key that is
 * perfectly fine, and so the non-zero exit lets a workflow apply its own retry.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Why a run stopped before it started, and where to go about it.
 *
 * `commercial` is the control plane declining to run this repository at all,
 * which in Polaris means one thing: the repository is not enabled for agents,
 * or its owner turned it off. `subscription_unpaid` is the model provider
 * refusing the operator's key.
 */
export function commercialPaywallBody(params: {
  reason: "commercial" | "subscription_unpaid";
  ownerLogin: string;
  url: string;
}): string {
  if (params.reason === "commercial") {
    return [
      `**Agent runs are not enabled for ${params.ownerLogin}.**`,
      "",
      "Enable this repository in Polaris to let it run, or remove the workflow if it was left behind.",
      "",
      params.url,
    ].join("\n");
  }
  params.reason satisfies "subscription_unpaid";
  return [
    `**The model provider refused the key configured for ${params.ownerLogin}.**`,
    "",
    "Check the provider credential in Integrations, and that the account behind it still has credit.",
    "",
    params.url,
  ].join("\n");
}

/** The same refusal, rendered for a run that had already been dispatched. */
export function formatCommercialGateSummary(params: {
  reason: "commercial" | "subscription_unpaid";
  ownerLogin: string;
}): string {
  return commercialPaywallBody({
    reason: params.reason,
    ownerLogin: params.ownerLogin,
    url: settingsLink("Open Agents"),
  });
}

/**
 * Render a refusal the operator can act on.
 *
 * Quiet rather than alarmist, and specific: "no key for this provider" and "the
 * provider says this account is out of credit" are different problems with
 * different fixes, and lumping them together is what sends somebody to re-paste
 * a key that was never the issue.
 */
export function formatBillingErrorSummary(error: BillingError, owner: string): string {
  if (error.code === "no_provider_key") {
    return [
      "**No provider key is configured for this model.**",
      "",
      "Add a credential for the model's provider in Integrations, or pick a model whose provider is already connected.",
      "",
      settingsLink("Open Agents"),
    ].join("\n");
  }

  if (error.code === "provider_credit_exhausted") {
    return [
      "**The model provider stopped this run: the account behind the key is out of credit.**",
      "",
      "Top the account up with the provider directly. Polaris does not hold a balance, it only presents the key it was given.",
      "",
      settingsLink("Open Agents"),
    ].join("\n");
  }

  if (error.code === "commercial_plan_required") {
    return formatCommercialGateSummary({ reason: "commercial", ownerLogin: owner });
  }

  if (error.code === "subscription_unpaid") {
    return formatCommercialGateSummary({ reason: "subscription_unpaid", ownerLogin: owner });
  }

  return [
    "**The model provider refused this run.**",
    "",
    error.message,
    "",
    settingsLink("Check the provider credential", owner),
  ].join("\n");
}

/** Render a failure that is expected to clear on its own. */
export function formatTransientErrorSummary(error: TransientError, owner: string): string {
  return [
    "**The run could not reach its model.**",
    "",
    error.message,
    "",
    `Usually transient, and the next dispatch should succeed. If it keeps happening, check the provider's status and the credential in ${settingsLink("Agents", owner)}.`,
  ].join("\n");
}
