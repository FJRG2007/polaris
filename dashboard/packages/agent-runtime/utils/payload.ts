import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import { type AuthorPermission, type PayloadEvent, parseEffortPosition } from "../external.ts";
import packageJson from "../package.json" with { type: "json" };
import { log } from "./cli.ts";
import { isPolaris } from "./isPolaris.ts";
import type { RepoSettings } from "./runContext.ts";
import { validateCompatibility } from "./versioning.ts";

// tool permission enum types for inputs
const ShellPermissionInput = type.enumerated("disabled", "restricted", "enabled");
const PushPermissionInput = type.enumerated("disabled", "restricted", "enabled");
// opt-in toggle for posting `polaris` / `polaris-agent-approval` commit-status
// check-runs (branch protection). off by default - a new required-check
// surface must not silently turn on.
const StatusChecksInput = type.enumerated("disabled", "enabled");
// opt-out for the temporary "Working on it..." comment + live task-list
// updates. on by default; the repo setting is the only half the dispatcher can
// see, so this input can suppress live updates but not a comment already seeded.
const ProgressCommentsInput = type.enumerated("disabled", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~polaris": "true",
  version: "string",
  "model?": "string | undefined",
  "modelExplicit?": "boolean | undefined",
  "effort?": "number | string | undefined",
  prompt: "string",
  "triggerer?": "string | undefined",

  "baseInstructions?": "string | undefined",
  "eventInstructions?": "string",
  "previousRunsNote?": "string",
  "event?": "object",
  "xrepo?": type({
    mode: "'all' | 'explicit'",
    read: "string[]",
    write: "string[]",
    // optional so a payload from an older server build (pre-`unavailable`)
    // still parses against a newer action across a rolling deploy.
    "unavailable?": "string[]",
  }).or("undefined"),
  "timeout?": "string | undefined",
  "progressComment?": type({
    id: "string",
    type: "'issue' | 'review'",
  }).or("undefined"),
  // optional so a payload from an older server build (pre-`checkRun`) still parses
  // against a newer action across a rolling deploy.
  "checkRun?": type({ id: "string" }).or("undefined"),
  "generateSummary?": "boolean | undefined",
});

// permission levels that indicate collaborator status (have push access)
const COLLABORATOR_PERMISSIONS: AuthorPermission[] = ["admin", "maintain", "write"];

// check if the event author has collaborator-level permissions
function isCollaborator(event: PayloadEvent): boolean {
  const perm = event.authorPermission;
  return perm !== undefined && COLLABORATOR_PERMISSIONS.includes(perm);
}

// inputs schema - action inputs from core.getInput()
// note: tool permissions use .or("undefined") because getInput() || undefined
// explicitly sets the property to undefined when empty, which is different from
// the property being absent. arktype's "prop?" means "optional to include" but
// if included, must match the type - so we need to explicitly allow undefined.
export const Inputs = type({
  "prompt?": type.string.or("undefined"),
  "prompt_file?": type.string.or("undefined"),
  "model?": type.string.or("undefined"),
  "effort?": type.string.or("undefined"),
  "timeout?": type.string.or("undefined"),
  "push?": PushPermissionInput.or("undefined"),
  "shell?": ShellPermissionInput.or("undefined"),
  "status_checks?": StatusChecksInput.or("undefined"),
  "progress_comments?": ProgressCommentsInput.or("undefined"),
  "cwd?": type.string.or("undefined"),
  "output_schema?": type.string.or("undefined"),
});

export type Inputs = typeof Inputs.infer;

function isPayloadEvent(value: unknown): value is PayloadEvent {
  return typeof value === "object" && value !== null && "trigger" in value;
}

function resolveCwd(cwd: string | undefined): string | undefined {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!cwd) return workspace;
  if (isAbsolute(cwd)) return cwd;
  return workspace ? resolve(workspace, cwd) : cwd;
}

export type ResolvedPromptInput = string | typeof JsonPayload.infer;

