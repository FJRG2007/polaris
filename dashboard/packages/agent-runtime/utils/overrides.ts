/**
 * Parse + apply the action's `unsafe_overrides` input - a JSON object of env
 * var overrides that mutate `process.env` at the start of a run. Designed for
 * e2e testing / debugging from `workflow_dispatch`; only callers with
 * `actions:write` on the repo can supply it.
 *
 * The `unsafe` prefix is load-bearing: GH Actions echoes the value verbatim
 * in the runner's step-header log, so the raw JSON (including any values
 * passed in) is visible to anyone with `actions:read` on the calling repo.
 * Treat the run log as compromised for any value placed in `unsafe_overrides`.
 */

import * as core from "@actions/core";

/**
 * Names refused even when present in the input. Overriding these would let a
 * caller escape polaris's scope (GITHUB_TOKEN), break runner internals
 * (ACTIONS_RUNTIME_*), forge OIDC tokens (ACTIONS_ID_TOKEN_REQUEST_*), or
 * substitute our server-side auth (POLARIS_API_SECRET). Customer-facing
 * provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN,
 * etc.) are intentionally NOT denied - overriding those is the use case.
 */
export const DENIED_OVERRIDE_NAMES: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_CACHE_URL",
  "POLARIS_API_SECRET",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
]);

export interface ApplyOverridesResult {
  applied: string[];
  denied: string[];
}

/** Parse the JSON input. Returns `{}` for empty/whitespace. Throws on shape errors. */
export function parseOverrides(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `invalid UNSAFE_OVERRIDES: not valid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid UNSAFE_OVERRIDES: must be a JSON object`);
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(
        `invalid UNSAFE_OVERRIDES: key "${key}" must have a string value (got ${typeof value})`
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Mutate `params.env` in place with the supplied JSON overrides, skipping any
 * names in `DENIED_OVERRIDE_NAMES`. Each applied value is registered with
 * `core.setSecret` so the runner masks it in subsequent log output, and the
 * raw `UNSAFE_OVERRIDES` env var is deleted so spawned subprocesses don't
 * inherit the original JSON (which would defeat both the deny-list and the
 * masking by exposing the values verbatim).
 *
 * Returns the applied/denied breakdown so the caller can render an audit log.
 */
export function applyOverrides(params: {
  raw: string;
  env: NodeJS.ProcessEnv;
}): ApplyOverridesResult {
  const overrides = parseOverrides(params.raw);
  const applied: string[] = [];
  const denied: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (DENIED_OVERRIDE_NAMES.has(key)) {
      denied.push(key);
      continue;
    }
    if (value.length > 0) core.setSecret(value);
    params.env[key] = value;
    applied.push(key);
  }
  delete params.env.UNSAFE_OVERRIDES;
  return { applied, denied };
}
