/**
 * Vercel, as a place a project's services can be running.
 *
 * Their vocabulary in ours: a project is the thing to point at, a team is what
 * else has to be named to find it, and a deployment's `readyState` is the word
 * the board draws. Nothing above this file knows any of that.
 *
 * Server-only.
 */

import * as vercel from "@/lib/integrations/vercel-api";
import {
    ProviderError,
    type ExternalState,
    type ExternalStatus,
    type ProviderChoice,
    type ProviderDriver
} from "@/lib/deploy/providers/contract";

export const VERCEL = "vercel";

/** Their states: QUEUED, INITIALIZING, BUILDING, READY, ERROR, CANCELED,
 *  BLOCKED, DELETED. Anything unlisted is real and not worth a word of its own. */
const STATES: Readonly<Record<string, ExternalStatus>> = {
    QUEUED: "queued",
    INITIALIZING: "building",
    BUILDING: "building",
    READY: "live",
    ERROR: "failed",
    CANCELED: "cancelled",
    BLOCKED: "cancelled",
    DELETED: "unknown"
};

async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof vercel.VercelError) throw new ProviderError(caught.message, caught.kind);
        throw caught;
    }
}

/** A string off their metadata, or null. Their `meta` is whatever the git
 *  provider told them, under the git provider's own names. */
function metaOf(meta: Record<string, unknown>, key: string): string | null {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const vercelDriver: ProviderDriver = {
    provider: VERCEL,

    /**
     * Every project this token reaches, the account's own and each team's.
     *
     * Teams are asked for first because most work worth watching is under one,
     * and a token that names no team answers with the personal projects alone -
     * which looks exactly like an account with nothing in it.
     */
    async choices(token) {
        const teams = await speaking(() => vercel.vercelTeams(token));
        const scopes: { id: string | null; name: string }[] = [
            { id: null, name: "Personal" },
            ...teams.map((team) => ({ id: team.id, name: team.name || team.slug }))
        ];
        const found: ProviderChoice[] = [];
        for (const scope of scopes) {
            const projects = await speaking(() => vercel.vercelProjects(token, scope.id));
            for (const project of projects) {
                found.push({
                    id: project.id,
                    // Named by scope where there is more than one, so two projects
                    // called "web" are tellable apart before either is chosen.
                    name: scopes.length > 1 ? `${scope.name} / ${project.name}` : project.name,
                    children: scope.id ? [{ id: scope.id, name: scope.name }] : []
                });
            }
        }
        return found;
    },

    async state(token, externalId, ref) {
        const deployments = await speaking(() =>
            vercel.vercelDeployments(token, {
                project: externalId,
                team: ref.team ?? null,
                limit: 1,
                target: "production"
            })
        );
        const last = deployments[0];
        if (!last) {
            return {
                status: "unknown",
                url: null,
                inspectUrl: null,
                at: null,
                commitSha: null,
                commitMessage: null,
                error: null
            } satisfies ExternalState;
        }
        const at = last.created ?? last.createdAt;
        return {
            status: STATES[last.readyState || last.state] ?? "unknown",
            // Their url is a hostname; the scheme is always https, and a link
            // without one is a link a browser reads as a path.
            url: last.url ? `https://${last.url}` : null,
            inspectUrl: last.inspectorUrl,
            at: at ? new Date(at) : null,
            commitSha:
                metaOf(last.meta, "githubCommitSha") ??
                metaOf(last.meta, "gitlabCommitSha") ??
                metaOf(last.meta, "bitbucketCommitSha"),
            commitMessage:
                metaOf(last.meta, "githubCommitMessage") ??
                metaOf(last.meta, "gitlabCommitMessage") ??
                metaOf(last.meta, "bitbucketCommitMessage"),
            error: last.errorMessage
        } satisfies ExternalState;
    },

    /**
     * Release the latest again.
     *
     * Their redeploy names a deployment rather than a project, so the newest one
     * is read first and repeated. A project that has never deployed has nothing
     * to repeat, and says so rather than failing at their end.
     */
    async deploy(token, externalId, ref) {
        const deployments = await speaking(() =>
            vercel.vercelDeployments(token, {
                project: externalId,
                team: ref.team ?? null,
                limit: 1,
                target: "production"
            })
        );
        const last = deployments[0];
        if (!last) {
            throw new ProviderError(
                "This project has never deployed on Vercel, so there is nothing to release again. Push to it, or deploy it there once.",
                "refused"
            );
        }
        await speaking(() =>
            vercel.vercelRedeploy(token, {
                name: last.name || externalId,
                deployment: last.uid,
                team: ref.team ?? null,
                target: "production"
            })
        );
    }
};
