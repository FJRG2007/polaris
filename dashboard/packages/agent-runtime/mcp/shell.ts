// changes to shell security (filterEnv, spawnShell) should be reflected in wiki/security.md and docs/security.mdx
import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type } from "arktype";
import { ensureBrowserDaemon } from "../utils/browser.ts";
import { log } from "../utils/log.ts";
import { resolveEnv } from "../utils/secrets.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const ShellParams = type({
  command: "string",
  // advisory and unread - no code path consumes it. kept in the schema only
  // because it nudges the model to state intent before running a command;
  // REQUIRING it cost a full rejected turn every time one was omitted. #1140.
  "description?": "string",
  "timeout?": type.number.describe(
    "Timeout in MILLISECONDS (not seconds). Default 30000 (30s), max 120000 (2m). e.g. timeout: 180000 for 3 minutes; timeout: 180 means 180ms and will kill the process almost immediately."
  ),
  "working_directory?": "string",
  "background?": "boolean",
});

type SpawnParams = {
  command: string;
  env: Record<string, string | undefined>;
  cwd: string;
  stdio: StdioOptions;
};

export type SandboxMethod = "unshare" | "sudo-unshare" | "none";

/** cached result of sandbox capability check */
let detectedSandboxMethod: SandboxMethod | undefined;

/** get the current sandbox method (for testing/diagnostics) */
export function getSandboxMethod(): SandboxMethod {
  return detectSandboxMethod();
}

/** detect which sandbox method is available on this system */
function detectSandboxMethod(): SandboxMethod {
  if (detectedSandboxMethod !== undefined) {
    return detectedSandboxMethod;
  }

  // only attempt in CI environments - sandbox has overhead and is primarily for untrusted code
  if (process.env.CI !== "true") {
    detectedSandboxMethod = "none";
    log.debug("sandbox disabled (CI !== true)");
    return "none";
  }

  // try unprivileged unshare first (works on some systems)
  try {
    const result = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", "true"], {
      timeout: 5000,
      stdio: "ignore",
    });
    if (result.status === 0) {
      detectedSandboxMethod = "unshare";
      log.debug("PID namespace isolation enabled (unprivileged unshare)");
      return "unshare";
    }
  } catch {
    // continue to try sudo
  }

  // sudo unshare (works on GHA runners)
  try {
    const result = spawnSync("sudo", ["unshare", "--pid", "--fork", "--mount-proc", "true"], {
      timeout: 5000,
      stdio: "ignore",
    });
    if (result.status === 0) {
      detectedSandboxMethod = "sudo-unshare";
      log.debug("PID namespace isolation enabled (sudo unshare)");
      return "sudo-unshare";
    }
  } catch {
    // no sandbox available
  }

  detectedSandboxMethod = "none";
  log.info("PID namespace isolation not available");
  return "none";
}

// strip inherited proc mount that sits underneath --mount-proc's overlay.
// --mount-proc mounts fresh proc on top, but `umount /proc` peels it off and exposes the
// host's proc with all host PIDs - allowing /proc/<pid>/environ exfiltration.
// double-umount removes both layers, then a clean mount gives only sandbox PIDs.
// on unprivileged systems where umount fails, --mount-proc still provides isolation
// (the agent also can't umount in that case).
const PROC_CLEANUP =
  "umount /proc 2>/dev/null; umount /proc 2>/dev/null; mount -t proc proc /proc 2>/dev/null;";

// block container-runtime sockets that would otherwise grant a PID-namespace
// escape: `docker run --pid=host --privileged busybox cat /proc/<pid>/environ`
// reads the parent action process's env (which contains user secrets) even
// though the sandbox itself is unsharing PIDs. GHA `ubuntu-latest` puts the
// `runner` user in the `docker` group by default, so the socket is reachable
// without sudo. bind-mounting /dev/null on top inside the sandbox's mount
// namespace makes the socket unreachable from sandboxed shells without
// touching the host runner (so it doesn't break user workflow steps that
// run before/after polaris and legitimately need docker). same trick for
// podman/containerd/cri-o sockets - all silent-fail if the path is missing.
const SOCKET_CLEANUP = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/podman/podman.sock",
  "/run/podman/podman.sock",
  "/run/containerd/containerd.sock",
  "/var/run/crio/crio.sock",
]
  .map((path) => `mount --bind /dev/null ${path} 2>/dev/null;`)
  .join(" ");

