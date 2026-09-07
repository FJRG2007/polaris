/**
 * AWS, as a place a project's services can be running.
 *
 * One provider covering two products, because that is what an AWS account is: a
 * key opens both, and somebody with a container service in ECS and a front end in
 * Amplify has one account and expects one entry. So the choice list holds both
 * kinds and the stored reference says which it is - `{kind: "ecs", cluster}` or
 * `{kind: "amplify", branch}` - and every method here branches on that one word.
 *
 * **Fargate is not a third kind.** It is a launch type inside ECS: the same
 * service, the same API, the same everything here. A separate entry for it would
 * be a second name for one thing, and somebody looking for their Fargate service
 * finds it under the cluster it is actually in.
 *
 * **App Runner is deliberately not offered.** AWS closed it to new customers on
 * 31 March 2026, so an entry for it would be an entry most people cannot use.
 *
 * What Polaris does here is what it does for every provider: says what the last
 * release did, and asks for another. It does not build, does not configure and
 * does not create anything - an ECS service's image comes from its task
 * definition and an Amplify branch builds from its repository, both of which are
 * decided in AWS by whoever set them up.
 *
 * Server-only.
 */

import * as aws from "@/lib/integrations/aws-api";
import type { AwsCredentials } from "@/lib/integrations/aws-sign";
import {
    ProviderError,
    type ExternalState,
    type ExternalStatus,
    type ProviderChoice,
    type ProviderDriver,
    type ProviderRef
} from "@/lib/deploy/providers/contract";

export const AWS = "aws";

/**
 * How an ECS rollout is going, in the board's words.
 *
 * Read from the primary deployment rather than from the service: a service is
 * `ACTIVE` from the moment it exists and stays `ACTIVE` through a rollout that is
 * failing, so it answers a different question than the one being asked.
 */
const ECS_STATES: Readonly<Record<string, ExternalStatus>> = {
    IN_PROGRESS: "building",
    COMPLETED: "live",
    FAILED: "failed"
};

/** Amplify's job statuses. `SUCCEED` is theirs, spelled that way. */
const AMPLIFY_STATES: Readonly<Record<string, ExternalStatus>> = {
    PENDING: "queued",
    PROVISIONING: "building",
    RUNNING: "building",
    SUCCEED: "live",
    FAILED: "failed",
    CANCELLING: "cancelled",
    CANCELLED: "cancelled"
};

async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof aws.AwsError) throw new ProviderError(caught.message, caught.kind);
        throw caught;
    }
}

/**
 * The credentials behind a link, out of what the connection store hands back.
 *
 * The region is part of the credential rather than part of the service, because
 * an AWS key is not regional and everything it reaches is: the same key lists
 * nothing at all in the wrong region, with no error to say why. So the region is
 * asked for when the account is linked and travels with it.
 */
function credentialsOf(token: string): AwsCredentials {
    let parsed: unknown;
    try {
        parsed = JSON.parse(token) as unknown;
    } catch {
        throw new ProviderError("That AWS account has to be linked again", "unauthorized");
    }
    const held = parsed as Partial<AwsCredentials>;
    if (!held?.accessKeyId || !held.secretAccessKey || !held.region) {
        throw new ProviderError("That AWS account has to be linked again", "unauthorized");
    }
    return {
        accessKeyId: held.accessKeyId,
        secretAccessKey: held.secretAccessKey,
        region: held.region,
        ...(held.sessionToken ? { sessionToken: held.sessionToken } : {})
    };
}

/** Which product a row points at, and the rest of what names it there. */
function addressOf(ref: ProviderRef): { kind: "ecs" | "amplify"; cluster: string; branch: string } {
    const kind = ref.kind === "amplify" ? "amplify" : "ecs";
    if (kind === "ecs" && !ref.cluster) {
        throw new ProviderError("This service is missing the cluster it runs in", "refused");
    }
    if (kind === "amplify" && !ref.branch) {
        throw new ProviderError("This service is missing the branch it builds", "refused");
    }
    return { kind, cluster: ref.cluster ?? "", branch: ref.branch ?? "" };
}

const NOTHING: ExternalState = {
    status: "unknown",
    url: null,
    inspectUrl: null,
    at: null,
    commitSha: null,
    commitMessage: null,
    error: null
};

/** Their console, which is where "open it there" goes. Built from the region and
 *  the ids, which is the one address AWS's own pages are reliably at. */
function consoleUrl(region: string, path: string): string {
    return `https://${region}.console.aws.amazon.com/${path}`;
}

