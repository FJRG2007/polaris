import { getApiUrl } from "./apiUrl.ts";
import {
  getModelProvider,
  modelAliases,
  providers,
  resolveDisplayAlias,
} from "../models.ts";

export const POLARIS_DIVIDER = "<!-- POLARIS_DIVIDER_DO_NOT_REMOVE_PLZ -->";

/**
 * Attribution link. There is no hosted service behind this runtime, so it points
 * at the Polaris instance that dispatched the run - the only address a reader of
 * the comment could act on. A run with no reachable instance renders plain text
 * rather than a dead link.
 */
function attribution(): string {
  try {
    return `[Polaris](${getApiUrl()})`;
  } catch {
    return "Polaris";
  }
}

export interface WorkflowRunFooterInfo {
  owner: string;
  repo: string;
  runId: number;
  /** optional job ID - if provided, will append /job/{jobId} to the workflow run URL */
  jobId?: string | undefined;
}

export interface BuildPolarisFooterParams {
  /** add "via Polaris" link */
  triggeredBy?: boolean;
  /** add "View workflow run" link */
  workflowRun?: WorkflowRunFooterInfo | undefined;
  /** alternative: just pass a pre-built URL directly (for shortlinks etc.) */
  workflowRunUrl?: string | undefined;
  /** arbitrary custom parts (e.g., action links) */
  customParts?: string[] | undefined;
  /** model slug from payload (e.g., "anthropic/claude-opus"). shown in footer as "Using `Model Name`" */
  model?: string | undefined;
  /**
   * When the run fell back to another model because the configured one had no
   * provider key, this is the slug that was configured. The footer renders
   * `Using <model> (credentials for <configured> not configured)` so the
   * substitution is visible in the comment rather than silently applied.
   */
  fallbackFrom?: string | undefined;
}

/** Provider display name (e.g. "Anthropic") for the slug, or the raw provider segment as a fallback. */
function providerDisplayName(slug: string): string {
  try {
    const key = getModelProvider(slug);
    const meta = providers[key as keyof typeof providers];
    return meta?.displayName ?? key;
  } catch {
    // raw IDs without a `/` (Bedrock model IDs) - never reach this function
    // in practice because the BYOK fallback skips Bedrock, but defensively
    // return the slug itself rather than throw if it ever does.
    return slug;
  }
}

function formatModelLabel(params: {
  model: string;
  fallbackFrom?: string | undefined;
}): string {
  const alias =
    resolveDisplayAlias(params.model) ??
    // reverse-lookup: when the caller passes an effective model (a resolved
    // target like "openrouter/anthropic/claude-opus-4.7") instead of a stored
    // alias slug, find the alias whose resolve target matches so we still
    // render a friendly display name.
    modelAliases.find((a) => a.resolve === params.model || a.openRouterResolve === params.model);
  const displayName = alias?.displayName ?? params.model;
  const base = alias?.isFree ? `\`${displayName}\` (free)` : `\`${displayName}\``;
  if (params.fallbackFrom) {
    return `${base} (credentials for ${providerDisplayName(params.fallbackFrom)} not configured)`;
  }
  return base;
}

/**
 * Build the footer appended to every comment, review and error report the agent
 * writes, in the order: action links (customParts) > workflow run > attribution
 * > model.
 *
 * Deliberately plain. This runtime posts into somebody else's repository, so the
 * footer carries what a reader of the comment needs to act - where the run
 * happened, what wrote it, which model - and nothing promotional.
 */
export function buildPolarisFooter(params: BuildPolarisFooterParams): string {
  const parts: string[] = [];

  if (params.customParts) {
    parts.push(...params.customParts);
  }

  if (params.workflowRunUrl) {
    parts.push(`[View workflow run](${params.workflowRunUrl})`);
  } else if (params.workflowRun) {
    const baseUrl = `https://github.com/${params.workflowRun.owner}/${params.workflowRun.repo}/actions/runs/${params.workflowRun.runId}`;
    const url = params.workflowRun.jobId ? `${baseUrl}/job/${params.workflowRun.jobId}` : baseUrl;
    parts.push(`[View workflow run](${url})`);
  }

  if (params.triggeredBy) {
    parts.push(`via ${attribution()}`);
  }

  if (params.model) {
    parts.push(
      `Using ${formatModelLabel({
        model: params.model,
        fallbackFrom: params.fallbackFrom,
      })}`
    );
  }

  return `\n\n${POLARIS_DIVIDER}\n<sup>${parts.join(" ｜ ")}</sup>`;
}

/**
 * strip any existing polaris footer from a comment body
 */
export function stripExistingFooter(body: string): string {
  const dividerIndex = body.indexOf(POLARIS_DIVIDER);
  if (dividerIndex === -1) {
    return body;
  }
  return body.substring(0, dividerIndex).trimEnd();
}
