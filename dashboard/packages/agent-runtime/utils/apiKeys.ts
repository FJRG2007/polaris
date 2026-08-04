import {
  BEDROCK_MODEL_ID_ENV,
  getModelEnvVars,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_BASE_URL_ENV,
  OPENAI_COMPATIBLE_CONTEXT_ENV,
  OPENAI_COMPATIBLE_MAX_OUTPUT_ENV,
  OPENAI_COMPATIBLE_MODEL_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
  resolveDisplayAlias,
  VERTEX_MODEL_ID_ENV,
} from "../models.ts";
import { settingsLink } from "./apiUrl.ts";
import { getModelsFailure } from "./openCodeModels.ts";
import {
  GOOGLE_CLOUD_PROJECT_ENV,
  readProjectIdFromVertexServiceAccountJson,
  VERTEX_LOCATION_ENV,
  VERTEX_SERVICE_ACCOUNT_JSON_ENV,
} from "./vertex.ts";

/** marker prefix on the throw message for the catch-side reclassification path */
const MISSING_KEY_MARKER = "no API key found";

/**
 * marker for the distinct "run-context couldn't hand over your stored secrets"
 * body. surfaced verbatim by `runErrorRenderer` (same contract as
 * `MODEL_ACCESS_MARKER`) because blaming the user for a transient fetch failure
 * on our side is the wrong CTA - their key is configured and still stored.
 */
export const SECRETS_UNAVAILABLE_MARKER = "couldn't load your Polaris secrets";

/**
 * "you have no key" vs "we couldn't read your key" - same failure to the
 * runner, opposite CTA to the user, so every throw site picks by this flag.
 */
function buildKeyError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
  secretsUnavailable?: boolean | undefined;
}): string {
  return params.secretsUnavailable
    ? buildSecretsUnavailableError(params)
    : buildMissingApiKeyError(params);
}

function buildSecretsUnavailableError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
}): string {  const modelClause = params.model ? ` needed for \`${params.model}\`` : "";

  return [
    `**Polaris ${SECRETS_UNAVAILABLE_MARKER}${modelClause} on this run.** The key is still stored - the runner just couldn't fetch it, so this is a transient failure on our side, not a missing key.`,
    "",
    "**To fix:** re-run the job. If it keeps happening, tell us in Discord.",
    "",
    settingsLink("Model settings", params.owner, params.name),
  ].join("\n");
}

/**
 * Markdown body used for both the thrown error and the formatted PR comment
 * summary. When the configured model is known, names it and the exact env
 * var(s) it needs so the user knows precisely what to fix; otherwise falls
 * back to the generic "any provider key" copy (auto-select path).
 */
function buildMissingApiKeyError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  const envVars = params.model?.includes("/") ? getModelEnvVars(params.model) : [];
  const [primary, ...alternates] = envVars;
  const envVarList = primary
    ? `\`${primary}\`${alternates.length > 0 ? ` (or ${alternates.map((v) => `\`${v}\``).join(" / ")})` : ""}`
    : undefined;

  const lead = envVarList
    ? `**${MISSING_KEY_MARKER}** - this repo is configured to use \`${params.model}\`, which needs ${envVarList}, but the runner has no key for it.`
    : `**${MISSING_KEY_MARKER}** - Polaris needs at least one LLM provider API key (e.g. \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, \`GEMINI_API_KEY\`) configured as a GitHub Actions secret.`;

  return [
    lead,
    "",
    "**To fix:** add the key as a repository secret (referenced from your workflow's `env:` block), or connect the provider in Polaris and pick a model it can serve.",
    "",
    `[Open repo secrets →](${githubSecretsUrl}) · ${settingsLink("Configure model", params.owner, params.name)}`,
  ].join("\n");
}

function buildBedrockSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Bedrock model selected but required configuration is missing: ${params.missing.join(", ")}.

add the missing secret(s) to your GitHub repository at ${githubSecretsUrl}, then reference them in your workflow's \`env:\` block:

  AWS_BEARER_TOKEN_BEDROCK: \${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
  AWS_REGION: \${{ secrets.AWS_REGION }}
  ${BEDROCK_MODEL_ID_ENV}: \${{ secrets.${BEDROCK_MODEL_ID_ENV} }}

\`AWS_BEARER_TOKEN_BEDROCK\` may be substituted with \`AWS_ACCESS_KEY_ID\` + \`AWS_SECRET_ACCESS_KEY\` (and optional \`AWS_SESSION_TOKEN\`) if you prefer access keys.
`;
}

