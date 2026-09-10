/**
 * Moving a service between a Polaris server and a provider that builds its own.
 *
 * The board could already show both halves of a project - what Polaris runs and
 * what Vercel or Railway runs - and there was no way to get from one to the
 * other. Which meant the ordinary thing anybody actually does with staging and
 * production was the one thing this could not help with: somebody opened two
 * dashboards and copied thirty variables across by hand.
 *
 * **What travels is a repository, a set of variables, and a name.** That is the
 * whole of a service that is portable. The container image does not travel,
 * because the far end builds its own; the volumes do not, because a provider
 * that builds from a repository has nowhere to put them; the release history
 * does not, because it belongs to the machine that produced it. All three are
 * said on screen rather than left for somebody to discover.
 *
 * **The domain is nobody's to move here.** A name points where DNS says it
 * points, and that record is at a registrar Polaris may have no reach into. So a
 * move reports which names point at the half being left and stops there. Quietly
 * repointing somebody's production domain is not a thing a button should do.
 *
 * **Nothing is deleted, either way.** Moving out stops the service here and
 * leaves it, its variables and its history exactly where they are; moving home
 * leaves the provider's project untouched and still on the board. Both directions
 * are therefore undoable by hand in about a minute, which is the property that
 * makes a move safe to offer at all.
 *
 * Server-only: everything here reads secrets and holds somebody's provider token.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { decryptSecret } from "@polaris/storage";
import { setEnvVars } from "@/lib/env-var-service";
import { readCredential } from "@/lib/connections/store";
import { carriable, isPublicKey, repoFromSourceConfig } from "@/lib/deploy/migrate-rules";
import { createApplication, deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import {
    ProviderError,
    type ProviderDriver,
    type ProviderRef,
    type ServiceSource
} from "@/lib/deploy/providers/contract";
import {
    addExternalService,
    isProvider,
    listExternalServices,
    providerDriver,
    type ExternalServiceView
} from "@/lib/deploy/external-services";

/* -------------------------------------------------------------------------- */
/* Out of Polaris                                                             */
/* -------------------------------------------------------------------------- */

/** What a service here would take with it. */
export interface MoveOutPlan {
    readonly applicationId: string;
    readonly name: string;
    /** Where it is built from, as it is stored. Empty for a service built from
     *  an image or a Dockerfile rather than a repository. */
    readonly repoUrl: string;
    readonly branch: string;
    /** The names of what would be copied. Never the values: this answers a
     *  screen, and a screen is not where thirty secrets belong. Empty for a
     *  reader who may not see the variables at all, which is not the same as
     *  there being none - `variableCount` is the part everybody may be told. */
    readonly variableKeys: readonly string[];
    /** How many would travel. */
    readonly variableCount: number;
    /** The hostnames pointing at this half, which will go on pointing at it. */
    readonly domains: readonly string[];
    /** Whether it has volumes, which are the thing that cannot follow it. */
    readonly volumes: readonly string[];
    readonly running: boolean;
}

/** One application of this project, refusing rather than answering otherwise. */
async function ownApplication(projectId: string, applicationId: string) {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { projectId } },
        select: {
            id: true,
            name: true,
            environmentId: true,
            sourceType: true,
            sourceConfig: true,
            desiredState: true,
            domains: { select: { hostname: true } },
            volumes: { select: { name: true, mountPath: true } }
        }
    });
    if (!app) throw new ProviderError("That service is not in this project", "refused");
    return app;
}

/**
 * Everything a service here runs with, decrypted, as the far end would need it.
 *
 * Its own reader rather than the deploy pipeline's, and the difference is the
 * point: the pipeline adds what Polaris needs a container to know - a collector
 * address, an instance name - and none of that is anybody's to send to Vercel.
 */
