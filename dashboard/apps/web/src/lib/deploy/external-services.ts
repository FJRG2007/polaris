/**
 * The services a project runs somewhere that is not Polaris.
 *
 * Polaris is a control plane here and nothing more: it does not build these, does
 * not serve them and does not hold anything they need. What it does is put them
 * on the same board as the rest of the project, keep the last reading beside them,
 * and offer the one action anybody wants from a screen they are already on -
 * release it again.
 *
 * A row points at a link rather than holding a credential, so unlinking the
 * account under Connected accounts takes the reach away with it and leaves the
 * row saying so. That is deliberate: a service somebody can reconnect is a better
 * outcome than a service that quietly disappeared off the board.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { readCredential } from "@/lib/connections/store";
import { VERCEL, vercelDriver } from "@/lib/deploy/providers/vercel";
import { RAILWAY, railwayDriver } from "@/lib/deploy/providers/railway";
import {
    ProviderError,
    type ExternalState,
    type ProviderChoice,
    type ProviderDriver,
    type ProviderRef
} from "@/lib/deploy/providers/contract";

/** Everywhere Polaris can watch a service run. Adding one is an entry here and a
 *  driver; nothing else in the app names a provider. */
const DRIVERS: Readonly<Record<string, ProviderDriver>> = {
    [VERCEL]: vercelDriver,
    [RAILWAY]: railwayDriver
};

export function providerDriver(provider: string): ProviderDriver | null {
    return DRIVERS[provider] ?? null;
}

export function isProvider(provider: string): boolean {
    return provider in DRIVERS;
}

/** How long a reading is trusted before the screen asks again. A provider's own
 *  dashboard is where somebody watches a build minute by minute; this is the
 *  board saying what is out there, and a minute is fresh enough for that. */
const READING_TTL_MS = 60_000;

/** One of these as a screen sees it. No token, and no id of anybody else's. */
export interface ExternalServiceView {
    readonly id: string;
    readonly provider: string;
    readonly name: string;
    readonly slug: string;
    readonly environmentId: string;
    /** queued | building | live | failed | cancelled | unknown. */
    readonly status: string;
    readonly url: string | null;
    readonly inspectUrl: string | null;
    readonly lastDeployAt: string | null;
    readonly lastCommitSha: string | null;
    readonly lastCommitMessage: string | null;
    /** Why the last read failed. The provider's words, or the sentence that says
     *  the link behind it is gone. */
    readonly error: string | null;
    readonly checkedAt: string | null;
    /** What it is called on the provider, so somebody can tell two of them apart
     *  without opening either. */
    readonly account: string | null;
}

const FIELDS = {
    id: true,
    provider: true,
    connectionId: true,
    name: true,
    slug: true,
    environmentId: true,
    externalId: true,
    ref: true,
    status: true,
    url: true,
    inspectUrl: true,
    lastDeployAt: true,
    lastCommitSha: true,
    lastCommitMessage: true,
    error: true,
    checkedAt: true
} as const;

type Row = {
    id: string;
    provider: string;
    connectionId: string;
    name: string;
    slug: string;
    environmentId: string;
    externalId: string;
    ref: string;
    status: string;
    url: string | null;
    inspectUrl: string | null;
    lastDeployAt: Date | null;
    lastCommitSha: string | null;
    lastCommitMessage: string | null;
    error: string | null;
    checkedAt: Date | null;
};

function refOf(row: Row): ProviderRef {
    try {
        const parsed = JSON.parse(row.ref) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        const ref: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "string") ref[key] = value;
        }
        return ref;
    } catch {
        return {};
    }
}

function toView(row: Row, account: string | null): ExternalServiceView {
    return {
        id: row.id,
        provider: row.provider,
        name: row.name,
        slug: row.slug,
        environmentId: row.environmentId,
        status: row.status,
        url: row.url,
        inspectUrl: row.inspectUrl,
        lastDeployAt: row.lastDeployAt?.toISOString() ?? null,
        lastCommitSha: row.lastCommitSha,
        lastCommitMessage: row.lastCommitMessage,
        error: row.error,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        account
    };
}