function buildVertexSetupError(params: { owner: string; name: string; missing: string[] }): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Google Vertex AI model selected but required configuration is missing: ${params.missing.join(", ")}.

add the missing secret(s) to your GitHub repository at ${githubSecretsUrl}, then reference them in your workflow's \`env:\` block:

  ${VERTEX_SERVICE_ACCOUNT_JSON_ENV}: \${{ secrets.${VERTEX_SERVICE_ACCOUNT_JSON_ENV} }}
  ${GOOGLE_CLOUD_PROJECT_ENV}: my-project
  ${VERTEX_LOCATION_ENV}: global
  ${VERTEX_MODEL_ID_ENV}: <vertex-model-id>
`;
}

function buildOpenAICompatibleSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `OpenAI-compatible model selected but required configuration is missing: ${params.missing.join(", ")}.

only the API key is sensitive - add it as a secret at ${githubSecretsUrl}. everything else is plain workflow \`env:\`:

  ${OPENAI_COMPATIBLE_BASE_URL_ENV}: https://your-endpoint.example.com/v1
  ${OPENAI_COMPATIBLE_API_KEY_ENV}: \${{ secrets.${OPENAI_COMPATIBLE_API_KEY_ENV} }}
  ${OPENAI_COMPATIBLE_MODEL_ENV}: <model-id>
  ${OPENAI_COMPATIBLE_CONTEXT_ENV}: "128000"
  ${OPENAI_COMPATIBLE_MAX_OUTPUT_ENV}: "16384"

set the last two to the real limits of the model your endpoint serves. Polaris can't
discover them - your endpoint owns the model catalog - and without them completions are
capped at 32000 tokens (rejected outright by models with a smaller cap) and
auto-compaction is disabled, so long runs grow until your endpoint refuses them.
`;
}

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

/** the token limits are numbers, so presence isn't enough - `128k` must fail here. */
function hasPositiveNumberEnvVar(name: string): boolean {
  return Number(process.env[name]) > 0;
}

function validateOpenAICompatibleSetup(params: { owner: string; name: string }): void {
  const missing: string[] = [];
  if (!hasEnvVar(OPENAI_COMPATIBLE_BASE_URL_ENV)) missing.push(OPENAI_COMPATIBLE_BASE_URL_ENV);
  if (!hasEnvVar(OPENAI_COMPATIBLE_API_KEY_ENV)) missing.push(OPENAI_COMPATIBLE_API_KEY_ENV);
  if (!hasEnvVar(OPENAI_COMPATIBLE_MODEL_ENV)) missing.push(OPENAI_COMPATIBLE_MODEL_ENV);
  // required, not optional: opencode has no catalog metadata for a user-supplied
  // endpoint, and an undeclared limit both caps completions at 32000 and disables
  // auto-compaction for the whole run. see openAICompatibleLimit().
  if (!hasPositiveNumberEnvVar(OPENAI_COMPATIBLE_CONTEXT_ENV))
    missing.push(OPENAI_COMPATIBLE_CONTEXT_ENV);
  if (!hasPositiveNumberEnvVar(OPENAI_COMPATIBLE_MAX_OUTPUT_ENV))
    missing.push(OPENAI_COMPATIBLE_MAX_OUTPUT_ENV);

  if (missing.length > 0) {
    throw new Error(
      buildOpenAICompatibleSetupError({ owner: params.owner, name: params.name, missing })
    );
  }
}