async function localVariables(
    environmentId: string,
    applicationId: string
): Promise<Record<string, string>> {
    const rows = await prisma.envVar.findMany({
        where: {
            OR: [
                { scopeType: "environment", scopeId: environmentId },
                { scopeType: "application", scopeId: applicationId }
            ]
        }
    });
    // The environment's first, so the service's own value wins where both name
    // the same variable - which is the order the pipeline resolves them in.
    rows.sort((left, right) => Number(left.scopeType === "application") - Number(right.scopeType === "application"));

    const masterKey = loadEnv().POLARIS_MASTER_KEY;
    const values: Record<string, string> = {};
    for (const row of rows) {
        if (row.isSecret && row.encryptedValue && row.valueNonce) {
            values[row.key] = decryptSecret(
                {
                    ciphertext: Buffer.from(row.encryptedValue),
                    nonce: Buffer.from(row.valueNonce),
                    keyId: row.valueKeyId ?? ""
                },
                masterKey
            );
        } else if (row.value !== null) {
            values[row.key] = row.value;
        }
    }
    return carriable(values);
}

export async function moveOutPlan(projectId: string, applicationId: string): Promise<MoveOutPlan> {
    const app = await ownApplication(projectId, applicationId);
    const source = repoFromSourceConfig(app.sourceConfig);
    const variables = await localVariables(app.environmentId, app.id);
    return {
        applicationId: app.id,
        name: app.name,
        repoUrl: source.repoUrl,
        branch: source.branch,
        variableKeys: Object.keys(variables).sort(),
        variableCount: Object.keys(variables).length,
        domains: app.domains.map((domain) => domain.hostname),
        volumes: app.volumes.map((volume) => volume.mountPath || volume.name),
        running: app.desiredState === "running"
    };
}

export interface MoveOutInput {
    /** The linked account to move it to. */
    readonly connectionId: string;
    /** The provider's project, and whatever else names one thing inside it -
     *  the same pair the Elsewhere board is added with. */
    readonly externalId: string;
    readonly ref: ProviderRef;
    /** What it is called on this board once it is over there. */
    readonly name: string;
    readonly environmentId: string;
    /** Whether the copy carries the variables. Off is a real choice: somebody
     *  whose provider project is already configured wants the row and the link,
     *  not thirty values written over the ones they set. */
    readonly copyVariables: boolean;
    /** Whether the service here stops once it is over there. */
    readonly stopHere: boolean;
    /** Whether the provider is asked to build it now. */
    readonly releaseThere: boolean;
}

export interface MoveOutResult {
    readonly service: ExternalServiceView;
    readonly copied: number;
    readonly stopped: boolean;
    /** Why it is still running here, where it was meant to stop. A server that
     *  cannot be reached right now is not a failed move - everything else has
     *  happened - but it is not something to leave unsaid either. */
    readonly stopError: string | null;
    /** The names still pointing at the half that was left, which is the one part
     *  of this nobody here can finish. */
    readonly domains: readonly string[];
}

/**
 * Send a service to Vercel or Railway, and put it on this project's board.
 *
 * The order is what makes it safe: the variables are copied first, then the row
 * is added, then it is released, and only then is anything stopped here. So a
 * failure at any point leaves the service running exactly where it was.
 */
