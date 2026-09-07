/**
 * Railway, as a place a project's services can be running.
 *
 * Their model has one more level than Vercel's: a deployment belongs to a service
 * AND an environment, and the project implies neither. So a choice here is a
 * project with its services under it, and what is stored is all three ids.
 *
 * Server-only.
 */

import * as railway from "@/lib/integrations/railway-api";
import {
    ProviderError,
    type ExternalState,
    type ExternalStatus,
    type ProviderChoice,
    type ProviderDriver
} from "@/lib/deploy/providers/contract";

export const RAILWAY = "railway";

/** Their statuses, as the board's words. */
const STATES: Readonly<Record<string, ExternalStatus>> = {
    QUEUED: "queued",
    WAITING: "queued",
    INITIALIZING: "building",
    BUILDING: "building",
    DEPLOYING: "building",
    SUCCESS: "live",
    FAILED: "failed",
    CRASHED: "failed",
    SKIPPED: "cancelled",
    REMOVED: "cancelled",
    REMOVING: "cancelled",
    NEEDS_APPROVAL: "queued",
    SLEEPING: "live"
};

async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof railway.RailwayError) throw new ProviderError(caught.message, caught.kind);
        throw caught;
    }
}

/**
 * Which environment a service is watched in.
 *
 * Production where they have one, and their first otherwise. A project with two
 * environments and no production is somebody's own naming, and picking the first
 * is better than refusing to show anything - the choice is stored on the row, so
 * it is visible and can be changed by pointing at it again.
 */
function environmentOf(environments: readonly railway.RailwayNamed[]): railway.RailwayNamed | null {
    const named = environments.find((environment) => environment.name.toLowerCase() === "production");
    return named ?? environments[0] ?? null;
}

/** The two ids a Railway deployment is addressed by, or the sentence that says
 *  the row is missing one. Checked once rather than at each use: a row written
 *  before either was stored is the only way this happens, and it has to read as
 *  something somebody can act on rather than as an undefined. */
function addressOf(ref: Readonly<Record<string, string>>): { service: string; environment: string } {
    const service = ref.service;
    const environment = ref.environment;
    if (!service || !environment) {
        throw new ProviderError("This service is missing what Railway needs to find it", "refused");
    }
    return { service, environment };
}

export const railwayDriver: ProviderDriver = {
    provider: RAILWAY,

    /**
     * Every project, with its services under it.
     *
     * One call for the list and one per project for what is inside: their list
     * query answers with names alone, and a service is the thing actually being
     * pointed at. A handful of projects is a handful of calls, which is what an
     * add screen can afford; nothing else here asks for this.
     */
    async choices(token) {
        const projects = await speaking(() => railway.railwayProjects(token));
        const found: ProviderChoice[] = [];
        for (const project of projects) {
            const full = await speaking(() => railway.railwayProject(token, project.id));
            const environment = environmentOf(full.environments);
            if (!environment) continue;
            found.push({
                id: project.id,
                name: full.name || project.name,
                children: full.services.map((service) => ({
                    id: service.id,
                    name: service.name,
                    // The environment travels with the service, because it is the
                    // other half of what a deployment is addressed by.
                    children: [{ id: environment.id, name: environment.name }]
                }))
            });
        }
        return found;
    },

    async state(token, externalId, ref) {
        const { service, environment } = addressOf(ref);
        const deployments = await speaking(() =>
            railway.railwayDeployments(token, {
                project: externalId,
                service,
                environment,
                limit: 1
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
        const at = last.createdAt ? new Date(last.createdAt) : null;
        return {
            status: STATES[last.status.toUpperCase()] ?? "unknown",
            url: last.staticUrl ? `https://${last.staticUrl.replace(/^https?:\/\//, "")}` : null,
            // Their dashboard has no address Polaris can build without guessing at
            // it, so nothing is offered rather than a link that lands nowhere.
            inspectUrl: null,
            at: at && !Number.isNaN(at.getTime()) ? at : null,
            commitSha: null,
            commitMessage: null,
            error: null
        } satisfies ExternalState;
    },

    /**
     * Nothing, always.
     *
     * Railway's public API has a mutation for connecting a service to a
     * repository and no documented way to read back the one it is already
     * connected to. Guessing at an undocumented field would be worse than this:
     * the move asks for the repository instead, which is one line somebody can
     * read off their own dashboard, and a wrong guess would be a service built
     * from the wrong code.
     */
    async source() {
        return null;
    },

    async variables(token, externalId, ref) {
        const { service, environment } = addressOf(ref);
        return speaking(() =>
            railway.railwayVariables(token, { project: externalId, service, environment })
        );
    },

    async putVariables(token, externalId, ref, values) {
        const { service, environment } = addressOf(ref);
        await speaking(() =>
            railway.railwaySetVariables(token, {
                project: externalId,
                service,
                environment,
                variables: values
            })
        );
    },

    async deploy(token, _externalId, ref) {
        const address = addressOf(ref);
        await speaking(() => railway.railwayDeploy(token, address));
    }
};
