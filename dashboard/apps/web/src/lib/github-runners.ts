/**
 * Registering self-hosted runners with GitHub.
 *
 * This is the GitHub half of the Actions system: it turns "run jobs on my own
 * server" into a runner GitHub will hand work to. It authenticates through
 * whichever method the operator already connected (App installation token or
 * PAT), so nothing here knows or cares which one is in use.
 *
 * Every runner is registered just-in-time and ephemeral. `generate-jitconfig`
 * returns a configuration good for one runner that de-registers itself after a
 * single job, which means no long-lived credential is ever written to the
 * machine's disk. The alternative - a registration token and `config.sh` - leaves
 * a credential file behind that is exactly what gets stolen when a job on a
 * self-hosted runner turns out to be hostile.
 *
 * A GitHub App is the better of the two connections here: it can hold the narrow
 * organization runner permission instead of blanket repository administration,
 * its tokens expire on their own, and it is not tied to one person's account.
 */

import { evaluateRunnerAccess, normalizeRunnerLabels, type RunnerScope } from "@polaris/core";
import { getGithubStatus, githubApiToken, listGithubInstallations } from "@/lib/github-service";

const API = "https://api.github.com";

/** The default runner group. Named groups are an Enterprise/Team feature; every
 *  account has group 1, so that is what an unconfigured pool registers into. */
const DEFAULT_RUNNER_GROUP = 1;

function apiHeaders(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "polaris"
    };
}

/** Where a runner is being registered. A repo scope needs both parts. */
export interface RunnerTarget {
    scope: RunnerScope;
    owner: string;
    /** Required for `repo`, ignored for `org`. */
    repo?: string;
}

/** The REST path prefix for a target's runner endpoints. */
function runnersPath(target: RunnerTarget): string {
    return target.scope === "org"
        ? `/orgs/${encodeURIComponent(target.owner)}/actions/runners`
        : `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo ?? "")}/actions/runners`;
}

/** How a target reads in a message to the operator. */
function describe(target: RunnerTarget): string {
    return target.scope === "org" ? `the ${target.owner} organization` : `${target.owner}/${target.repo}`;
}

/**
 * Turn a GitHub refusal into something that says what to change. A 403 here is
 * almost always the missing runner permission, and the generic "Resource not
 * accessible by integration" that GitHub returns for it helps nobody.
 */
function accessError(status: number, target: RunnerTarget): Error {
    if (status === 403) {
        return new Error(
            target.scope === "org"
                ? `Polaris is not allowed to manage runners for ${target.owner}. Grant the connection the organization "Self-hosted runners: Read and write" permission.`
                : `Polaris is not allowed to manage runners on ${describe(target)}. Grant the connection "Administration: Read and write" on that repository, or register at the organization level instead.`
        );
    }
    if (status === 404) {
        return new Error(`Polaris cannot see ${describe(target)}. Check the GitHub App is installed there.`);
    }
    if (status === 401) return new Error("GitHub rejected the stored credentials. Reconnect it under Integrations.");
    return new Error(`GitHub returned ${status} managing runners on ${describe(target)}`);
}

async function tokenFor(target: RunnerTarget): Promise<string> {
    const token = await githubApiToken(target.owner);
    if (!token) throw new Error("GitHub is not connected");
    return token;
}

/** A registration good for exactly one runner, one job. */
export interface JitRunnerConfig {
    /** GitHub's id for the runner row, so it can be removed if it never starts. */
    runnerId: number;
    name: string;
    /** Base64 blob passed to the runner as `--jitconfig`. Treat as a secret: it
     *  authenticates as this runner until it is used or removed. */
    encodedConfig: string;
}

/**
 * Mint an ephemeral runner registration. The name must be unique for the target,
 * so callers pass one derived from the pool and the job rather than a fixed
 * string - GitHub refuses a name that is already taken.
 */
