import { log } from "./cli.ts";
import { spawn } from "./subprocess.ts";

/** tracked paths with staged or unstaged modifications. */
export async function dirtyTrackedPaths(): Promise<Set<string>> {
  const result = await spawn({
    cmd: "git",
    args: ["diff", "--name-only", "HEAD"],
    env: process.env,
    activityTimeout: 0,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff --name-only HEAD failed (exit ${result.exitCode}): ${result.stderr.trim() || "(no stderr)"}`
    );
  }
  return new Set(result.stdout.split("\n").filter(Boolean));
}

/**
 * discard tracked-file mods that appeared since the `before` snapshot, so the
 * customer checkout is clean before agent tools run - any dirt makes
 * `checkout_pr` refuse for the rest of the run. paths already dirty at snapshot
 * time are left alone, and untracked files (`node_modules`, etc.) are never
 * touched.
 *
 * attribution is by WINDOW, not by writer: every tracked path dirtied while the
 * window was open gets reverted, whoever wrote it. a caller must therefore close
 * its window before the agent can write, or it will discard the agent's own work
 * (#1146 - background prep cannot make that guarantee).
 *
 * `actor` names the phase that owns the window and is what the log line blames.
 */
export async function restoreDirtiedSince(params: {
  before: Set<string>;
  actor: string;
}): Promise<void> {
  const dirtied = [...(await dirtyTrackedPaths())].filter((path) => !params.before.has(path));
  if (dirtied.length === 0) return;
  const result = await spawn({
    cmd: "git",
    args: ["restore", "--staged", "--worktree", "--", ...dirtied],
    env: process.env,
    activityTimeout: 0,
  });
  if (result.exitCode !== 0) {
    log.warning(
      `» failed to restore ${dirtied.length} tracked file(s) modified by ${params.actor}: ${result.stderr.trim() || "(no stderr)"}`
    );
    return;
  }
  log.info(
    `» restored ${dirtied.length} tracked file(s) modified by ${params.actor}: ${dirtied.join(", ")}`
  );
}