export async function moveOut(
    userId: string,
    projectId: string,
    applicationId: string,
    input: MoveOutInput
): Promise<MoveOutResult> {
    const app = await ownApplication(projectId, applicationId);
    const link = await prisma.userConnection.findFirst({
        where: { id: input.connectionId, userId },
        select: { id: true, provider: true }
    });
    if (!link) throw new ProviderError("That account is not connected to your profile", "refused");
    if (!isProvider(link.provider)) throw new ProviderError("Polaris cannot move a service there", "refused");

    let copied = 0;
    if (input.copyVariables) {
        const values = await localVariables(app.environmentId, app.id);
        if (Object.keys(values).length > 0) {
            const driver = driverOf(link.provider);
            await driver.putVariables(await tokenOf(link.id, link.provider), input.externalId, input.ref, values);
            copied = Object.keys(values).length;
        }
    }

    const service = await addExternalService(userId, projectId, {
        environmentId: input.environmentId,
        connectionId: input.connectionId,
        name: input.name,
        externalId: input.externalId,
        ref: input.ref
    });

    if (input.releaseThere) {
        const driver = driverOf(link.provider);
        // Best effort, and deliberately so: a project that has never built there
        // has nothing to repeat, which is a sentence about that project rather
        // than a failed move. The row is on the board either way, and its Deploy
        // button is right there.
        await driver
            .deploy(await tokenOf(link.id, link.provider), input.externalId, input.ref)
            .catch(() => undefined);
    }

    let stopped = false;
    let stopError: string | null = null;
    if (input.stopHere && app.desiredState === "running") {
        try {
            await setApplicationRunning(app.id, await ownerOf(projectId), false);
            stopped = true;
        } catch (caught) {
            // Last of the four things this does, and the only one that reaches a
            // machine which might be off. Everything else has already happened,
            // so the move stands and the screen says what is still up.
            stopError = caught instanceof Error ? caught.message : "It could not be stopped here";
        }
    }

    return {
        service,
        copied,
        stopped,
        stopError,
        domains: app.domains.map((domain) => domain.hostname)
    };
}

/* -------------------------------------------------------------------------- */
/* Into Polaris                                                               */
/* -------------------------------------------------------------------------- */

/** What a service out there would bring with it. */
export interface MoveHomePlan {
    readonly serviceId: string;
    readonly name: string;
    readonly provider: string;
    /** What the provider says it builds, where it will say. Null is an answer
     *  and not a failure - Railway does not publish it - and then the repository
     *  is asked for instead. */
    readonly source: ServiceSource | null;
    /** The same rule as the other direction: empty where the names are not this
     *  reader's to see, and the count beside it either way. */
    readonly variableKeys: readonly string[];
    readonly variableCount: number;
    /** Why the variables could not be read, where they could not. The provider's
     *  own words: a token that has expired has to say so. */
    readonly variablesError: string | null;
}

/** One external service of this project. */
async function ownService(projectId: string, serviceId: string) {
    const rows = await listExternalServices(projectId);
    const row = rows.find((one) => one.id === serviceId);
    if (!row) throw new ProviderError("That service is not in this project", "refused");
    const held = await prisma.externalService.findUnique({
        where: { id: serviceId },
        select: { provider: true, connectionId: true, externalId: true, ref: true, name: true }
    });
    if (!held) throw new ProviderError("That service is not in this project", "refused");
    let ref: ProviderRef = {};
    try {
        const parsed = JSON.parse(held.ref) as Record<string, unknown>;
        ref = Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
        );
    } catch {
        ref = {};
    }
    return { ...held, ref, view: row };
}

function driverOf(provider: string): ProviderDriver {
    const driver = providerDriver(provider);
    if (!driver) throw new ProviderError("Polaris cannot reach that service any more", "refused");
    return driver;
}

/** The token behind a link, or the sentence that says there is none. */
async function tokenOf(connectionId: string, provider: string): Promise<string> {
    const credential = await readCredential(connectionId);
    const token = credential?.token ?? credential?.accessToken;
    if (!token) {
        throw new ProviderError(
            `The ${provider} account this was added with is no longer connected. Link it again under Connected accounts.`,
            "unauthorized"
        );
    }
    return token;
}

/** Whose servers this project's services run on. Everything in the deploy
 *  pipeline is keyed on the owner rather than on whoever pressed the button. */
async function ownerOf(projectId: string): Promise<string> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { ownerId: true }
    });
    if (!project) throw new ProviderError("That project is gone", "refused");
    return project.ownerId;
}

