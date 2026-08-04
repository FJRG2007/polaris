// Shared helpers for the OpenCode agent harnesses (`./opencode.ts` v1 and
// `./opencode.ts` v2). Pure config / model-registry / install glue -
// nothing here touches the NDJSON event loop, which differs between v1 and v2.
//
// Once v1 is deleted post-burn-in this module collapses back into v2; until
// then it keeps both runners synchronized so a config drift can't make v1 a
// silently-broken fallback.

import {
  modelAliases,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_BASE_URL_ENV,
  OPENAI_COMPATIBLE_CONTEXT_ENV,
  OPENAI_COMPATIBLE_MAX_OUTPUT_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
} from "../models.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { getAuthorizedModels } from "../utils/openCodeModels.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { REVIEWER_AGENT_NAME, REVIEWER_SYSTEM_PROMPT } from "./reviewer.ts";
import { deriveSubagentModels } from "./subagentModels.ts";

// ── config ─────────────────────────────────────────────────────────────────────

export type OpenCodeConfig = {
  mcp?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  model?: string;
  enabled_providers?: string[];
  [key: string]: unknown;
};

interface OpenAICompatibleProviderEntry {
  npm: string;
  name: string;
  options: { baseURL: string | undefined; apiKey: string | undefined };
  models: Record<string, { name: string; limit: ModelLimit }>;
}

interface ModelLimit {
  context: number;
  output: number;
}

/**
 * Per-model token limits for the injected provider. opencode carries no models.dev
 * metadata for a user-supplied endpoint, so an absent `limit` defaults to
 * `{context: 0, output: 0}` (`provider/provider.ts`) and that zero costs two
 * things: `maxOutputTokens` falls back to `OUTPUT_TOKEN_MAX` and sends
 * `max_tokens: 32000` - rejected by any model with a smaller completion cap
 * (gpt-4o-mini: "max_tokens is too large: 32000. This model supports at most
 * 16384") - and `isOverflow` short-circuits on `limit.context === 0`
 * (`session/overflow.ts`), silently disabling auto-compaction for the whole run.
 *
 * Both env vars are therefore required by `validateOpenAICompatibleSetup`, which
 * runs before the agent and rejects non-numeric values, so they parse here.
 */
function openAICompatibleLimit(): ModelLimit {
  return {
    context: Number(process.env[OPENAI_COMPATIBLE_CONTEXT_ENV]),
    output: Number(process.env[OPENAI_COMPATIBLE_MAX_OUTPUT_ENV]),
  };
}

/**
 * OpenAI-compatible provider block for OPENCODE_CONFIG_CONTENT. opencode has no
 * native provider for an arbitrary gateway, so inject one via
 * `@ai-sdk/openai-compatible` when the run targets `openai-compatible/<model>`;
 * `{}` otherwise so the caller can spread it unconditionally. base URL + key are
 * guaranteed present by `validateOpenAICompatibleSetup`.
 */
export function openAICompatibleProvider(
  model: string | undefined
): Record<string, OpenAICompatibleProviderEntry> {
  const prefix = `${OPENAI_COMPATIBLE_PROVIDER}/`;
  if (!model?.startsWith(prefix)) return {};
  const modelId = model.slice(prefix.length);
  return {
    [OPENAI_COMPATIBLE_PROVIDER]: {
      npm: "@ai-sdk/openai-compatible",
      name: "OpenAI-compatible",
      options: {
        // trailing slash would double up against opencode's `/chat/completions` join
        baseURL: process.env[OPENAI_COMPATIBLE_BASE_URL_ENV]?.replace(/\/$/, ""),
        apiKey: process.env[OPENAI_COMPATIBLE_API_KEY_ENV],
      },
      models: { [modelId]: { name: modelId, limit: openAICompatibleLimit() } },
    },
  };
}

// OpenRouter sub-providers that serve Kimi K2 WITHOUT Moonshot's Enforcer
// (schema-constrained decoding), so they silently drop optional tool-call
// params after the reasoning phase (SGLang #12932). ignoring them keeps Kimi
// on a good route (Fireworks, Novita, etc.). needs upkeep as OpenRouter's
// roster shifts. see wiki/review-approval.md.
const KIMI_ENFORCERLESS_PROVIDERS = ["siliconflow", "together"];