// extend the mount-namespace isolation that PROC_CLEANUP and SOCKET_CLEANUP
// already establish. these mounts hide polaris-managed on-disk secrets,
// block env-injection into subsequent workflow steps, and make git's
// code-execution config read-only inside the bash subprocess.
//
//   1. tmpfs over /var/lib/polaris/ - codex auth.json and any future
//      polaris-managed on-disk secret live here (see action/utils/codexHome.ts
//      POLARIS_DATA_DIR). opencode's internal auth module runs in the agent
//      process outside this namespace and reads the real file via bypass of
//      external_directory; bash sees an empty tmpfs. mkdir -p the path
//      first so the tmpfs always engages - without that, runs without
//      CODEX_AUTH_JSON wouldn't have bootstrapped the dir, the mountpoint
//      wouldn't exist, and `mount -t tmpfs` would silent-fail. precreate
//      keeps the overlay active for any future on-disk secret that lands
//      under /var/lib/polaris regardless of which install path created it.
//   2. tmpfs over $RUNNER_TEMP/_runner_file_commands/ - anything bash writes
//      to $GITHUB_ENV / $GITHUB_PATH / $GITHUB_OUTPUT / $GITHUB_STATE lands in
//      a per-namespace tmpfs that the GHA runner never sees. our own action
//      process writes core.setOutput / core.saveState outside the namespace,
//      so legitimate outputs are unaffected. requires RUNNER_TEMP to be set.
//   3. self-bind + remount-ro on the ENTIRE <repoRoot>/.git directory.
//      A blanket ro-bind is free: nothing legitimately writes .git from
//      bash (commits go through our $git(), whose binary runs OUTSIDE this
//      namespace, so it's unaffected; bash `git` is already blocked). It
//      robustly covers every code-exec surface an enumerated list would miss
//      - .git/config, .git/config.worktree, .git/modules/*/config (all carry
//      core.hooksPath / filter / alias / credential.helper exec vectors),
//      plus .git/hooks/* and .git/info/attributes. Prevents agent-planted git
//      filters / hooks from firing in downstream workflow steps (the threat
//      survives ASKPASS because hooks fire after auth and our $git() uses -c
//      core.hooksPath to override its own hooks, but downstream `git`
//      invocations in later steps DON'T get that protection - see
//      wiki/security.md "Filesystem Sandbox"). CONSEQUENCE: .git/info/exclude
//      (a legit per-repo ignore file) is now read-only too - accepted, the
//      narrow earlier bind list left it writable. Does not cover `~/.gitconfig`
//      or `/etc/gitconfig` - see "Scope and Limitations" in wiki/security.md.
//
// these mounts run as root inside the namespace (before `exec su -p` drops
// to runner). after the drop, runner has no CAP_SYS_ADMIN in the host, so
// can't undo from outside. intra-namespace sudo undo is theoretically
// possible - same risk profile as SOCKET_CLEANUP, accepted per wiki/security.md
// "why sudo inside sandbox doesn't break security".
//
// in the unprivileged-unshare path (Docker --privileged test environments),
// the user retains CAP_SYS_ADMIN inside the user namespace and could
// `umount` these. production uses sudo-unshare where the drop seals them.
//
// repoDir is interpolated by the action process from resolveRepoRoot() -
// NOT $PWD - because spawnShell's cwd is agent-controllable via
// `working_directory` AND the action's process.cwd() may have been chdir'd
// to payload.cwd (monorepo subdir support in main.ts). using either would
// let the agent bypass the .git/* binds. resolveRepoRoot pins the actual
// repo root once at startup via $GITHUB_WORKSPACE or `git rev-parse`.
function buildFsMounts(repoDir: string): string {
  // shell-escape via single-quote wrap; bash interprets \' as the escape
  // for a single quote inside a single-quoted string by closing-and-reopening.
  // repoDir paths in practice are GHA workspace paths (no quotes), but the
  // escape keeps us correct against arbitrary user-configured workspaces.
  const escaped = repoDir.replace(/'/g, "'\\''");
  return [
    `mkdir -p /var/lib/polaris 2>/dev/null;`,
    `mount -t tmpfs tmpfs /var/lib/polaris 2>/dev/null;`,
    `[ -n "$RUNNER_TEMP" ] && [ -d "$RUNNER_TEMP/_runner_file_commands" ] && mount -t tmpfs tmpfs "$RUNNER_TEMP/_runner_file_commands" 2>/dev/null;`,
    `[ -e '${escaped}/.git' ] && mount --bind '${escaped}/.git' '${escaped}/.git' 2>/dev/null && mount -o remount,bind,ro '${escaped}/.git' 2>/dev/null;`,
  ].join(" ");
}

/** locate the repo root once at action startup. process.cwd() is unreliable
 * because main.ts may `process.chdir(payload.cwd)` for monorepo subdirs;
 * the agent's `working_directory` shell param also moves spawn cwd. we need
 * the actual git working tree root for the .git/* binds. memoized for the
 * lifetime of the action process. */
let _repoRoot: string | undefined;
function resolveRepoRoot(): string {
  if (_repoRoot) return _repoRoot;
  const fromEnv = process.env.GITHUB_WORKSPACE;
  if (fromEnv) {
    _repoRoot = fromEnv;
    return _repoRoot;
  }
  // fallback: `git rev-parse --show-toplevel` from process.cwd(). only used
  // outside GHA (local dev, custom runners). swallow errors and fall back
  // to process.cwd() so we never throw from the shell-tool init path.
  try {
    _repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).stdout?.trim();
  } catch {
    // intentionally empty - fall through to process.cwd()
  }
  if (!_repoRoot) _repoRoot = process.cwd();
  return _repoRoot;
}