export const awsDriver: ProviderDriver = {
    provider: AWS,

    /**
     * Everything this key can see, in both products.
     *
     * ECS is two levels - a cluster holds services - and Amplify is two levels as
     * well, an app holding branches. Both fit the same shape the picker already
     * draws: a project with things inside it.
     *
     * Neither half is allowed to take the other down. A key with an ECS policy and
     * no Amplify one is ordinary, and answering "your account has nothing in it"
     * because the second listing was refused would be a lie about the first.
     */
    async choices(token) {
        const credentials = credentialsOf(token);
        const found: ProviderChoice[] = [];

        const clusters = await speaking(() => aws.ecsClusters(credentials)).catch(() => []);
        for (const cluster of clusters) {
            const services = await aws.ecsServices(credentials, cluster).catch(() => []);
            if (services.length === 0) continue;
            found.push({
                id: `ecs:${cluster}`,
                name: `ECS / ${aws.arnName(cluster)}`,
                // The cluster is a heading. A service is the thing that runs, and
                // it is addressed by its own ARN plus the cluster it is in.
                children: services.map((service) => ({
                    id: `ecs:${cluster}:${service}`,
                    name: aws.arnName(service),
                    externalId: service,
                    ref: { kind: "ecs", cluster }
                }))
            });
        }

        const apps = await speaking(() => aws.amplifyApps(credentials)).catch(() => []);
        for (const app of apps) {
            const branches = await aws.amplifyBranches(credentials, app.appId).catch(() => []);
            found.push({
                id: `amplify:${app.appId}`,
                name: `Amplify / ${app.name || app.appId}`,
                // Same shape: the app is a heading, a branch is what deploys. The
                // app's own domain travels along, because it is what a branch's
                // address is built from and nothing else here can ask for it.
                children: branches.map((branch) => ({
                    id: `amplify:${app.appId}:${branch.branchName}`,
                    name: branch.branchName,
                    externalId: app.appId,
                    ref: {
                        kind: "amplify",
                        branch: branch.branchName,
                        ...(app.defaultDomain ? { domain: app.defaultDomain } : {})
                    }
                }))
            });
        }

        if (found.length === 0) {
            throw new ProviderError(
                "That key can see no ECS services and no Amplify apps in this region. Check the region it was linked with, and that it is allowed to list them.",
                "refused"
            );
        }
        return found;
    },

    async state(token, externalId, ref) {
        const credentials = credentialsOf(token);
        const address = addressOf(ref);

        if (address.kind === "amplify") {
            const jobs = await speaking(() =>
                aws.amplifyJobs(credentials, externalId, address.branch)
            );
            const last = jobs[0];
            if (!last) return NOTHING;
            const at = last.endTime ?? last.startTime;
            return {
                status: AMPLIFY_STATES[last.status.toUpperCase()] ?? "unknown",
                // Their branch address, which is how an Amplify site is reached
                // before anybody points a domain at it.
                url: ref.domain ? `https://${address.branch}.${ref.domain}` : null,
                inspectUrl: consoleUrl(
                    credentials.region,
                    `amplify/apps/${encodeURIComponent(externalId)}/branches/${encodeURIComponent(address.branch)}`
                ),
                at: at ? new Date(at * (at > 1e12 ? 1 : 1000)) : null,
                commitSha: last.commitId || null,
                commitMessage: last.commitMessage || null,
                error: null
            } satisfies ExternalState;
        }

        const service = await speaking(() =>
            aws.ecsService(credentials, address.cluster, externalId)
        );
        if (!service) return NOTHING;
        // The one being rolled out, which is the only one that answers "what is it
        // doing now"; an older ACTIVE deployment is what it was doing before.
        const primary = service.deployments.find((one) => one.status === "PRIMARY") ?? service.deployments[0];
        const at = primary?.updatedAt ?? primary?.createdAt ?? null;
        return {
            status: primary?.rolloutState
                ? (ECS_STATES[primary.rolloutState.toUpperCase()] ?? "unknown")
                : service.status === "ACTIVE" && service.runningCount > 0
                  ? "live"
                  : "unknown",
            // ECS has no address of its own: a service is reached through whatever
            // load balancer somebody put in front of it, which is not something to
            // guess at.
            url: null,
            inspectUrl: consoleUrl(
                credentials.region,
                `ecs/v2/clusters/${encodeURIComponent(aws.arnName(address.cluster))}/services/${encodeURIComponent(aws.arnName(externalId))}`
            ),
            at: at ? new Date(at * (at > 1e12 ? 1 : 1000)) : null,
            // A task definition revision rather than a commit: it is what ECS
            // deploys, and it is the identifier somebody would look up.
            commitSha: primary?.taskDefinition ? aws.arnName(primary.taskDefinition) : null,
            commitMessage: null,
            error: primary?.rolloutStateReason && primary.rolloutState === "FAILED"
                ? primary.rolloutStateReason
                : null
        } satisfies ExternalState;
    },

    async deploy(token, externalId, ref) {
        const credentials = credentialsOf(token);
        const address = addressOf(ref);
        if (address.kind === "amplify") {
            await speaking(() => aws.amplifyRelease(credentials, externalId, address.branch));
            return;
        }
        await speaking(() => aws.ecsRedeploy(credentials, address.cluster, externalId));
    },

    /**
     * Nothing, in both products, and for the same reason each time.
     *
     * An ECS service runs an image its task definition names; the repository that
     * produced that image is somebody's build pipeline and is not written down
     * anywhere ECS can be asked. An Amplify app does know its repository, and
     * reading it would work - but a service brought home from Amplify is a static
     * front end whose build Polaris would have to reproduce, and offering half of
     * that move is worse than being clear that it is not offered.
     */
    async source() {
        return null;
    },

    /**
     * Nothing to read, and nothing accepted.
     *
     * Both products hold their variables somewhere a move cannot honestly copy:
     * an ECS task definition is versioned, so writing a variable means minting a
     * new revision of somebody's deployment spec, and Amplify's are per app and
     * per branch with a build that has to be restarted to pick them up. Pretending
     * otherwise would be a move that reports success and changes nothing.
     */
    async variables() {
        return {};
    },

    async putVariables() {
        throw new ProviderError(
            "Polaris does not write variables into AWS. An ECS service takes them from its task definition and an Amplify app from its own settings, and changing either from here would rewrite somebody's deployment spec.",
            "refused"
        );
    }
};
