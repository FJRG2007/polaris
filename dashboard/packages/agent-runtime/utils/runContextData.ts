import * as core from "@actions/core";
import type { Octokit } from "@octokit/rest";
import packageJson from "../package.json" with { type: "json" };
import * as yes from "../yes/index.ts";
import { log } from "./cli.ts";
import { type OctokitWithPlugins, parseRepoContext } from "./github.ts";
import { isTransientOctokitError } from "./isTransientNetworkError.ts";
import {
  type AccountPlan,
  type CommercialRefusal,
  fetchRunContext,
  type RepoSettings,
} from "./runContext.ts";

export interface RunContextData {
  repo: {
    owner: string;
    name: string;
    data: Awaited<ReturnType<Octokit["repos"]["get"]>>["data"];
  };
  repoSettings: RepoSettings;
  apiToken: string;
  oss: boolean;
  plan: AccountPlan;
  proxyModel?: string | undefined;
  dbSecrets?: Record<string, string> | undefined;
  commercialRefused?: CommercialRefusal | undefined;
  /** stored secrets couldn't be materialized for this run - not the same as
   * the user having none. see `RunContext.secretsUnavailable`. */
  secretsUnavailable?: boolean | undefined;
}

interface ResolveRunContextDataParams {
  octokit: OctokitWithPlugins;
  token: string;
}

/**
 * true when the action is pinned to a full commit SHA (vs the moving `@v0`
 * tag or a branch). GitHub runs the action's `post:` hook (and reads
 * `action.yml`) straight from the checked-out action ref, so a SHA pin freezes
 * that checkout forever: the main agent still floats to the latest `^semver`
 * via the npm bootstrap (this code is proof - it ran), but the post-run
 * cleanup step keeps executing the pinned commit's source and never receives
 * fixes. surfaced in the log and PR footers to nudge repos back to `@v0`.
 */
export function isActionPinnedToSha(): boolean {
  const ref = process.env.GITHUB_ACTION_REF;
  return !!ref && /^[0-9a-f]{40}$/i.test(ref);
}

function warnIfPinnedToSha(): void {
  if (isActionPinnedToSha()) {
    log.warning(
      `» pinned to a commit SHA (${process.env.GITHUB_ACTION_REF}); the post-run cleanup step is ` +
        "frozen at that commit and won't receive fixes. pin to `polaris/agent-runtime@v0`, or keep the " +
        "SHA fresh with Dependabot"
    );
  }
}

/**
 * initialize run context data: parse context, fetch repo info and settings
 */
export async function resolveRunContextData(
  params: ResolveRunContextDataParams
): Promise<RunContextData> {
  log.info(`» running Polaris v${packageJson.version}...`);
  warnIfPinnedToSha();

  const repoContext = parseRepoContext();

  // the mint is an HTTP call to the runner's token endpoint, and without the
  // token run-context withholds Polaris-stored secrets - so a transient blip
  // here costs the run its keys and reads downstream as "no API key found".
  // absent env means local dev / fork PR, where it can never succeed: one
  // attempt, no retry.
  let oidcToken: string | undefined;
  try {
    oidcToken = await yes.op(() => core.getIDToken("polaris-agents"), {
      name: "OIDC mint",
      retries: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ? [200, 1000] : [],
    })();
  } catch {
    // OIDC not available (local dev, non-actions environment, fork PRs)
  }

  // the action octokit has no retry plugin (only a 401 re-mint), and this runs
  // BEFORE the clean-error surface in main.ts - so a transient GitHub 5xx here
  // would reject the Promise.all and hard-crash the run at startup (while its
  // sibling fetchRunContext degrades to defaults). retry the transient blip.
  // see #999.
  const [repoResponse, runContext] = await Promise.all([
    yes.op(() => params.octokit.repos.get({ owner: repoContext.owner, repo: repoContext.name }), {
      name: "repos.get",
      retries: [100, 500],
      bail: (error) => !isTransientOctokitError(error),
    })(),
    fetchRunContext({ token: params.token, repoContext, oidcToken }),
  ]);

  return {
    repo: {
      owner: repoContext.owner,
      name: repoContext.name,
      data: repoResponse.data,
    },
    repoSettings: runContext.settings,
    apiToken: runContext.apiToken,
    oss: runContext.oss,
    plan: runContext.plan,
    proxyModel: runContext.proxyModel,
    dbSecrets: runContext.dbSecrets,
    commercialRefused: runContext.commercialRefused,
    // a failed mint on a runner that should have been able to mint is the same
    // outcome as the server-side failure: the run never sees stored secrets.
    secretsUnavailable:
      runContext.secretsUnavailable ||
      (!!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && oidcToken === undefined),
  };
}