export function resolvePromptInput(): ResolvedPromptInput {
  const promptInput = core.getInput("prompt");
  const promptFile = core.getInput("prompt_file");

  if (promptInput && promptFile) {
    throw new Error("set exactly one of 'prompt' or 'prompt_file' inputs, not both.");
  }

  // a prompt file holds a human-authored prompt, so it is returned verbatim and
  // never parsed as an internal polaris JSON dispatch payload.
  if (promptFile) {
    return resolvePromptFile(promptFile);
  }

  if (!promptInput) {
    throw new Error("one of 'prompt' or 'prompt_file' inputs is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(promptInput);
  } catch {
    // JSON parse error is fine (plain text prompt)
    return promptInput;
  }

  if (!parsed || typeof parsed !== "object" || !("~polaris" in parsed)) {
    // if it doesn't look like a polaris payload, return the plain text prompt
    return promptInput;
  }

  // validation errors should propagate
  const jsonPayload = JsonPayload.assert(parsed);
  validateCompatibility(jsonPayload.version, packageJson.version);
  return jsonPayload;
}

// the path is workflow-author-controlled (anyone who can set prompt_file can
// already run arbitrary job steps), so we resolve, read, and empty-check it
// without sandbox-grade path validation.
function resolvePromptFile(input: string): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  const path = isAbsolute(input) ? input : workspace ? resolve(workspace, input) : resolve(input);
  const content = readFileSync(path, "utf-8");
  if (!content.trim()) {
    throw new Error(`prompt_file ${JSON.stringify(input)} is empty.`);
  }
  return content;
}

/**
 * `status_checks` is deprecated: both checks it governed are now repo settings, editable in
 * the console, and the server reads those directly (it never parses workflow YAML, so an
 * input could never gate the server-seeded `polaris` check anyway).
 *
 * Honoured INDEFINITELY on v0, not on a countdown. The backfill covered every repo the app
 * can currently read, but a dormant install (uninstalled or suspended, so its workflow is
 * unreadable) can return at any time carrying this input, and would lose a required check the
 * moment it went inert. That condition never expires, so do not promise a removal here -
 * dropping it is a v1 question. Warn instead; the annotation surfaces on the run.
 */
function warnIfDeprecatedStatusChecks(value: string | undefined): string | undefined {
  if (value !== undefined) {
    core.warning(
      "`status_checks` is deprecated. Both checks are now repository settings - open the " +
        "Polaris console for this repo (Automations → Review PRs) and set them there, then " +
        "remove `status_checks` from your workflow. It keeps working until you do."
    );
  }
  return value;
}

function resolveNonPromptInputs() {
  return Inputs.omit("prompt", "prompt_file").assert({
    model: core.getInput("model") || undefined,
    effort: core.getInput("effort") || undefined,
    timeout: core.getInput("timeout") || undefined,
    cwd: core.getInput("cwd") || undefined,
    push: core.getInput("push") || undefined,
    shell: core.getInput("shell") || undefined,
    status_checks: warnIfDeprecatedStatusChecks(core.getInput("status_checks") || undefined),
    progress_comments: core.getInput("progress_comments") || undefined,
  });
}