/**
 * Build the `provider.openrouter.models[id].options` map that pins every Kimi
 * K2 OpenRouter alias away from the Enforcer-less providers via OpenRouter's
 * `provider: {ignore:[...]}` routing directive. Sourced from the model registry
 * so a Kimi alias/route change in `action/models.ts` flows through automatically.
 *
 * Wiring: the per-model `options` object merges into the request options
 * (opencode `session/llm/request.ts` `mergeOptions(base, model.options)`),
 * gets wrapped under `providerOptions.openrouter` (`provider/transform.ts`
 * `sdkKey("@openrouter/ai-sdk-provider") === "openrouter"`), and the OpenRouter
 * AI-SDK provider spreads everything under `providerOptions.openrouter` straight
 * into the request body (`@openrouter/ai-sdk-provider` `doStream`/`doGenerate`),
 * so `provider` lands as the top-level routing object OpenRouter expects.
 */
export function kimiOpenRouterProviderOverrides(): Record<string, { options: object }> {
  return Object.fromEntries(
    modelAliases
      .map((a) => a.openRouterResolve)
      .filter((r): r is string => r?.includes("kimi") ?? false)
      .map((r) => [
        r.replace(/^openrouter\//, ""),
        { options: { provider: { ignore: KIMI_ENFORCERLESS_PROVIDERS } } },
      ])
  );
}

/**
 * Read-only `reviewer` subagent for lens-based review. Non-mutative +
 * non-recursive - enforced by the system prompt in reviewer.ts.
 *
 * Per-subagent `model:` override is driven by the registry in
 * `action/models.ts` via each alias's `subagentModel` field. Currently wired:
 * Anthropic opus → sonnet, OpenAI gpt-sol-pro → gpt-sol and gpt-sol → gpt-terra, Google
 * gemini-pro → gemini-flash. Other providers inherit (no override).
 */
export function buildReviewerAgentConfig(
  orchestratorModel: string | undefined
): Record<string, unknown> {
  const overrides = deriveSubagentModels(orchestratorModel);
  return {
    [REVIEWER_AGENT_NAME]: {
      description:
        "Read-only review subagent for lens-based code review (correctness, security, billing-subsystem, etc.). " +
        "Reads only - no writes, no state-changing shell or MCP calls, no nested subagent dispatch.",
      mode: "subagent",
      prompt: REVIEWER_SYSTEM_PROMPT,
      ...(overrides.reviewer !== undefined ? { model: overrides.reviewer } : {}),
    },
  };
}

// ── install ────────────────────────────────────────────────────────────────────

/**
 * Install the opencode-ai npm tarball and return the path to the executable.
 *
 * The bin path differs by version: v1.4.x and earlier shipped `bin/opencode`;
 * v1.14+ renames the platform-specific binary to `bin/opencode.exe` for every
 * OS via the postinstall script. Callers pass the binPath that matches their
 * pinned version so a v1↔v2 swap can't silently install the wrong file.
 */
export async function installOpencodeCli(params: { binPath: string }): Promise<string> {
  return await installFromNpmTarball({
    packageName: "opencode-ai",
    version: getDevDependencyVersion("opencode-ai"),
    executablePath: params.binPath,
    installDependencies: true,
  });
}

// ── model auto-select fallback ──────────────────────────────────────────────────
//
// steps 1-2 of model resolution (POLARIS_MODEL env, slug resolution) happen
// in resolveModel() in utils/agent.ts before the agent runs. this is step 3:
// auto-select using the authorized model set captured in main.ts via
// `opencode models` introspection.

// the console picker is locked for Router accounts without a payment method -
// exactly the accounts that land here once their wallet runs dry.
const AUTO_SELECT_WARNING =
  "select a model explicitly in Polaris to avoid this - " +
  "if the picker is locked, this run had no Polaris Router funding: add a card or top up your credit.";

export function autoSelectModel(): string | undefined {
  const authorized = getAuthorizedModels();
  if (authorized.size > 0) {
    // skip hidden aliases (internal subagent-tier targets like opencode/gpt-5.4)
    // and fallback aliases (deprecated or temporarily unavailable - they must
    // resolve through to their replacement, never run as-is). mirrors the
    // selectable-list filter (`!a.fallback && !a.hidden`) in
    // components/ModelSelector.tsx and action/commands/init.ts.
    const match =
      modelAliases.find(
        (a) => !a.hidden && !a.fallback && a.preferred && authorized.has(a.resolve)
      ) ?? modelAliases.find((a) => !a.hidden && !a.fallback && authorized.has(a.resolve));
    if (match) {
      log.info(
        `» model: ${match.resolve} (auto-selected${match.preferred ? " - preferred" : ""} curated match)`
      );
      log.warning(`» model auto-selected. ${AUTO_SELECT_WARNING}`);
      return match.resolve;
    }
    log.info(
      `» opencode has ${authorized.size} models but none match curated aliases - letting OpenCode auto-select`
    );
  }

  log.warning(`» no model resolved. letting OpenCode auto-select. ${AUTO_SELECT_WARNING}`);
  return undefined;
}