function validateBedrockSetup(params: { owner: string; name: string }): void {
  const hasAuth =
    hasEnvVar("AWS_BEARER_TOKEN_BEDROCK") ||
    (hasEnvVar("AWS_ACCESS_KEY_ID") && hasEnvVar("AWS_SECRET_ACCESS_KEY"));

  const missing: string[] = [];
  if (!hasAuth)
    missing.push("AWS_BEARER_TOKEN_BEDROCK (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)");
  if (!hasEnvVar("AWS_REGION")) missing.push("AWS_REGION");
  if (!hasEnvVar(BEDROCK_MODEL_ID_ENV)) missing.push(BEDROCK_MODEL_ID_ENV);

  if (missing.length > 0) {
    throw new Error(buildBedrockSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

function validateVertexSetup(params: { owner: string; name: string }): void {
  const hasAuth = hasEnvVar(VERTEX_SERVICE_ACCOUNT_JSON_ENV);
  const hasProject =
    hasEnvVar(GOOGLE_CLOUD_PROJECT_ENV) ||
    readProjectIdFromVertexServiceAccountJson() !== undefined;

  const missing: string[] = [];
  if (!hasAuth) missing.push(VERTEX_SERVICE_ACCOUNT_JSON_ENV);
  if (!hasProject) missing.push(GOOGLE_CLOUD_PROJECT_ENV);
  if (!hasEnvVar(VERTEX_LOCATION_ENV)) missing.push(VERTEX_LOCATION_ENV);
  if (!hasEnvVar(VERTEX_MODEL_ID_ENV)) missing.push(VERTEX_MODEL_ID_ENV);

  if (missing.length > 0) {
    throw new Error(buildVertexSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

/**
 * Validate that the resolved model can actually be served by the chosen
 * agent. For routing slugs (Bedrock / Vertex) the auth shape is multi-var
 * (auth + region/location + model-id) and `opencode models` doesn't catch
 * gaps in the latter two - keep dedicated setup validators. For the
 * opencode path, the authoritative answer comes from OpenCode's own model
 * introspection (`authorized` set captured in `openCodeModels.ts`). For
 * the claude path, fall back to the static check (`ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN`).
 */
export function validateAgentApiKey(params: {
  agent: { name: string };
  model: string | undefined;
  authorized: Set<string>;
  owner: string;
  name: string;
  /** run-context couldn't hand over Polaris-stored secrets, so a missing key
   * says nothing about what the user actually configured. */
  secretsUnavailable?: boolean | undefined;
}): void {
  if (params.model) {
    const alias = resolveDisplayAlias(params.model);
    if (alias?.routing === "bedrock") {
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }
    if (alias?.routing === "vertex") {
      validateVertexSetup({ owner: params.owner, name: params.name });
      return;
    }

    // openai-compatible keeps its `openai-compatible/` provider prefix through
    // resolution (slug `openai-compatible/byok` → specifier
    // `openai-compatible/<OPENAI_COMPATIBLE_MODEL>`), so one prefix check covers
    // both forms. its custom provider isn't in the opencode `authorized`
    // snapshot (it's injected into OPENCODE_CONFIG_CONTENT only at run time), so
    // validate the env-supplied base URL / key / model directly.
    if (params.model.startsWith(`${OPENAI_COMPATIBLE_PROVIDER}/`)) {
      validateOpenAICompatibleSetup({ owner: params.owner, name: params.name });
      return;
    }

    // raw backend model IDs (post-resolveModel for routing slugs) have no
    // `/`. discriminate by the env-var sentinel, then run the matching
    // setup validator - `opencode models` doesn't help here because the
    // Bedrock/Vertex provider plugins need region/location/model-id wired
    // through env regardless of CLI-side auth.
    if (!params.model.includes("/")) {
      if (process.env[VERTEX_MODEL_ID_ENV]?.trim() === params.model) {
        validateVertexSetup({ owner: params.owner, name: params.name });
        return;
      }
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }

    if (params.agent.name === "opencode") {
      if (params.authorized.has(params.model)) return;
      // an empty authorized set means either "no auth" or "opencode couldn't
      // start" - an unloadable repo config being the usual second case. prefer
      // opencode's own reason over sending the user to their secrets page.
      const reason = getModelsFailure();
      if (reason) throw new Error(reason);
      // `opencode models` can exit 0 having printed only a prefix of its
      // catalog, so a missing entry is not proof the key is absent - a run
      // failed or passed purely on where its slug sorted against the cut. only
      // trust the absence when the model's own env var is unset too.
      if (getModelEnvVars(params.model).some(hasEnvVar)) return;
      throw new Error(
        buildKeyError({
          owner: params.owner,
          name: params.name,
          model: params.model,
          secretsUnavailable: params.secretsUnavailable,
        })
      );
    }

    // claude: single-provider check on the Anthropic auth shapes.
    if (hasEnvVar("ANTHROPIC_API_KEY") || hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN")) return;
    throw new Error(
      buildKeyError({
        owner: params.owner,
        name: params.name,
        model: params.model,
        secretsUnavailable: params.secretsUnavailable,
      })
    );
  }

  // no model configured (auto-select path).
  if (params.agent.name === "opencode") {
    if (params.authorized.size > 0) return;
    // same reasoning as the configured-model branch above: an unloadable repo
    // config empties the model set, and it is the likelier cause here too.
    const reason = getModelsFailure();
    if (reason) throw new Error(reason);
    throw new Error(
      buildKeyError({
        owner: params.owner,
        name: params.name,
        secretsUnavailable: params.secretsUnavailable,
      })
    );
  }
  if (hasEnvVar("ANTHROPIC_API_KEY") || hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN")) return;
  throw new Error(
    buildKeyError({
      owner: params.owner,
      name: params.name,
      secretsUnavailable: params.secretsUnavailable,
    })
  );
}

/**
 * Detect agent-runtime auth failures that should be reformatted as an actionable
 * key-fix CTA before being shown to the user. Covers the shapes we see:
 *   - missing key (validateAgentApiKey throw): contains MISSING_KEY_MARKER
 *   - revoked / invalid key (Claude CLI 401 surfaced via api_error_status):
 *     "Invalid API key · Fix external API key" + similar provider variants
 *   - direct-Anthropic 401 (`Failed to authenticate. API Error: 401 ...
 *     {"type":"error","error":{"type":"authentication_error", ...
 *     "Invalid bearer token"}}`) emitted by the Claude CLI for revoked /
 *     mistyped / rotated `ANTHROPIC_API_KEY`. see #782.
 *   - expired credentials (#931): Bedrock 403 `Failed to authenticate. API
 *     Error: 403 {"Message":"*** has expired"}` (short-lived bearer tokens),
 *     OpenAI OAuth "Your authentication token has expired", and Codex
 *     "Token refresh failed: 401". the Bedrock pattern is anchored to the
 *     Claude CLI emission ("Failed to authenticate. API Error:") so generic
 *     auth chatter in agent stderr can't misclassify a hang as a key error.
 *   - DeepSeek invalid key (#960): `Authentication Fails, Your api key:
 *     ****XXXX is invalid`. anchored to "Your api key: ... is invalid" so it
 *     can't collide with DeepSeek's already-handled `Insufficient balance`
 *     billing shape (which routes to formatProviderBillingExhausted).
 *   - org-disabled Claude subscription (#1072): `Your organization has
 *     disabled Claude subscription access for Claude Code`, an entitlement
 *     denial with its own remedy - see isClaudeSubscriptionDisabledError.
 */
export function isApiKeyAuthError(text: string): boolean {
  if (!text) return false;
  return (
    text.includes(MISSING_KEY_MARKER) ||
    /Invalid API key/i.test(text) ||
    /\bUser not found\b/i.test(text) ||
    /\bInvalid authentication\b/i.test(text) ||
    /authentication_error/i.test(text) ||
    /Invalid bearer token/i.test(text) ||
    /api_error_status\s*=\s*401/i.test(text) ||
    /API Error:\s*401/i.test(text) ||
    /Failed to authenticate\. API Error:/i.test(text) ||
    /Your api key:.*is invalid/i.test(text) ||
    isClaudeSubscriptionDisabledError(text) ||
    isClaudeSessionLimitError(text) ||
    isOAuthCredentialExpiredError(text)
  );
}

/**
 * Dead OAuth-connection credential - the provider is telling us the token
 * itself is finished (expired, invalidated, revoked, or unrecognised), and the
 * only fix is to re-authenticate the connection (`polaris auth <provider>`),
 * never to rotate a repo-secret API key. `formatApiKeyErrorSummary` renders
 * distinct copy for the whole class.
 *
 * Match the SHAPE, not the sentence. Four prior issues (#931, #1041, #1072,
 * #1122) each landed one more literal and the next provider rewording walked
 * straight through, so these patterns are parameterised over the two things
 * that vary - which token noun the provider uses, and which terminal state it
 * reports. Still deliberately narrow on the noun ("authentication token" /
 * "OAuth access token", never bare "token") so a GitHub installation-token
 * expiry can't be misread as an LLM credential problem.
 */
export function isOAuthCredentialExpiredError(text: string): boolean {
  return (
    /(?:authentication|OAuth access) token has (?:expired|been (?:invalidated|revoked))/i.test(
      text
    ) ||
    // the provider no longer recognises the token at all (#1086) - same dead
    // credential, phrased as a lookup miss rather than a state transition.
    /Could not find the appropriate key in your authentication token/i.test(text) ||
    /Token refresh failed/i.test(text)
  );
}

/**
 * Anthropic entitlement denial for Claude Pro/Max subscription auth (#1072):
 * an org admin turned off Claude Code subscription access. no credential the
 * user controls fixes it, so it gets its own copy instead of the re-auth CTA.
 */
export function isClaudeSubscriptionDisabledError(text: string): boolean {
  return /disabled Claude subscription access/i.test(text);
}

/**
 * Claude Pro/Max usage cap (#1104): `You've hit your session limit · resets
 * 9:20pm (UTC)`. A quota condition, not a credential one - the subscription is
 * healthy and will work again at the reset.
 *
 * The rungs are ENUMERATED rather than matched with a wildcard. A `[A-Za-z]+`
 * slot also swallows OpenAI Codex's `You've hit your usage limit.`, and the copy
 * this gates hardcodes "Your Claude subscription" and an `ANTHROPIC_API_KEY`
 * remedy - so a ChatGPT-subscription run (a supported configuration; see
 * `installCodexAuth`) would be told to fix a subscription it does not have.
 * That is the exact wrong-CTA defect this classifier exists to prevent.
 *
 * Capture group 1 is the reset stamp when present, bounded by quote/newline
 * because the message often arrives inside a JSON dump - a greedy `.+` there
 * renders `9:20pm (UTC)","type":...` into the user-facing copy.
 */
const CLAUDE_SESSION_LIMIT_PATTERN =
  /hit your (?:session|weekly|five-hour|Opus|Sonnet|Haiku)\s+limit(?:\s*·\s*resets\s+([^"\n]+))?/i;

export function isClaudeSessionLimitError(text: string): boolean {
  return CLAUDE_SESSION_LIMIT_PATTERN.test(text);
}

/**
 * Friendly Markdown summary for both the missing-key and invalid-key cases.
 * Used in the catch / result-failure paths in `main.ts` to overwrite the raw
 * agent error before it's posted to the PR progress comment.
 */
export function formatApiKeyErrorSummary(params: {
  owner: string;
  name: string;
  raw: string;
}): string {
  if (params.raw.includes(MISSING_KEY_MARKER)) {
    // a verbatim validateAgentApiKey throw is already the full rendered body
    // (model-specific copy included) - pass it through. only rebuild the
    // generic copy when the marker is embedded in surrounding noise (e.g. a
    // hang body that swallowed the original message).
    if (params.raw.startsWith(`**${MISSING_KEY_MARKER}**`)) return params.raw;
    return buildMissingApiKeyError({ owner: params.owner, name: params.name });
  }

  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  // the subscription hit its usage cap. checked before every credential branch
  // below: nothing is wrong with the token, so a "rotate your key" CTA would
  // send the user to fix something that isn't broken. lead with the reset time
  // - it's the only thing that stops them re-triggering into the same wall.
  if (isClaudeSessionLimitError(params.raw)) {
    const reset = CLAUDE_SESSION_LIMIT_PATTERN.exec(params.raw)?.[1]?.trim();
    const resets = reset ? ` It resets at **${reset}**.` : "";
    return [
      `**Your Claude subscription has hit its usage limit.**${resets} Re-trigger Polaris after the reset, or add an \`ANTHROPIC_API_KEY\` repo secret - Polaris routes around an exhausted subscription automatically when one is present.`,
      "",
      `[Add repo secret →](${githubSecretsUrl}) · ${settingsLink("Model settings", params.owner, params.name)}`,
    ].join("\n");
  }

  // an org admin disabled Claude Code subscription access - re-authenticating
  // can't clear an entitlement flag, so name the two remedies the provider's
  // own message spells out.
  if (isClaudeSubscriptionDisabledError(params.raw)) {
    return [
      `**Your organization has disabled Claude subscription access for Claude Code.** Ask your Claude organization's admin to re-enable it in the Claude Console, or set an \`ANTHROPIC_API_KEY\` for this repo instead, then re-trigger the run.`,
      "",
      `[Add repo secret →](${githubSecretsUrl}) · ${settingsLink("Model settings", params.owner, params.name)}`,
    ].join("\n");
  }

  // OAuth-connection credentials (Codex / provider OAuth) aren't repo
  // secrets - "rotate the key, update the GitHub secret" is wrong advice.
  if (isOAuthCredentialExpiredError(params.raw)) {
    return [
      `**Your provider OAuth credential has expired or been revoked.** Re-authenticate the provider connection (e.g. \`polaris auth claude\` / \`polaris auth codex\`), then re-trigger the run.`,
      "",
      settingsLink("Model settings", params.owner, params.name),
    ].join("\n");
  }

  return [
    `**Your LLM provider API key was rejected.** Rotate the key in your provider dashboard, then update the matching GitHub Actions secret.`,
    "",
    `[Update repo secret →](${githubSecretsUrl}) · ${settingsLink("Model settings", params.owner, params.name)}`,
  ].join("\n");
}