export async function moveHomePlan(projectId: string, serviceId: string): Promise<MoveHomePlan> {
    const row = await ownService(projectId, serviceId);
    const driver = driverOf(row.provider);
    const token = await tokenOf(row.connectionId, row.provider);

    // Read together, and neither is allowed to take the other down with it: a
    // dialog that shows the repository and says why the variables are missing is
    // useful, and one that shows an error instead of both is not.
    const [source, variables] = await Promise.all([
        driver.source(token, row.externalId, row.ref).catch(() => null),
        driver
            .variables(token, row.externalId, row.ref)
            .then((values) => ({ values: carriable(values), error: null as string | null }))
            .catch((caught: unknown) => ({
                values: {} as Record<string, string>,
                error: caught instanceof Error ? caught.message : "Those could not be read"
            }))
    ]);

    return {
        serviceId,
        name: row.name,
        provider: row.provider,
        source,
        variableKeys: Object.keys(variables.values).sort(),
        variableCount: Object.keys(variables.values).length,
        variablesError: variables.error
    };
}

export interface MoveHomeInput {
    readonly environmentId: string;
    /** The server it runs on here. */
    readonly targetId: string;
    readonly name: string;
    /** The repository, which the provider may have supplied and may not. */
    readonly repoUrl: string;
    readonly branch: string;
    readonly copyVariables: boolean;
    /** Whether Polaris builds it now, or leaves it created and ready. */
    readonly deployNow: boolean;
}

export interface MoveHomeResult {
    readonly applicationId: string;
    readonly copied: number;
    readonly deploying: boolean;
    /** What could not be brought across, said plainly rather than left to be
     *  discovered on the first build. */
    readonly variablesError: string | null;
}

/**
 * Build and run a provider's service here instead.
 *
 * The provider's project is left exactly as it is, and stays on the board: this
 * is a service starting here, not one being taken away from there. Turning the
 * old one off is a decision for whoever is watching both, once they have seen
 * this one answer.
 */
export async function moveHome(
    userId: string,
    projectId: string,
    serviceId: string,
    input: MoveHomeInput
): Promise<MoveHomeResult> {
    const row = await ownService(projectId, serviceId);
    if (!input.repoUrl.trim()) {
        throw new ProviderError(
            "Polaris needs the repository this is built from. It is on the service's own page at the provider.",
            "refused"
        );
    }

    let values: Record<string, string> = {};
    let variablesError: string | null = null;
    if (input.copyVariables) {
        try {
            const driver = driverOf(row.provider);
            const token = await tokenOf(row.connectionId, row.provider);
            values = carriable(await driver.variables(token, row.externalId, row.ref));
        } catch (caught) {
            // Recorded rather than thrown. The service is worth creating either
            // way, and a screen that says which variables are missing is what
            // somebody needs; a move that refused would leave them with nothing.
            variablesError = caught instanceof Error ? caught.message : "The variables could not be read";
        }
    }

    const owner = await ownerOf(projectId);
    const application = await createApplication(owner, {
        environmentId: input.environmentId,
        targetId: input.targetId,
        name: input.name,
        sourceType: "git",
        sourceConfig: {
            repoUrl: input.repoUrl.trim(),
            ...(input.branch.trim() ? { branch: input.branch.trim() } : {})
        },
        // What a provider does by default, and what somebody moving off one
        // expects to keep: a push builds it. The branch is the one being built.
        autoDeploy: true,
        deployBranch: input.branch.trim() || null,
        // Reached through its domains, as it was on the provider it came from.
        publishPort: false
    });

    const entries = Object.entries(values).map(([key, value]) => ({
        key,
        value,
        isSecret: !isPublicKey(key)
    }));
    const copied = entries.length > 0 ? await setEnvVars("application", application.id, owner, entries) : 0;

    if (input.deployNow) {
        // Started and not waited for: a build is minutes long and this answers a
        // dialog. The service's own screen is where it is watched, which is where
        // the caller lands.
        void deployApplication(application.id, owner, userId).catch((error: unknown) => {
            console.error("polaris: the first build of a moved service did not start:", error);
        });
    }

    return {
        applicationId: application.id,
        copied,
        deploying: input.deployNow,
        variablesError
    };
}
