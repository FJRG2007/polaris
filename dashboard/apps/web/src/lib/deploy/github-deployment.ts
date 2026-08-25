/**
 * Telling GitHub what Polaris is doing with a commit.
 *
 * A repository deployed from here had no idea it was: the commit page showed the
 * deployment box for Vercel and for Railway, and nothing for the service Polaris
 * had actually built and put in front of traffic. Everything needed to fill it in
 * was already known - which commit, which environment, whether it came up, and the
 * address it came up on - and none of it was ever sent.
 *
 * So a deploy from a GitHub source announces itself three times: queued when it
 * takes its place on the target's queue, in progress when the build starts, and
 * the verdict when it ends. GitHub mints the deployment on the first of those, and
 * the id it minted is kept on the row because the other two are posted against it.
 *
 * Every function here swallows its failures. A repository nobody here can write
 * to, a token without the permission, GitHub being down - none of them are a
 * reason for a deploy to fail or even to slow down, and a deploy that stopped
 * because it could not announce itself would be a worse product than one that
 * never announced anything.
 *
 * Who it is announced as follows the same rule the rest of Deploy runs by
 * (`githubTokenForOwner`): the project owner's own linked account, and the App
 * installed on this Polaris behind it. Nobody is asked for a new credential.
 */

import { prisma } from "@polaris/db";
import { appBaseUrl } from "@/lib/domain-service";
import { parseGithubRepo } from "@/lib/repo-reference";
import { githubTokenForOwner } from "@/lib/github-access";
import { isPublicUrl } from "@/lib/agents/agent-repo-service";
import { noteOnDeploy } from "@/lib/deploy/log-file";
import { createDeployment, setDeploymentState, type AnnounceResult, type DeploymentState } from "@/lib/github-service";

/** What a deploy needs before it can be announced at all. */
interface Announceable {
    owner: string;
    repo: string;
    commitSha: string;
    applicationId: string;
    /** GitHub's environment name, which is what its deployment box is grouped by. */
    environment: string;
    /** The service, for the one line GitHub shows beside the state. */
    label: string;
    production: boolean;
    token: string;
}

/**
 * The repository, the commit and the credential behind a deployment, or null when
 * any of them is missing - which is every deploy that is not an application built
 * from a GitHub repository at a known commit.
 */
async function announceable(deploymentId: string): Promise<Announceable | null> {
    const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { commitSha: true, deployableType: true, deployableId: true }
    });
    if (deployment?.deployableType !== "application" || !deployment.commitSha) return null;

    const app = await prisma.application.findUnique({
        where: { id: deployment.deployableId },
        select: {
            name: true,
            slug: true,
            sourceConfig: true,
            environment: { select: { name: true, project: { select: { name: true, ownerId: true } } } }
        }
    });
    if (!app) return null;

    let source: Record<string, unknown>;
    try {
        source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    } catch {
        return null;
    }
    const parsed = parseGithubRepo(typeof source.repoUrl === "string" ? source.repoUrl : "");
    if (!parsed) return null;

    const token = await githubTokenForOwner(app.environment.project.ownerId, parsed.owner).catch(() => null);
    if (!token) return null;

    const environmentName = app.environment.name.trim() || "production";
    return {
        owner: parsed.owner,
        repo: parsed.repo,
        commitSha: deployment.commitSha,
        applicationId: deployment.deployableId,
        // Qualified by the service, so a repository holding several of them gets a
        // row each on the commit instead of one they take turns overwriting.
        environment: `${environmentName}/${app.slug}`,
        label: `${app.environment.project.name} / ${app.name}`,
        production: environmentName.toLowerCase() === "production",
        token
    };
}

/** The repository and id a deployment was announced as, or null when it never was. */
async function announced(deploymentId: string): Promise<{ owner: string; repo: string; id: string } | null> {
    const row = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { githubRepo: true, githubDeploymentId: true }
    });
    if (!row?.githubRepo || !row.githubDeploymentId) return null;
    const [owner = "", repo = ""] = row.githubRepo.split("/");
    if (!owner || !repo) return null;
    return { owner, repo, id: row.githubDeploymentId };
}

/**
 * Where this release can actually be reached from, or null when the answer is
 * "from in here only".
 *
 * Its own release hostname first when it has one, because that is the build the
 * commit is about - the service's own address follows whichever release is
 * current, and by the time somebody clicks it may be serving a different one.
 * Anything not reachable off this network is left out rather than handed over: a
 * "View deployment" button that goes to a name resolving nowhere is worse than no
 * button, and a LAN install has nothing else to offer.
 */
async function reachableUrl(deploymentId: string, applicationId: string): Promise<string | null> {
    const domains = await prisma.domain.findMany({
        where: { applicationId, enabled: true },
        select: { hostname: true, https: true, pathPrefix: true, kind: true, deploymentId: true }
    });
    const ordered = [
        ...domains.filter((domain) => domain.kind === "release" && domain.deploymentId === deploymentId),
        ...domains.filter((domain) => domain.kind !== "release")
    ];
    for (const domain of ordered) {
        const url = `${domain.https ? "https" : "http"}://${domain.hostname}${domain.pathPrefix ?? ""}`;
        if (isPublicUrl(url)) return url;
    }
    return null;
}

/** The service's own panel, where GitHub sends whoever asks what happened - the
 *  build log is the first thing on it. Null when this Polaris has no address that
 *  would work from outside it either, which is most of them. */
