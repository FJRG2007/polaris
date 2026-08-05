/**
 * Enigma inside a run.
 *
 * Polaris departure from the vendored runtime. Whatever model is driving a run,
 * the standards it works to should be the operator's, not the model's defaults -
 * so Enigma's policy skills, its operating contract, its slash commands and its
 * post-edit guardrails are installed into the agent's home before it starts.
 * Every agent this runtime can drive reads the same directories (see
 * `skills.ts`), so one install serves all of them.
 *
 * This runs against the fake HOME each agent builds for itself rather than the
 * machine's, for the same reason the bundled skills do: what a run installs must
 * not outlive it or leak onto whatever else shares the runner.
 *
 * Best-effort throughout. A run whose Enigma install failed is a run with weaker
 * standards, not a broken one, and failing the job over it would turn a network
 * blip into a lost run.
 */

import { log } from "./cli.ts";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** How long the install is given before it is abandoned. It downloads a
 *  platform binary and writes about seventy small files. */
const INSTALL_TIMEOUT_MS = 180_000;

export interface InstallEnigmaParams {
  /** The agent's fake HOME. Everything Enigma writes lands under it. */
  home: string;
  /** npm version spec, as Polaris resolved it. Pinned rather than `latest` so
   *  two runs of the same repository work to the same standards. */
  version: string;
  /** Extra environment the install needs, principally the agent's own HOME
   *  overrides. */
  env: Record<string, string>;
}

/**
 * Install Enigma's skills, memory, commands and hooks into the run's home.
 *
 * `--all --yes` is the documented non-interactive form; without it the CLI opens
 * its picker and would hang a job with no terminal.
 */
export function installEnigma(params: InstallEnigmaParams): void {
  const result = spawnSync("npx", ["-y", `enigma-cli@${params.version}`, "install", "--all", "--yes"], {
    // npm walks up from cwd looking for `.npmrc`, and a repository's own can
    // carry settings that break npx binary resolution. The system tmpdir has
    // none. The install location is decided by HOME, not by cwd.
    cwd: tmpdir(),
    env: { ...process.env, ...params.env, HOME: params.home },
    stdio: "pipe",
    timeout: INSTALL_TIMEOUT_MS
  });

  if (result.status !== 0) {
    const detail = (result.stderr?.toString() || result.stdout?.toString() || "").trim();
    log.warning(`enigma install failed - the agent runs without its skills. ${detail.slice(-500)}`);
    return;
  }

  dropStopHook(params.home);
  log.success("installed enigma skills, memory and guardrails");
}

/**
 * Put the agent this run installed on PATH, under the name tools look for.
 *
 * Polaris departure, and the thing that makes the full quality gate possible at
 * all: the runtime installs its agent into a private directory and launches it
 * by absolute path, so nothing else in the run can find it. The gate drives its
 * own agent passes and looks the binary up by name, and without this it reports
 * that no agent is installed on a machine that is running one.
 *
 * A shim rather than a symlink: the same directory serves Windows and Linux, and
 * a shell script that execs the real binary needs no filesystem privilege.
 * Returns the directory, already prepended to this process's PATH so every child
 * inherits it - the pre-push hook included, which is the caller that needs it.
 */
export function exposeAgentOnPath(params: { name: string; cliPath: string; tmpdir: string }): string {
  const binDir = join(params.tmpdir, "polaris-agent-bin");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, params.name);
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(params.cliPath)} "$@"\n`, { mode: 0o755 });
  if (!(process.env.PATH ?? "").split(delimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  }
  return binDir;
}

/**
 * Take Enigma's Stop hook back out.
 *
 * Everything else Enigma writes composes with this runtime: its policy skills
 * are read-only guidance, and its post-edit guardrails run per edit and exit.
 * Its Stop hook is the one that cannot coexist - this runtime installs a Stop
 * hook of its own that owns the whole end-of-turn decision (reflection, the
 * dirty-tree retry, the unsubmitted-review gate), and two hooks each deciding
 * whether the agent may stop is a loop neither of them can see. Enigma's
 * end-of-turn check is not lost: the quality gate Polaris runs before the push
 * is the same tool, run where it can report what it found.
 */
function dropStopHook(home: string): void {
  const path = join(home, ".claude", "settings.json");
  if (!existsSync(path)) return;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, unknown> };
    if (!settings.hooks || !("Stop" in settings.hooks)) return;
    delete settings.hooks.Stop;
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    // A settings file this cannot read is one the agent will not read either.
  }
}
