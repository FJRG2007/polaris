/**
 * Model-access gate for explicitly-requested per-run models (`--opus`,
 * `--model=<slug>`). An explicit model the run can't serve hard-fails *before*
 * the agent starts with one consistent, reason-tailored error.
 *
 * The provenance split lives upstream: `payload.modelExplicit` is true only for
 * a flag in the triggerer's own @polaris prompt. A standing default (repo
 * setting, a model flag in org/repo `baseInstructions`, or a trigger's fallback
 * instructions) keeps `modelExplicit = false` and never reaches the error
 * branches here - a missing key for a standing default surfaces through
 * `validateAgentApiKey`'s missing-key error instead (#938).
 *
 * `decideModelAccess` is pure (no env / IO) so the branching is unit-testable;
 * `buildModelAccessError` renders the user-facing markdown that `main.ts`
 * throws and `runErrorRenderer.ts` re-surfaces on both run surfaces.
 */

import {
  isOssAllowedModel,
  OPENAI_COMPATIBLE_PROVIDER,
  OSS_MODEL_ALLOWLIST,
  resolveDisplayAlias,
  resolveOpenRouterModel,
} from "../models.ts";
import { settingsLink } from "./apiUrl.ts";

export type ModelAccessReason = "oss" | "byok_no_key" | "router";

export type ModelAccessDecision =
  | { kind: "ok" }
  /** route through the Router/OSS proxy, re-targeted to the requested model. */
  | { kind: "proxy"; target: string }
  /** run BYOK with the requested model - clear the minted proxy target. */
  | { kind: "byok" }
  | { kind: "error"; reason: ModelAccessReason };

/**
 * decide whether an (already-resolved) requested model can run, and how.
 *
 * - non-explicit / no model → `ok` (caller's missing-key validation applies).
 * - proxy active + OSS → the funded subsidy target and anything else on
 *   `OSS_MODEL_ALLOWLIST` route; a model off the list needs the repo's own key
 *   (`byok`) else `error("oss")`. the allowlist arm is what keeps
 *   `--model=<allowlisted>` from hard-failing on a pick the console offers.
 * - proxy active + Router → honor any Router-servable model (`proxy`); fall to
 *   BYOK when locally authorized, else `error("router")`.
 * - no proxy → the resolved model must be locally authorized, else
 *   `error("byok_no_key")`.
 */
export function decideModelAccess(input: {
  modelExplicit: boolean;
  model: string | undefined;
  oss: boolean;
  proxyActive: boolean;
  subsidyTarget: string | undefined;
  resolvedModel: string | undefined;
  authorized: Set<string>;
}): ModelAccessDecision {
  if (!input.modelExplicit || !input.model) return { kind: "ok" };

  // raw routing slugs (bedrock/vertex - no provider/model slash) and the
  // openai-compatible backend (provider-prefixed but absent from the opencode
  // `authorized` snapshot) are validated by their own setup checks. discriminate
  // openai-compatible on the RESOLVED specifier, matching `validateAgentApiKey`:
  // both the catalog slug and a raw `openai-compatible/<id>` specifier resolve to
  // the same prefixed form, so one check covers both and the two gates can't
  // disagree about what they'll admit.
  const byokAuthorized =
    !!input.resolvedModel &&
    (input.authorized.has(input.resolvedModel) ||
      !input.resolvedModel.includes("/") ||
      input.resolvedModel.startsWith(`${OPENAI_COMPATIBLE_PROVIDER}/`));

  if (input.proxyActive) {
    const target = resolveOpenRouterModel(input.model);
    if (input.oss) {
      if (target && (target === input.subsidyTarget || isOssAllowedModel(input.model))) {
        return { kind: "proxy", target };
      }
      if (byokAuthorized) return { kind: "byok" };
      return { kind: "error", reason: "oss" };
    }
    if (target) return { kind: "proxy", target };
    if (byokAuthorized) return { kind: "byok" };
    return { kind: "error", reason: "router" };
  }

  if (byokAuthorized) return { kind: "ok" };
  return { kind: "error", reason: "byok_no_key" };
}

/** marker on the throw message so `runErrorRenderer` can reclassify it. */
export const MODEL_ACCESS_MARKER = "requested model is not available";

/** display names of the OSS-funded set, for the `oss` failure copy. */
function ossAllowedLabels(): string {
  return OSS_MODEL_ALLOWLIST.map(
    (slug) => `\`${resolveDisplayAlias(slug)?.displayName ?? slug}\``
  ).join(", ");
}

/**
 * render the model-access failure body (used for both the thrown error and the
 * PR comment / job summary). one shape, reason-branched why → CTA.
 */
export function buildModelAccessError(input: {
  reason: ModelAccessReason;
  model: string;
  owner: string;
  name: string;
}): string {
  const secretsUrl = `https://github.com/${input.owner}/${input.name}/settings/secrets/actions`;
  const configure = settingsLink("Configure model", input.owner, input.name);

  const headline = `**The ${MODEL_ACCESS_MARKER}: \`${input.model}\`.**`;

  const branch: Record<ModelAccessReason, { why: string; cta: string }> = {
    oss: {
      why: `This run is limited to a pre-approved set of models: ${ossAllowedLabels()}. Pick one of those, or add a provider key to run a different one.`,
      cta: `${configure} · [Add a provider key →](${secretsUrl})`,
    },
    byok_no_key: {
      why: `No provider key for \`${input.model}\` is present in this run's environment. Add the matching key as a repository secret, or pick a model whose provider is already connected.`,
      cta: `[Open repo secrets →](${secretsUrl}) · ${configure}`,
    },
    router: {
      why: "This model cannot be served through the configured gateway. Pick one the gateway supports, or add a provider key to run it directly.",
      cta: `${configure} · [Add a provider key →](${secretsUrl})`,
    },
  };

  const { why, cta } = branch[input.reason];
  return [headline, "", why, "", cta].join("\n");
}