function spawnShell(params: SpawnParams): ChildProcess {
  const spawnOpts = { env: params.env, cwd: params.cwd, stdio: params.stdio, detached: true };
  const sandboxMethod = detectSandboxMethod();
  const ci = process.env.CI === "true";

  if (ci && sandboxMethod === "none") {
    throw new Error(
      "pid namespace isolation is required in CI but unavailable (both unshare and sudo unshare failed)"
    );
  }

  // resolve the actual git repo root (NOT params.cwd which is
  // agent-controllable via `working_directory`, NOT process.cwd() which may
  // have been chdir'd to payload.cwd in main.ts). resolveRepoRoot prefers
  // $GITHUB_WORKSPACE in CI and falls back to `git rev-parse`.
  const repoRoot = resolveRepoRoot();
  const fsMounts = buildFsMounts(repoRoot);

  if (sandboxMethod === "unshare") {
    return spawn(
      "unshare",
      [
        "--pid",
        "--fork",
        "--mount-proc",
        "bash",
        "-c",
        `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${fsMounts} ${params.command}`,
      ],
      spawnOpts
    );
  }

  if (sandboxMethod === "sudo-unshare") {
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(params.env)) {
      if (v !== undefined) {
        envArgs.push(`${k}=${v}`);
      }
    }
    // drop back to original user after PROC_CLEANUP / FS_MOUNTS so files aren't
    // owned by root. sudo is only needed for unshare + the mount setup; the
    // actual command should run as the normal user to avoid ownership
    // mismatches with files created by the Node.js parent process.
    const username = userInfo().username;
    // su -p resets PATH on many Linux systems (ALWAYS_SET_PATH in /etc/login.defs).
    // restore it from the SANDBOX_PATH env var that survives the su transition.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: we need to restore the PATH variable
    const pathRestore = 'export PATH="${SANDBOX_PATH:-$PATH}"; ';
    const escaped = (pathRestore + params.command).replace(/'/g, "'\\''");
    envArgs.push(`SANDBOX_PATH=${params.env.PATH ?? ""}`);
    return spawn(
      "sudo",
      [
        "env",
        ...envArgs,
        "unshare",
        "--pid",
        "--fork",
        "--mount-proc",
        "bash",
        "-c",
        `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${fsMounts} exec su -p -s /bin/bash ${username} -c '${escaped}'`,
      ],
      { ...spawnOpts, env: {} }
    );
  }

  return spawn("bash", ["-c", params.command], spawnOpts);
}

