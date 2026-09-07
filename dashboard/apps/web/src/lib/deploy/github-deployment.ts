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
 * It is announced as Polaris, not as whoever pressed deploy. Every other part of
 * Deploy prefers the project owner's own linked account, and this is the one
 * place that does the opposite: a deployment and a check belong to the thing that
 * built the release, which is why Vercel's box carries Vercel's name and mark
 * rather than the avatar of whoever pushed. The person's own credential is still
 * there behind it, for a repository the App was never installed on.
 */

import { prisma } from "@polaris/db";
import { publicAppUrl } from "@/lib/domain-service";
import { noteOnDeploy } from "@/lib/deploy/log-file";
import { parseGithubRepo } from "@/lib/repo-reference";
import { githubTokenForOwner } from "@/lib/github-access";
import { githubAppInstallationToken, publishCheck } from "@/lib/github-service";
import { noteDeploymentsRefused } from "@/lib/connections/health";
import { isPublicUrl } from "@/lib/agents/agent-repo-service";
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
    /** Whose linked account stands behind this, so a refusal reaches them. */
    ownerId: string;
    /**
     * What to announce with: the App installed on the repository where there is
     * one, so the commit carries Polaris rather than a person.
     */
    token: string;
    /**
     * The other credential, tried when the first is refused. Null when there was
     * only ever one. Whichever of them mints the deployment is the one that has
     * to move it afterwards, so `token` is reassigned rather than both being
     * tried again at every state.
     */
    fallback: string | null;
}

/**
 * Whether a deploy can be announced, and when it cannot, whether that is worth
 * saying.
 *
 * The distinction is the whole point of this type. A deploy of a Docker image has
 * no commit and never had anything to announce, so saying so on every build would
 * be noise. A deploy of a GitHub repository that cannot be announced is a feature
 * silently not working, and the operator has no way to tell the two apart - which
 * is exactly how this went unexplained: every reason to skip returned the same
 * nothing, so the commit stayed empty and no screen ever said why.
 */
type AnnounceTarget = { ok: true; info: Announceable } | { ok: false; reason: string | null };

/** Nothing to announce, and nothing to say about it. */
const NOT_APPLICABLE: AnnounceTarget = { ok: false, reason: null };

/**
 * The repository, the commit and the credential behind a deployment.
 *
 * Resolved in that order deliberately: everything before the repository decides
 * whether this is a GitHub deploy at all, and everything after it is a GitHub
 * deploy that will not appear - so the first group stays quiet and the second
 * group is named.
 */
async function announceable(deploymentId: string): Promise<AnnounceTarget> {
    const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { commitSha: true, deployableType: true, deployableId: true }
    });
    if (deployment?.deployableType !== "application") return NOT_APPLICABLE;

    const app = await prisma.application.findUnique({
        where: { id: deployment.deployableId },
        select: {
            name: true,
            slug: true,
            sourceConfig: true,
            environment: { select: { name: true, project: { select: { name: true, ownerId: true } } } }
        }
    });
    if (!app) return NOT_APPLICABLE;

    let source: Record<string, unknown>;
    try {
        source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    } catch {
        return NOT_APPLICABLE;
    }
    // An image, or a repository somewhere GitHub is not. Neither was ever going to
    // appear on a GitHub commit, so neither says anything.
    const parsed = parseGithubRepo(typeof source.repoUrl === "string" ? source.repoUrl : "");
    if (!parsed) return NOT_APPLICABLE;

    // From here down it IS a GitHub repository, so every way out is spoken.
    if (!deployment.commitSha) {
        return {
            ok: false,
            reason: `[warn] GitHub will not show this deploy on the commit: the commit being built could not be resolved, so there is nothing to attach it to. Check the service's branch, and that a connected account can read ${parsed.owner}/${parsed.repo}.`
        };
    }

    // Both, and the App first. A deployment written with somebody's own token is
    // a deployment GitHub attributes to them - their face on the commit for a
    // release they may not have pushed - and a check run is the App's to write in
    // the first place. The personal link stays as the fallback, because a
    // repository the App was never installed on can still be announced by
    // somebody who can reach it.
    const [installed, personal] = await Promise.all([
        githubAppInstallationToken(parsed.owner).catch(() => null),
        githubTokenForOwner(app.environment.project.ownerId, parsed.owner).catch(() => null)
    ]);
    const token = installed ?? personal;
    if (!token) {
        return {
            ok: false,
            reason: `[warn] GitHub will not show this deploy on the commit: no connected GitHub account speaks for ${parsed.owner}/${parsed.repo}. Link one under Connected accounts, or install the GitHub App on it.`
        };
    }

    const environmentName = app.environment.name.trim() || "production";
    return {
        ok: true,
        info: {
            owner: parsed.owner,
            repo: parsed.repo,
            commitSha: deployment.commitSha,
            applicationId: deployment.deployableId,
            // Qualified by the service, so a repository holding several of them gets a
            // row each on the commit instead of one they take turns overwriting.
            environment: `${environmentName}/${app.slug}`,
            label: `${app.environment.project.name} / ${app.name}`,
            production: environmentName.toLowerCase() === "production",
            ownerId: app.environment.project.ownerId,
            token,
            fallback: token === installed ? personal : null
        }
    };
}

