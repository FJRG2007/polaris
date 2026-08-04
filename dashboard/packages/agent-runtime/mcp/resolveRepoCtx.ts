import { type RepoAccess, repoKey } from "../toolState.ts";
import { createOctokit, type OctokitWithPlugins } from "../utils/github.ts";
import type { ToolContext } from "./server.ts";

/**
 * per-repo execution context for a single tool call. resolved from the
 * optional `repo` param (a bare repo name - owner-implicit, same account as
 * the primary). carries the correct token tier + working directory so a tool
 * can talk to GitHub and run git against the right checkout.
 */
export interface RepoCtx {
  owner: string;
  name: string;
  /** working tree: primary = process.cwd(); secondary = ctx.tmpdir/xrepo/<name> */
  dir: string;
  access: RepoAccess;
  /** octokit scoped to the repo's tier (write tokens for primary/write, read token for read) */
  octokit: OctokitWithPlugins;
  /** git token scoped to the repo's tier */
  gitToken: string;
  /** re-mint this tier's git token on an auth-class push failure (push retries) */
  refreshGitToken: ((stale: string) => Promise<string>) | undefined;
}

// read-tier octokit clients, memoized by read token. keying by token (rather
// than a single module slot) keeps long-lived processes - tests, `pnpm play`
// loops - from handing back a client built for a different run's token.
const readOctokitByToken = new Map<string, OctokitWithPlugins>();

/**
 * resolve the execution context for a `repo`-scoped tool call.
 *
 * - omitted / primary name → the primary ctx (unchanged single-repo path).
 * - a `write`-tier secondary → the same write-scoped tokens as the primary
 *   (mcpToken + gitToken are minted over the write set ∪ primary).
 * - a `read`-tier secondary → the contents:read token (clone-for-reference).
 *
 * throws when `repo` isn't a registered checkout - secondaries must be cloned
 * via `checkout_repo` first, which is what populates `toolState.repos`.
 */
export function resolveRepoCtx(ctx: ToolContext, repo?: string | undefined): RepoCtx {
  const owner = ctx.repo.owner;
  // `||`, not `??`: models fill optional string params with "" rather than
  // omitting them, and `??` passed that straight through to a `owner/` key that
  // matches nothing. 69 dead tool calls across 7 owners in the archived logs,
  // every one of them this shape. see #1134.
  const name = repo?.trim() || ctx.repo.name;
  const state = ctx.toolState.repos.get(repoKey(owner, name));
  if (!state) {
    // `requireRepoState`'s own message names `checkout_repo`, which is only
    // registered on --xrepo runs (server.ts) - on a single-repo run it sends the
    // agent after a tool it cannot see, so it retries verbatim instead.
    throw new Error(
      ctx.xrepo
        ? `repo ${repoKey(owner, name)} is not a registered checkout - use checkout_repo first`
        : `repo ${repoKey(owner, name)} is not a registered checkout - this run is single-repo, so omit \`repo\` to target ${owner}/${ctx.repo.name}`
    );
  }

  // primary + write secondaries share the write-tier tokens.
  if (state.access !== "read") {
    return {
      owner,
      name,
      dir: state.dir,
      access: state.access,
      octokit: ctx.octokit,
      gitToken: ctx.gitToken,
      refreshGitToken: ctx.refreshGitToken,
    };
  }

  // read-tier secondary: contents:read token, no PR/push capability.
  if (!ctx.readToken) {
    throw new Error(`no read token available for read-only repo ${owner}/${name}`);
  }
  let readOctokit = readOctokitByToken.get(ctx.readToken);
  if (!readOctokit) {
    readOctokit = createOctokit(ctx.readToken);
    readOctokitByToken.set(ctx.readToken, readOctokit);
  }
  return {
    owner,
    name,
    dir: state.dir,
    access: "read",
    octokit: readOctokit,
    gitToken: ctx.readToken,
    refreshGitToken: ctx.refreshGitToken,
  };
}