/** kill process and its entire process group */
async function killProcessGroup(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

function getTempDir(): string {
  const tempDir = process.env.POLARIS_TEMP_DIR;
  if (!tempDir) {
    throw new Error("POLARIS_TEMP_DIR not set");
  }
  return tempDir;
}

/** chars of shell output kept inline in the agent reply. anything past this
 * blows the agent's context budget on commands that dump big logs (test
 * runners, build tools, grep on large trees), so the overflow is spilled
 * to a tempfile the agent can re-read selectively (cat/tail/grep). */
export const MAX_OUTPUT_CHARS = 5000;

/** if `output` exceeds `MAX_OUTPUT_CHARS`, persist the full body to a
 * tempfile and return the last `MAX_OUTPUT_CHARS` prefixed with a sentinel
 * pointing at the saved path. otherwise return as-is. */
function capOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const fullPath = join(getTempDir(), `shell-${randomUUID().slice(0, 8)}.log`);
  writeFileSync(fullPath, output);
  const elided = output.length - MAX_OUTPUT_CHARS;
  return `... [${elided} chars truncated; full output saved to ${fullPath}] ...\n${output.slice(-MAX_OUTPUT_CHARS)}`;
}

/** detect git as a command invocation (not as part of another word like .gitignore) */
function isGitCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "git" || trimmed.startsWith("git ")) return true;
  if (trimmed.startsWith("sudo git")) return true;
  return /[;&|]\s*(?:sudo\s+)?git(?:\s|$)/.test(trimmed);
}

