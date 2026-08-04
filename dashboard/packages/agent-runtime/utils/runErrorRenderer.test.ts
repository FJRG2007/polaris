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