export function resolvePayload(
  resolvedPromptInput: ResolvedPromptInput,
  repoSettings: RepoSettings
) {
  const [prompt, jsonPayload] =
    typeof resolvedPromptInput !== "string"
      ? [resolvedPromptInput.prompt, resolvedPromptInput]
      : [resolvedPromptInput, undefined];

  const inputs = resolveNonPromptInputs();

  // resolve event - use type guard for jsonPayload.event, fallback to unknown trigger
  const rawEvent = jsonPayload?.event;
  const event: PayloadEvent = isPayloadEvent(rawEvent) ? rawEvent : { trigger: "unknown" };

  const model = jsonPayload?.model ?? inputs.model ?? repoSettings.model ?? undefined;

  // same precedence as model. carried as a POSITION on [0,1] rather than a rung
  // name, so it stays meaningful if the model changes underneath it. an
  // unparseable value is dropped rather than guessed - unset means the harness
  // applies the model's own default.
  const rawEffort = jsonPayload?.effort ?? inputs.effort ?? repoSettings.effort ?? undefined;
  const effort = rawEffort === undefined ? undefined : parseEffortPosition(String(rawEffort));

  // determine shell permission - strictest setting wins
  // precedence: disabled > restricted > enabled
  // non-collaborators always get at least "restricted"
  const isNonCollaborator = !isCollaborator(event);
  const repoShell = repoSettings.shell ?? "restricted";
  const inputShell = inputs.shell;

  // resolve shell: start with repo setting, then apply restrictions
  let resolvedShell = repoShell;

  // input can only make it stricter (disabled > restricted > enabled)
  if (inputShell === "disabled") {
    resolvedShell = "disabled";
  } else if (inputShell === "restricted" && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // non-collaborators get at least "restricted" (can't have "enabled")
  if (isNonCollaborator && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // build payload - precedence: inputs > repoSettings > fallbacks
  // note: modes are NOT in payload - they come from repoSettings in main()
  return {
    "~polaris": true as const,
    version: jsonPayload?.version ?? packageJson.version,
    model,
    // explicit only when the model came from a per-run override flag (carried on
    // the JSON payload). a GHA `model` input or the repo default is not explicit.
    modelExplicit: jsonPayload?.modelExplicit ?? false,
    effort,
    prompt,
    triggerer:
      jsonPayload?.triggerer ??
      // it's not a common use case but GITHUB_ACTOR can be a user when the workflow is manually triggered by a user through GitHub Actions UI
      (!isPolaris(process.env.GITHUB_ACTOR) ? process.env.GITHUB_ACTOR : undefined),
    baseInstructions: jsonPayload?.baseInstructions,
    eventInstructions: jsonPayload?.eventInstructions,
    previousRunsNote: jsonPayload?.previousRunsNote,
    event,
    xrepo: jsonPayload?.xrepo,
    timeout: inputs.timeout ?? jsonPayload?.timeout,
    cwd: resolveCwd(inputs.cwd),
    progressComment: jsonPayload?.progressComment,
    checkRun: jsonPayload?.checkRun,
    generateSummary: jsonPayload?.generateSummary,

    // permissions: inputs > repoSettings > fallbacks
    push: inputs.push ?? repoSettings.push ?? "restricted",
    shell: resolvedShell,

    // the `polaris` run-lifecycle check. ON by default - the whole point is that a PR
    // shows whether Polaris is running without anyone having to opt in. the workflow
    // input is the source of truth when set (mirrors `push`); otherwise the repo
    // setting decides.
    runStatusCheck:
      inputs.status_checks === undefined
        ? repoSettings.statusChecks
        : inputs.status_checks === "enabled",

    // the `polaris-agent-approval` verdict check. `Repo.approvalCheck` is authoritative; the
    // `status_checks` input is DEPRECATED but still honoured, for the dormant installs the
    // backfill could not read (see `warnIfDeprecatedStatusChecks`). OR rather than override:
    // this can only ever turn the check ON, never off, so no existing user loses it.
    approvalCheck: repoSettings.approvalCheck || inputs.status_checks === "enabled",

    // temporary progress chrome. the workflow input is the source of truth when
    // set (mirrors `push`); otherwise the repo setting decides. defaults to true.
    progressComments:
      inputs.progress_comments === undefined
        ? repoSettings.progressComments
        : inputs.progress_comments === "enabled",

    // set by proxy logic in main.ts when routing through OpenRouter
    proxyModel: undefined as string | undefined,
  };
}

export type ResolvedPayload = ReturnType<typeof resolvePayload>;

/**
 * Parse and validate the optional `output_schema` action input. Returns the
 * parsed object when present, or `undefined` when absent. Throws on invalid
 * JSON or non-object payloads - these are workflow-author errors that should
 * surface immediately, not silently degrade to "no schema".
 */
export function resolveOutputSchema(): Record<string, unknown> | undefined {
  const raw = core.getInput("output_schema");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid output_schema: not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid output_schema: must be a JSON object`);
  }
  log.info("» structured output schema provided - output will be required");
  return parsed as Record<string, unknown>;
}