export async function createRunnerJitConfig(
    target: RunnerTarget,
    input: { name: string; labels: string[]; workFolder?: string }
): Promise<JitRunnerConfig> {
    if (target.scope === "repo" && !target.repo) throw new Error("A repository is required");
    const labels = normalizeRunnerLabels(input.labels);
    if (labels.length === 0) throw new Error("A runner needs at least one label");

    const token = await tokenFor(target);
    const res = await fetch(`${API}${runnersPath(target)}/generate-jitconfig`, {
        method: "POST",
        headers: { ...apiHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({
            name: input.name,
            runner_group_id: DEFAULT_RUNNER_GROUP,
            labels,
            work_folder: input.workFolder ?? "_work"
        }),
        cache: "no-store"
    });
    if (!res.ok) throw accessError(res.status, target);

    const body = (await res.json()) as { runner?: { id?: number; name?: string }; encoded_jit_config?: string };
    if (!body.encoded_jit_config || typeof body.runner?.id !== "number") {
        throw new Error("GitHub did not return a runner configuration");
    }
    return {
        runnerId: body.runner.id,
        name: body.runner.name ?? input.name,
        encodedConfig: body.encoded_jit_config
    };
}

/** One runner as GitHub currently sees it. */
export interface GithubRunner {
    id: number;
    name: string;
    status: string;
    busy: boolean;
    labels: string[];
}

/** Runners registered on a target, so Polaris can reconcile against reality
 *  rather than trusting its own record of what it started. */
export async function listGithubRunners(target: RunnerTarget): Promise<GithubRunner[]> {
    const token = await tokenFor(target);
    const res = await fetch(`${API}${runnersPath(target)}?per_page=100`, {
        headers: apiHeaders(token),
        cache: "no-store"
    });
    if (!res.ok) throw accessError(res.status, target);
    const body = (await res.json()) as {
        runners?: Array<{ id: number; name: string; status: string; busy: boolean; labels?: Array<{ name: string }> }>;
    };
    return (body.runners ?? []).map((runner) => ({
        id: runner.id,
        name: runner.name,
        status: runner.status,
        busy: runner.busy,
        labels: (runner.labels ?? []).map((label) => label.name)
    }));
}

/**
 * Remove a runner. An ephemeral runner de-registers itself after its job, so this
 * is for the ones that never got that far: a machine that died mid-job would
 * otherwise leave a row GitHub keeps queueing work onto.
 */
export async function deleteGithubRunner(target: RunnerTarget, runnerId: number): Promise<void> {
    const token = await tokenFor(target);
    const res = await fetch(`${API}${runnersPath(target)}/${runnerId}`, {
        method: "DELETE",
        headers: apiHeaders(token),
        cache: "no-store"
    });
    // Already gone is the outcome asked for, not a failure.
    if (res.status === 404) return;
    if (!res.ok) throw accessError(res.status, target);
}

/**
 * Whether the current connection can register runners, and what to change if it
 * cannot. Read before offering to add one, so the operator finds out here rather
 * than after provisioning a machine.
 *
 * A classic token announces its scopes in a response header; a fine-grained one
 * does not, which the evaluation reports as unknown rather than guessing.
 */
export async function getRunnerAccess() {
    const status = await getGithubStatus();
    if (status.method === "app") {
        return evaluateRunnerAccess({ method: "app", installations: await listGithubInstallations() });
    }
    if (status.method === "pat") {
        return evaluateRunnerAccess({ method: "pat", patScopes: await readPatScopes() });
    }
    return evaluateRunnerAccess({ method: null });
}

/** Scopes of the stored classic token, or null when GitHub reported none (which
 *  is what a fine-grained token looks like). */
async function readPatScopes(): Promise<string[] | null> {
    const token = await githubApiToken();
    if (!token) return null;
    const res = await fetch(`${API}/user`, { headers: apiHeaders(token), cache: "no-store" });
    const header = res.headers.get("x-oauth-scopes");
    if (header === null) return null;
    return header
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
}
