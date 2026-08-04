import { LIFECYCLE_HOOK_TIMEOUT_MS } from "../lifecycle.ts";
import { log } from "./cli.ts";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SPAWN_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
} from "./subprocess.ts";

export interface ExecuteLifecycleHookParams {
  event: string;
  script: string | null;
  /**
   * when true, after the hook runs (success or failure), discard tracked-file
   * mods so the agent doesn't see hook-generated drift (e.g. `pnpm install`
   * rewriting a lockfile). untracked files are preserved - hooks that
   * intentionally materialize files (e.g. a `.env` from a template) stay
   * visible to the agent. skipped (with a warning) if the tree had
   * pre-existing tracked changes before the hook ran, so we never clobber
   * pre-existing work; pre-existing untracked files are ignored for this
   * gate because `git restore --staged --worktree .` doesn't touch them
   * anyway. no-op when no script was configured.
   */
  normalizeWorkingTreeAfter?: boolean;
}

/** structured failure info - `output` on the `exit` variant is trimmed
 * stderr, falling back to stdout when stderr is empty. */
export type LifecycleHookFailure =
  | { kind: "exit"; exitCode: number; output: string }
  | { kind: "timeout" }
  | { kind: "spawn"; spawnError: string };

/** one-line, agent-facing description of a hook failure. empty string when
 * there was no failure, so callers can pass the result straight through to a
 * prompt section that omits itself on empty. */
export function describeSetupFailure(failure: LifecycleHookFailure | undefined): string {
  if (!failure) return "";
  switch (failure.kind) {
    case "exit":
      return `It exited with code ${failure.exitCode}. Output:\n\n${failure.output || "(empty)"}`;
    case "timeout":
      return "It timed out and was killed before completing.";
    case "spawn":
      return `It failed to start: ${failure.spawnError}`;
    default: {
      const _exhaustive: never = failure;
      return _exhaustive satisfies never;
    }
  }
}

export interface LifecycleHookResult {
  /**
   * human-readable warning when the hook failed. includes retry guidance:
   * transient spawn/exit errors are worth retrying, timeouts and
   * persistent failures are not. absent when the hook succeeded or was
   * skipped. setup/post-checkout callers surface this verbatim; prepush
   * builds its own message from `failure` instead.
   */
  warning?: string;
  /**
   * structured failure info - undefined when the hook succeeded or was
   * skipped. lets callers compose their own messaging without parsing the
   * `warning` string.
   */
  failure?: LifecycleHookFailure;
}

/**
 * execute a lifecycle hook script if one is configured.
 *
 * soft-fails: instead of throwing on hook errors, returns a warning string
 * (and structured failure info) so callers can choose how to surface it
 * (mcp tools relay it to the agent; setup logs it and adds a prompt banner).
 * timeouts are flagged as non-retryable in the warning text.
 */
export async function executeLifecycleHook(
  params: ExecuteLifecycleHookParams
): Promise<LifecycleHookResult> {
  if (!params.script) return {};

  log.info(`» executing ${params.event} lifecycle hook...`);

  // snapshot tracked-file mods BEFORE the hook runs so we can distinguish
  // hook-generated drift from pre-existing work. both hook windows should
  // start clean in normal operation (setup runs before any working-tree
  // writes; checkout_pr refuses to run with a dirty tree), but if that
  // invariant breaks we'd rather warn than discard whatever was there.
  // pre-existing untracked files don't matter here - `git restore --staged
  // --worktree .` never touches untracked files, so they're never at risk.
  const preHookTrackedCount = params.normalizeWorkingTreeAfter
    ? (await runGitLines(["diff", "--name-only", "HEAD"])).length
    : 0;

  // single try/finally so normalization fires on success AND failure paths.
  // a hook that fails partway through (e.g. `pnpm install` updates the
  // lockfile then explodes on a peer-dep conflict) leaves the same kind of
  // drift a successful run does, and the agent will see it next regardless
  // of which path we took. failure-mode messaging is unchanged; the only
  // delta is that we don't return tracked drift to the agent.
  let result: LifecycleHookResult;
  try {
    try {
      const spawnResult = await spawn({
        cmd: "bash",
        args: ["-c", params.script],
        env: process.env,
        timeout: LIFECYCLE_HOOK_TIMEOUT_MS,
        activityTimeout: 0,
        onStdout: (chunk) => process.stdout.write(chunk),
        onStderr: (chunk) => process.stderr.write(chunk),
      });

      if (spawnResult.exitCode !== 0) {
        const output = (spawnResult.stderr || spawnResult.stdout).trim();
        result = {
          failure: { kind: "exit", output, exitCode: spawnResult.exitCode },
          warning:
            `lifecycle hook '${params.event}' failed with exit code ${spawnResult.exitCode}. ` +
            `output: ${output || "(empty)"}. ` +
            `retry the operation if the failure looks flaky (network blips, transient rate limits). ` +
            `do NOT retry if the script is broken (missing commands, syntax errors) or the error is persistent.`,
        };
      } else {
        log.info(`» ${params.event} lifecycle hook completed successfully`);
        result = {};
      }
    } catch (err) {
      const isTimeout =
        err instanceof SpawnTimeoutError &&
        (err.code === SPAWN_TIMEOUT_CODE || err.code === SPAWN_ACTIVITY_TIMEOUT_CODE);
      if (isTimeout) {
        const minutes = Math.round(LIFECYCLE_HOOK_TIMEOUT_MS / 60000);
        result = {
          failure: { kind: "timeout" },
          warning:
            `lifecycle hook '${params.event}' timed out after ${minutes}min. ` +
            `do NOT retry - the script is likely hung or doing too much work. ` +
            `ask the repo owner to simplify the hook (e.g. move long-running work out of the hook, add caching, or split it).`,
        };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          failure: { kind: "spawn", spawnError: msg },
          warning:
            `lifecycle hook '${params.event}' failed to spawn: ${msg}. ` +
            `this is likely a transient failure - retry the operation.`,
        };
      }
    }
  } finally {
    if (params.normalizeWorkingTreeAfter) {
      await normalizeWorkingTreeAfterHook({ event: params.event, preHookTrackedCount });
    }
  }
  return result;
}

/**
 * discard tracked-file mods left by a lifecycle hook so the agent's next
 * `git status` matches the pre-hook state. untracked files (e.g. a `.env`
 * the hook materialized from a template) are left alone - the agent decides
 * what to do with them. skipped (with a warning) when the tree had
 * pre-existing tracked changes before the hook ran, so pre-existing work
 * is never clobbered. idempotent: a second call on a clean tree is a no-op
 * and stays quiet.
 */
async function normalizeWorkingTreeAfterHook(params: {
  event: string;
  preHookTrackedCount: number;
}): Promise<void> {
  if (params.preHookTrackedCount > 0) {
    log.warning(
      `» working tree had ${params.preHookTrackedCount} pre-existing tracked changes before ${params.event} hook; ` +
        `skipping post-hook normalization to avoid clobbering pre-existing work`
    );
    return;
  }
  const trackedCount = (await runGitLines(["diff", "--name-only", "HEAD"])).length;
  if (trackedCount === 0) return;
  await runGit(["restore", "--staged", "--worktree", "."]);
  log.info(`» discarded ${trackedCount} tracked changes from ${params.event} hook`);
}

async function runGit(args: string[]): Promise<string> {
  const result = await spawn({ cmd: "git", args, env: process.env, activityTimeout: 0 });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || "(no stderr)"}`
    );
  }
  return result.stdout;
}

async function runGitLines(args: string[]): Promise<string[]> {
  return (await runGit(args)).split("\n").filter(Boolean);
}