export function ShellTool(ctx: ToolContext) {
  return tool({
    name: "shell",
    timeoutMs: 120_000,
    description: `Execute shell commands securely. Environment is filtered to remove API keys and secrets.

Example: \`shell({ command: "pnpm test", description: "run the test suite" })\`.

Use this tool to:
- Run shell commands (ls, cat, grep, find, etc.)
- Execute build tools (npm, pnpm, cargo, make, etc.)
- Run tests and linters

Output is capped at ${MAX_OUTPUT_CHARS} chars: if exceeded, only the tail is returned and the full body is saved to a tempfile (path included in the response). Re-read the tempfile with cat/tail/grep when you need more.

Do NOT use this tool for git commands - use the dedicated git tools instead.`,
    parameters: ShellParams,
    execute: execute(async (params) => {
      if (isGitCommand(params.command)) {
        throw new Error(
          "git commands are not allowed in the shell tool. use the dedicated git tools instead:\n" +
            "- git: local operations (status, log, diff, add, commit, checkout, merge, rebase, etc.)\n" +
            "- push_branch: push to remote (handles authentication)\n" +
            "- git_fetch: fetch from remote (handles authentication)\n" +
            "- checkout_pr: check out PR branches"
        );
      }

      const timeout = Math.min(params.timeout ?? 30000, 120000);
      const cwd = params.working_directory ?? process.cwd();
      const env = resolveEnv(ctx.payload.shell === "enabled" ? "inherit" : "restricted");

      if (params.command.includes("agent-browser")) {
        const daemonError = ensureBrowserDaemon(ctx.toolState);
        if (daemonError) {
          return {
            output: `browser daemon unavailable: ${daemonError}`,
            exit_code: 1,
            timed_out: false,
          };
        }
        const binDir = ctx.toolState.browserDaemon?.binDir;
        if (binDir) {
          env.PATH = `${binDir}:${env.PATH ?? ""}`;
        }
      }

      if (params.background) {
        const tempDir = getTempDir();
        const handle = `bg-${randomUUID().slice(0, 8)}`;
        const outputPath = join(tempDir, `${handle}.log`);
        const pidPath = join(tempDir, `${handle}.pid`);
        const logFd = openSync(outputPath, "a");
        let proc: ChildProcess;
        try {
          proc = spawnShell({
            command: params.command,
            env,
            cwd,
            stdio: ["ignore", logFd, logFd],
          });
        } finally {
          closeSync(logFd);
        }
        if (!proc.pid) {
          throw new Error("failed to start background process");
        }
        proc.unref();
        writeFileSync(pidPath, `${proc.pid}\n`);
        ctx.toolState.backgroundProcesses.set(handle, { pid: proc.pid, outputPath, pidPath });
        return {
          handle,
          outputPath,
          pidPath,
          message: `started background process ${handle} (pid ${proc.pid})`,
        };
      }

      const proc = spawnShell({
        command: params.command,
        env,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "",
        stderr = "",
        timedOut = false,
        exited = false;
      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timeoutId = setTimeout(async () => {
        if (!exited) {
          timedOut = true;
          await killProcessGroup(proc);
        }
      }, timeout);

      const exitCode = await new Promise<number | null>((resolve) => {
        const done = (code: number | null) => {
          exited = true;
          clearTimeout(timeoutId);
          resolve(code);
        };
        proc.on("exit", done);
        proc.on("error", () => done(null));
      });

      // `exit` fires when the direct `bash -c` child dies, but the stdout/stderr
      // pipes stay open as long as any self-daemonized descendant still holds the
      // inherited write end - and our `data` listeners keep those read streams
      // referenced, so the event loop never drains and the action hangs after
      // `Task complete.` (measured: up to 5.3h of billed runner time). dropping
      // our own read ends releases the handles without killing a descendant the
      // user deliberately backgrounded. see #1087.
      proc.stdout?.destroy();
      proc.stderr?.destroy();

      let output = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
      if (timedOut)
        output = output
          ? `${output}\n[timed out after ${timeout}ms]`
          : `[timed out after ${timeout}ms]`;

      const finalExitCode = exitCode ?? (timedOut ? 124 : -1);
      const trimmed = output.trim();
      if (finalExitCode !== 0) {
        log.info(`shell command failed with exit code ${finalExitCode}: ${params.command}`);
        if (trimmed) log.info(`output: ${trimmed}`);
      }

      return {
        output: capOutput(trimmed),
        exit_code: finalExitCode,
        timed_out: timedOut,
      };
    }),
  });
}

export const KillBackgroundParams = type({
  handle: type.string.describe("The handle of the background process to kill (e.g., bg-a1b2c3d4)"),
});

export function KillBackgroundTool(ctx: ToolContext) {
  return tool({
    name: "kill_background",
    mutates: true,
    description: `Kill a background process by its handle. Use this to stop dev servers or other long-running processes started with shell({ background: true }).`,
    parameters: KillBackgroundParams,
    execute: execute(async (params) => {
      const proc = ctx.toolState.backgroundProcesses.get(params.handle);
      if (!proc) {
        return {
          success: false,
          message: `no background process with handle ${params.handle}`,
        };
      }

      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // already dead
      }
      await sleep(200);
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // already dead
      }

      ctx.toolState.backgroundProcesses.delete(params.handle);
      return {
        success: true,
        message: `killed background process ${params.handle} (pid ${proc.pid})`,
      };
    }),
  });
}