/** What the links behind a set of rows are called, in one query rather than one
 *  each. A link that has been removed is simply absent, which is what the row's
 *  own error says out loud on the next read. */
async function accountsFor(rows: readonly Row[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.connectionId))];
    if (ids.length === 0) return new Map();
    const links = await prisma.userConnection.findMany({
        where: { id: { in: ids } },
        select: { id: true, label: true }
    });
    return new Map(links.map((link) => [link.id, link.label]));
}

/** Everything this project runs elsewhere, by environment. */
export async function listExternalServices(projectId: string): Promise<ExternalServiceView[]> {
    const rows = await prisma.externalService.findMany({
        where: { environment: { projectId } },
        orderBy: [{ name: "asc" }],
        select: FIELDS
    });
    const accounts = await accountsFor(rows);
    return rows.map((row) => toView(row, accounts.get(row.connectionId) ?? null));
}

/** One row, refusing rather than answering when it is not this project's. */
async function requireService(projectId: string, id: string): Promise<Row> {
    const row = await prisma.externalService.findFirst({
        where: { id, environment: { projectId } },
        select: FIELDS
    });
    if (!row) throw new ProviderError("That service is not in this project", "refused");
    return row;
}

/** The token behind a row, or the sentence that says why there is none. */
async function tokenFor(row: Row): Promise<string> {
    const credential = await readCredential(row.connectionId);
    const token = credential?.token ?? credential?.accessToken;
    if (!token) {
        throw new ProviderError(
            `The ${row.provider} account this was added with is no longer connected. Link it again under Connected accounts.`,
            "unauthorized"
        );
    }
    return token;
}

function driverFor(provider: string): ProviderDriver {
    const driver = providerDriver(provider);
    if (!driver) throw new ProviderError("Polaris cannot reach that service any more", "refused");
    return driver;
}

/**
 * What one service is doing now, written back onto the row.
 *
 * The row is what the board reads, so a screen of six services is one query and
 * not six calls to somebody else's API. This is what keeps that row honest, and
 * it is called on a read that is older than a minute and whenever somebody asks.
 *
 * A failure is recorded rather than thrown: a provider having a bad morning is
 * not a reason for a project board to fail to load, and the row says what
 * happened where its state would be.
 */
export async function refreshExternalService(projectId: string, id: string): Promise<ExternalServiceView> {
    const row = await requireService(projectId, id);
    let state: ExternalState | null = null;
    let failure: string | null = null;
    try {
        const token = await tokenFor(row);
        state = await driverFor(row.provider).state(token, row.externalId, refOf(row));
    } catch (caught) {
        failure = caught instanceof Error ? caught.message : "That service could not be read";
    }

    const updated = await prisma.externalService.update({
        where: { id: row.id },
        data: state
            ? {
                  status: state.status,
                  url: state.url,
                  inspectUrl: state.inspectUrl,
                  lastDeployAt: state.at,
                  lastCommitSha: state.commitSha,
                  lastCommitMessage: state.commitMessage,
                  error: state.error,
                  checkedAt: new Date()
              }
            : { error: failure, checkedAt: new Date() },
        select: FIELDS
    });
    const accounts = await accountsFor([updated]);
    return toView(updated, accounts.get(updated.connectionId) ?? null);
}

/** Every service of a project, read again where the reading has gone stale. Runs
 *  them together: they are separate accounts and one being slow is not a reason
 *  for the rest to wait. */
export async function refreshStale(projectId: string): Promise<void> {
    const rows = await prisma.externalService.findMany({
        where: { environment: { projectId } },
        select: { id: true, checkedAt: true }
    });
    const stale = rows.filter(
        (row) => !row.checkedAt || Date.now() - row.checkedAt.getTime() > READING_TTL_MS
    );
    await Promise.all(
        stale.map((row) => refreshExternalService(projectId, row.id).catch(() => undefined))
    );
}

