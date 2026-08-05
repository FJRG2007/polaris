import { describe, expect, it } from "vitest";
import { renderRunError } from "./runErrorRenderer.ts";

const repo = { owner: "acme", name: "widget" };

describe("renderRunError BYOK provider billing exhausted (#835)", () => {
  const deepseekRaw =
    '» provider error detected (provider billing exhausted): ERROR providerID=deepseek modelID=deepseek-v4-pro error={"name":"AI_APICallError","message":"Insufficient Balance"}';

  const anthropicRaw =
    "APIError: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

  const opencodeZenRaw = "CreditsError: account out of free usage";

  it("renders DeepSeek billing-exhausted with provider-specific dashboard link", () => {
    const result = renderRunError({
      errorMessage: deepseekRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("`deepseek` account is out of credit");
    expect(result.summary).toContain("https://platform.deepseek.com/top_up");
    expect(result.summary).toContain("### ❌ Polaris failed");
    expect(result.comment).toContain("`deepseek` account is out of credit");
    expect(result.comment).not.toContain("### ❌ Polaris failed");
  });

  it("matches Anthropic 'credit balance is too low' (#835 Anthropic case)", () => {
    const result = renderRunError({
      errorMessage: anthropicRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain("out of credit");
  });

  it("matches OpenCode Zen CreditsError shape", () => {
    const result = renderRunError({
      errorMessage: opencodeZenRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain("out of credit");
  });

  it("falls through to a generic CTA when providerID cannot be parsed", () => {
    const result = renderRunError({
      errorMessage: "Insufficient balance - provider response with no providerID tag",
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain("Your provider account is out of credit");
    expect(result.comment).not.toContain("Your your");
    expect(result.comment).toContain("Top up your provider account");
  });
});

describe("renderRunError ProviderModelNotFoundError (#816)", () => {
  const staleFreeRaw =
    'ProviderModelNotFoundError: {"providerID":"opencode","modelID":"retired-free-model","suggestions":["deepseek-v4-flash-free"]}';

  const bigPickleRaw =
    'ProviderModelNotFoundError: {"providerID":"opencode","modelID":"big-pickle","suggestions":[]}';

  it("renders actionable copy for a stale free model id", () => {
    const result = renderRunError({
      errorMessage: staleFreeRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("no longer available in OpenCode's catalog");
    expect(result.summary).toContain("`acme/widget`");
    expect(result.summary).toContain("retired-free-model");
    expect(result.comment).toBe(result.summary);
  });

  it("renders the same classifier when big-pickle is missing from opencode catalog", () => {
    const result = renderRunError({
      errorMessage: bigPickleRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("no longer available in OpenCode's catalog");
    expect(result.summary).toContain("big-pickle");
  });

  it("does not misclassify unrelated failures as model-catalog errors", () => {
    const result = renderRunError({
      errorMessage: "activity timeout after 900s",
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).not.toContain("no longer available in OpenCode's catalog");
  });
});

/**
 * The surface the user actually reads. Four runs against FJRG2007/experiments
 * were told they had exceeded a 131,072-token window they never approached,
 * and to split a PR that did not exist - the run was triggered by an issue.
 * What had happened is that Groq's free tier allows 8,000 tokens a minute.
 */
describe("renderRunError plan rate ceiling", () => {
  const groq =
    "provider error: Session too large to compact - context exceeds model limit even after " +
    "stripping media\n\nThe provider refused the request: Request too large for model " +
    "`openai/gpt-oss-120b` in organization `org_01hyb8` service tier `on_demand` on tokens " +
    "per minute (TPM): Limit 8000, Requested 53681, please reduce your message size and try " +
    "again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing";

  it("names the cap and what was asked for, in the provider's unit", () => {
    const result = renderRunError({
      errorMessage: groq,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("8,000 tokens per minute (TPM)");
    expect(result.summary).toContain("53,681");
  });

  it("says the limit is the account's, not the model's", () => {
    const result = renderRunError({
      errorMessage: groq,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    // The exact confusion that sent the user looking for a bigger model.
    expect(result.summary).toContain("not on the model");
    expect(result.summary).not.toContain("exceeded the model's context window");
    expect(result.summary).not.toContain("larger context window");
  });

  it("does not advise a smaller job, which cannot get under a per-minute cap", () => {
    const result = renderRunError({
      errorMessage: groq,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("A shorter task will not get under it");
  });

  it("is actionable, so both surfaces carry it", () => {
    const result = renderRunError({
      errorMessage: groq,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("### ❌ Polaris failed");
    expect(result.comment).toContain("capped below what a single request needs");
    expect(result.comment).not.toContain("### ❌ Polaris failed");
  });

  it("leaves a genuine context overflow saying so", () => {
    // No provider refusal to quote, so the classification stands: this really
    // is the model's window, and the advice that follows really does work.
    const result = renderRunError({
      errorMessage:
        "provider error: Session too large to compact - context exceeds model limit even after stripping media",
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("exceeded the model's context window");
    expect(result.summary).not.toContain("capped below");
  });

  it("no longer tells an issue-triggered run to split its PR", () => {
    const result = renderRunError({
      errorMessage: "Prompt is too long",
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("exceeded the model's context window");
    expect(result.summary).not.toContain("split this PR");
  });
});