async function logUrl(applicationId: string): Promise<string | null> {
    const base = (await appBaseUrl().catch(() => null))?.replace(/\/+$/, "") ?? null;
    if (!isPublicUrl(base)) return null;
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environment: { select: { projectId: true } } }
    });
    if (!app) return null;
    return `${base}/apps/deploy/${app.environment.projectId}?service=${applicationId}`;
}

/**
 * Why GitHub would not show this deploy, written for the deploy's own log.
 *
 * It goes there because that is the only place its operator looks, and because
 * the commonest answer by far is a token nobody told them needed anything else:
 * Polaris asks for a GitHub token that can read a repository's contents, and
 * writing to a repository's deployments is a permission of its own that a
 * fine-grained token does not carry unless it was ticked.
 */
export function announceRefusal(status: number, owner: string, repo: string): string {
    if (status === 403 || status === 404) {
        return `[warn] GitHub will not show this deploy on the commit: the connected account needs Deployments: Read and write on ${owner}/${repo}. Add it to the token under Connected accounts, or connect the account through the GitHub App.`;
    }
    if (status === 409) {
        return `[warn] GitHub will not show this deploy on the commit: ${owner}/${repo} answered that this commit conflicts with the branch it deploys.`;
    }
    if (status === 0) return "[warn] GitHub could not be reached, so this deploy is not shown on the commit.";
    return `[warn] GitHub answered ${status} and will not show this deploy on the commit.`;
}

/**
 * Announce a deploy that has just been queued: mint the GitHub deployment and
 * record the id the rest of its life is posted against.
 *
 * Called once, from the moment the row is created. A second call is a no-op
 * rather than a second box on the commit.
 */
export async function announceDeployQueued(deploymentId: string): Promise<void> {
    try {
        if (await announced(deploymentId)) return;
        const info = await announceable(deploymentId);
        if (!info) return;

        const minted = await createDeployment({
            owner: info.owner,
            repo: info.repo,
            ref: info.commitSha,
            environment: info.environment,
            description: `Deploying ${info.label} on Polaris`,
            production: info.production,
            token: info.token
        });
        if (!minted.id) {
            await noteOnDeploy(deploymentId, announceRefusal(minted.status, info.owner, info.repo));
            return;
        }
        const githubId = minted.id;
        await prisma.deployment.update({
            where: { id: deploymentId },
            data: { githubRepo: `${info.owner}/${info.repo}`, githubDeploymentId: githubId }
        });
        await setDeploymentState({
            owner: info.owner,
            repo: info.repo,
            deploymentId: githubId,
            state: "queued",
            description: "Waiting for a build slot",
            logUrl: await logUrl(info.applicationId),
            token: info.token
        });
    } catch (error) {
        console.error("polaris: could not announce this deploy to GitHub:", error);
    }
}

/** Move an announced deploy to "in progress", which is what the repository shows
 *  while the build runs. Silent for a deploy that was never announced. */
export async function announceDeployStarted(deploymentId: string): Promise<void> {
    await postState(deploymentId, "in_progress", "Building");
}

/**
 * Close an announced deploy out.
 *
 * GitHub has no cancelled state, so a stopped deploy lands on `error` with the
 * reason in words: it did not succeed, and leaving it reading "in progress"
 * forever is the one outcome worth avoiding.
 */
export async function announceDeployFinished(deploymentId: string, status: string): Promise<void> {
    if (status === "running") {
        await postState(deploymentId, "success", "Live");
        return;
    }
    if (status === "failed") {
        await postState(deploymentId, "failure", "The deploy failed");
        return;
    }
    if (status === "cancelled") await postState(deploymentId, "error", "The deploy was stopped");
}

/** One state, posted against whatever this deployment was announced as. */
async function postState(deploymentId: string, state: DeploymentState, description: string): Promise<void> {
    try {
        const target = await announced(deploymentId);
        if (!target) return;
        const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { deployableId: true, error: true }
        });
        if (!deployment) return;

        const app = await prisma.application.findUnique({
            where: { id: deployment.deployableId },
            select: { environment: { select: { project: { select: { ownerId: true } } } } }
        });
        const token = await githubTokenForOwner(app?.environment.project.ownerId ?? null, target.owner).catch(
            () => null
        );
        if (!token) return;

        const posted: AnnounceResult = await setDeploymentState({
            owner: target.owner,
            repo: target.repo,
            deploymentId: target.id,
            state,
            // The reason a deploy failed says more than the word "failure", and it is
            // the line somebody reads before deciding whether to open the log at all.
            description: state === "failure" && deployment.error ? deployment.error : description,
            environmentUrl: state === "success" ? await reachableUrl(deploymentId, deployment.deployableId) : null,
            logUrl: await logUrl(deployment.deployableId),
            token
        });
        // Said once, when the deploy ends. A "queued" or "in progress" that GitHub
        // turned down is the same refusal as the verdict that follows it, and three
        // identical warnings in one log is noise nobody reads to the end of.
        if (posted.status !== 201 && state !== "queued" && state !== "in_progress") {
            await noteOnDeploy(deploymentId, announceRefusal(posted.status, target.owner, target.repo));
        }
    } catch (error) {
        console.error("polaris: could not update this deploy on GitHub:", error);
    }
}