/** The facts a check needs, for a deploy that was already announced. Null where
 *  it was not, which is the same set of reasons the deployment had. */
async function announceableOf(deploymentId: string): Promise<Announceable | null> {
    const target = await announceable(deploymentId);
    return target.ok ? target.info : null;
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
 *  would work from outside it either, which is most of them: `publicAppUrl` is
 *  the same test every other callback handed to an outside service is held to. */
async function logUrl(applicationId: string): Promise<string | null> {
    const base = await publicAppUrl().catch(() => null);
    if (!base) return null;
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
    // 403 and 404 were one sentence, and they are not one problem: GitHub answers
    // 404 for a repository a credential cannot see at all, which on a private
    // repository is what "the App is not installed here" looks like, and 403 for
    // one it can see but may not write deployments on. The old message asserted
    // the second for both, so half the time it named a permission that was
    // already granted and sent somebody to add it again. The status is quoted
    // now, because the next thing anybody does with this line is check it.
    if (status === 404) {
        return `[warn] GitHub will not show this deploy on the commit (404): no credential here can see ${owner}/${repo} well enough to write a deployment on it. Install the Polaris GitHub App on that repository, or link an account that reaches it, under Connected accounts.`;
    }
    if (status === 403) {
        return `[warn] GitHub will not show this deploy on the commit (403): the credential reaching ${owner}/${repo} may read it but not write deployments on it. Grant Deployments: Read and write - on the GitHub App's installation, or on the token under Connected accounts.`;
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
        const target = await announceable(deploymentId);
        if (!target.ok) {
            if (target.reason) await noteOnDeploy(deploymentId, target.reason);
            return;
        }
        const info = target.info;

        const mint = (token: string): Promise<AnnounceResult> =>
            createDeployment({
                owner: info.owner,
                repo: info.repo,
                ref: info.commitSha,
                environment: info.environment,
                description: `Deploying ${info.label} on Polaris`,
                production: info.production,
                token
            });

        let minted = await mint(info.token);
        // The App is tried first and the person second, which is the opposite of
        // everywhere else in Deploy and is deliberate - see the note at the top of
        // this file. Whichever of them mints it is the one the states that follow
        // are posted with, because a deployment can only be moved by the
        // credential that opened it.
        if (!minted.id && info.fallback && (minted.status === 403 || minted.status === 404)) {
            const retried = await mint(info.fallback);
            if (retried.id) info.token = info.fallback;
            minted = retried.id ? retried : minted;
        }
        if (!minted.id) {
            await noteOnDeploy(deploymentId, announceRefusal(minted.status, info.owner, info.repo));
            // The log line is for whoever opens this build. The notice is for the
            // person who can actually fix it, who has no reason to open a build
            // that succeeded - which is why this went unexplained for so long.
            if (minted.status === 403 || minted.status === 404) {
                await noteDeploymentsRefused(info.ownerId, info.owner, info.repo);
            }
            return;
        }
        const githubId = minted.id;
        await prisma.deployment.update({
            where: { id: deploymentId },
            data: { githubRepo: `${info.owner}/${info.repo}`, githubDeploymentId: githubId }
        });
        await announceCheck(info, "queued", "Waiting for a build slot", deploymentId);
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

/**
 * The line the commit shows in its list of checks.
 *
 * A deployment and a check are different things on a commit, and only the first
 * was ever written - which is why a Polaris deploy appeared under Deployments
 * and nowhere near "All checks have passed". That row is the one people read,
 * and it is the one Vercel and Railway occupy with a sentence and a Details
 * link. This is the same thing, said by Polaris.
 *
 * Beside the deployment rather than instead of it: the deployment is what puts
 * the environment and its address on the repository, and the check is what puts
 * a line where somebody is already looking.
 *
 * Swallows everything. A check that cannot be written is not a reason for a
 * deploy to fail, and the deployment beside it has already said whatever there
 * was to say about the credential.
 */
async function announceCheck(
    info: Announceable,
    status: "queued" | "in_progress" | "completed",
    summary: string,
    deploymentId: string,
    conclusion?: "success" | "failure" | "cancelled"
): Promise<void> {
    try {
        const where = await logUrl(info.applicationId);
        // Details belongs to the thing that did the work: Vercel's goes to Vercel,
        // and this one goes to the service's panel in Polaris, where the build log
        // is. The released address is not it - that is what the deployment's own
        // "View deployment" button carries - and it is only used here when this
        // Polaris has no address anybody outside could open, where a link to the
        // running site is better than none at all.
        const live =
            status === "completed" && conclusion === "success"
                ? await reachableUrl(deploymentId, info.applicationId)
                : null;
        const posted = await publishCheck({
            owner: info.owner,
            repo: info.repo,
            sha: info.commitSha,
            // Named for the service, so a repository holding several gets a line
            // each rather than one they take turns overwriting.
            name: `Polaris - ${info.label}`,
            status,
            conclusion,
            summary,
            detailsUrl: where ?? live,
            token: info.token
        });
        // Only an App may write one, and only where it is installed. The
        // deployment beside this has already reported the credential, so a
        // refusal here is not worth a second line in the same log.
        if (posted.status !== 200 && posted.status !== 201) {
            console.warn(`polaris: could not put a check on ${info.owner}/${info.repo}`);
        }
    } catch (error) {
        console.error("polaris: could not put a check on the commit:", error);
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
/** What the check row says for each state a deploy reaches. The words are the
 *  ones somebody reads without opening anything, which is what that row is
 *  for. */
const CHECK_WORDS: Record<DeploymentState, { status: "queued" | "in_progress" | "completed"; conclusion?: "success" | "failure" | "cancelled"; summary: string }> = {
    queued: { status: "queued", summary: "Waiting for a build slot" },
    in_progress: { status: "in_progress", summary: "Deployment is building" },
    success: { status: "completed", conclusion: "success", summary: "Deployment has completed" },
    failure: { status: "completed", conclusion: "failure", summary: "Deployment failed" },
    error: { status: "completed", conclusion: "cancelled", summary: "Deployment was stopped" },
    // A release that has been retired by a newer one. Nothing is posted for it -
    // the check on that commit already says what happened to that build, and
    // rewriting it to "inactive" would replace the outcome with its housekeeping.
    inactive: { status: "completed", conclusion: "success", summary: "Deployment has completed" }
};

async function postState(deploymentId: string, state: DeploymentState, description: string): Promise<void> {
    try {
        const target = await announced(deploymentId);
        if (!target) return;
        const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { deployableId: true, error: true }
        });
        if (!deployment) return;

        // The same resolution the mint used, App first, rather than a second one
        // that could pick a different credential and be refused for it.
        const info = await announceableOf(deploymentId);
        if (!info) return;

        // Resolved once rather than per attempt: neither depends on the credential,
        // and the retry below would otherwise pay for both a second time.
        const environmentUrl =
            state === "success" ? await reachableUrl(deploymentId, deployment.deployableId) : null;
        const where = await logUrl(deployment.deployableId);
        const post = (as: string): Promise<AnnounceResult> =>
            setDeploymentState({
                owner: target.owner,
                repo: target.repo,
                deploymentId: target.id,
                state,
                // The reason a deploy failed says more than the word "failure", and
                // it is the line somebody reads before deciding whether to open the
                // log at all.
                description: state === "failure" && deployment.error ? deployment.error : description,
                environmentUrl,
                logUrl: where,
                token: as
            });

        let posted = await post(info.token);
        // The same fallback the minting used, for the same reason: whichever
        // credential was allowed to open the deployment is the one allowed to
        // move it, and a box left reading "queued" forever is worse than none.
        if (info.fallback && (posted.status === 403 || posted.status === 404)) {
            posted = await post(info.fallback);
        }
        // Said once, when the deploy ends. A "queued" or "in progress" that GitHub
        // turned down is the same refusal as the verdict that follows it, and three
        // identical warnings in one log is noise nobody reads to the end of.
        if (posted.status !== 201 && state !== "queued" && state !== "in_progress") {
            await noteOnDeploy(deploymentId, announceRefusal(posted.status, target.owner, target.repo));
        }

        // And the row on the commit, which moves with it.
        const said = CHECK_WORDS[state];
        await announceCheck(
            info,
            said.status,
            state === "failure" && deployment.error ? deployment.error : said.summary,
            deploymentId,
            said.conclusion
        );
    } catch (error) {
        console.error("polaris: could not update this deploy on GitHub:", error);
    }
}