/** What a provider's account holds, for the screen that asks what to add. */
export async function providerChoices(
    userId: string,
    connectionId: string
): Promise<ProviderChoice[]> {
    const link = await prisma.userConnection.findFirst({
        where: { id: connectionId, userId },
        select: { id: true, provider: true, label: true }
    });
    if (!link) throw new ProviderError("That account is not connected to your profile", "refused");
    const credential = await readCredential(link.id);
    const token = credential?.token ?? credential?.accessToken;
    if (!token) throw new ProviderError(`${link.label} has to be connected again`, "unauthorized");
    return driverFor(link.provider).choices(token);
}

export interface AddExternalInput {
    readonly environmentId: string;
    readonly connectionId: string;
    readonly name: string;
    readonly externalId: string;
    readonly ref: ProviderRef;
}

/** A name that reads as a name and cannot collide: what a slug is everywhere else
 *  in Deploy, so a service running elsewhere sits in the same namespace as the
 *  ones running here. */
function slugOf(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "service"
    );
}

/**
 * Put a provider's project on this project's board.
 *
 * Read once on the way in, so what appears is its actual state rather than a row
 * that says "unknown" until something else happens. A read that fails does not
 * stop it being added: the account was proved when it was linked, and a provider
 * that is busy right now is not a reason to refuse.
 */
export async function addExternalService(
    userId: string,
    projectId: string,
    input: AddExternalInput
): Promise<ExternalServiceView> {
    const link = await prisma.userConnection.findFirst({
        where: { id: input.connectionId, userId },
        select: { id: true, provider: true }
    });
    if (!link) throw new ProviderError("That account is not connected to your profile", "refused");
    if (!isProvider(link.provider)) throw new ProviderError("Polaris cannot watch that service", "refused");

    const environment = await prisma.environment.findFirst({
        where: { id: input.environmentId, projectId },
        select: { id: true }
    });
    if (!environment) throw new ProviderError("That environment is not in this project", "refused");

    const base = slugOf(input.name);
    const taken = await prisma.externalService.findMany({
        where: { environmentId: environment.id },
        select: { slug: true }
    });
    const used = new Set(taken.map((row) => row.slug));
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix += 1) slug = `${base}-${suffix}`;

    const created = await prisma.externalService.create({
        data: {
            environmentId: environment.id,
            provider: link.provider,
            connectionId: link.id,
            name: input.name.trim() || slug,
            slug,
            externalId: input.externalId,
            ref: JSON.stringify(input.ref)
        },
        select: FIELDS
    });
    return refreshExternalService(projectId, created.id).catch(async () =>
        toView(created, (await accountsFor([created])).get(created.connectionId) ?? null)
    );
}

/** Release one again, at the provider. Polaris sends nothing but which one: what
 *  goes into the build belongs to whoever is building it. */
export async function deployExternalService(projectId: string, id: string): Promise<ExternalServiceView> {
    const row = await requireService(projectId, id);
    const token = await tokenFor(row);
    await driverFor(row.provider).deploy(token, row.externalId, refOf(row));

    // Written straight away so the row stops saying what the last release did the
    // moment a new one is asked for. What it actually becomes comes from the
    // provider on the next read, which is theirs to report.
    await prisma.externalService.update({
        where: { id: row.id },
        data: { status: "queued", error: null, checkedAt: new Date() }
    });
    return refreshExternalService(projectId, id);
}

/** Take one off the board. Nothing is deleted at the provider - it is their
 *  service, and Polaris only ever had a link to it. */
export async function removeExternalService(projectId: string, id: string): Promise<void> {
    const row = await requireService(projectId, id);
    await prisma.externalService.delete({ where: { id: row.id } });
}

/** Rename one here. Their name for it is theirs; this is what this board calls
 *  it. */
export async function renameExternalService(
    projectId: string,
    id: string,
    name: string
): Promise<ExternalServiceView> {
    const row = await requireService(projectId, id);
    const updated = await prisma.externalService.update({
        where: { id: row.id },
        data: { name: name.trim() || row.name },
        select: FIELDS
    });
    const accounts = await accountsFor([updated]);
    return toView(updated, accounts.get(updated.connectionId) ?? null);
}
