#!/usr/bin/env node

/**
 * The runtime's only entrypoint, for every place a run can happen.
 *
 * `main()` takes no arguments: it reads the job token, the prompt, the model and
 * every other input from the environment, the way a GitHub Action does
 * (`INPUT_*`). That is what lets one bundle serve all three execution modes
 * without a second code path - a GitHub-hosted job, a Polaris runner and the
 * container Polaris starts on its own box differ only in who sets those
 * variables.
 *
 * Upstream shipped a bootstrap here instead, which re-launched the real CLI via
 * `npx <package>@<version>` from the public registry. Polaris serves this bundle
 * from the instance the run already authenticates against, so there is nothing
 * to fetch and no third party in the path.
 */

import { main } from "./main.ts";
import { dirname } from "node:path";
import * as core from "@actions/core";

// GitHub Actions runs the entrypoint with the Node binary named in action.yml but
// does not put that binary's directory on PATH. Without this, everything the agent
// spawns (npm, pnpm, the agent CLI itself) resolves to the runner's default Node,
// which is an older major.
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;

try {
  const result = await main();
  if (!result.success) throw new Error(result.error || "agent execution failed");
} catch (error) {
  core.setFailed(`run failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
