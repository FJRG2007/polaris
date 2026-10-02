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
import { parseGithubRepo } from "@/lib/repo-reference";
import { AWS, awsDriver } from "@/lib/deploy/providers/aws";
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
    [RAILWAY]: railwayDriver,
    [AWS]: awsDriver
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

/** How long the production domains and the repository are trusted. They change
 *  when somebody adds a domain or reconnects a repository, not minute by minute,
 *  so they are read on a slower clock than the release status. */
const DOMAINS_TTL_MS = 10 * 60_000;

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
    /** Where it serves production, as the provider reports it. */
    readonly productionDomains: readonly string[];
    /** The Polaris service somebody said it is the same thing as. */
    readonly applicationId: string | null;
    /** `owner/name` of the repository the provider builds. */
    readonly repo: string | null;
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
    checkedAt: true,
    applicationId: true,
    repo: true,
    productionDomains: true,
    domainsCheckedAt: true
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
    applicationId: string | null;
    repo: string | null;
    productionDomains: string | null;
    domainsCheckedAt: Date | null;
};

/** The stored production domains, ignoring anything that is not a list of names. */
export function domainsOf(json: string | null): string[] {
    if (!json) return [];
    try {
        const value = JSON.parse(json) as unknown;
        return Array.isArray(value)
            ? value.filter((entry): entry is string => typeof entry === "string")
            : [];
    } catch {
        return [];
    }
}

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
        account,
        productionDomains: domainsOf(row.productionDomains),
        applicationId: row.applicationId,
        repo: row.repo
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

/** Which environment a row is in, for a caller whose access may stop at some
 *  of a project's environments. Refuses a row from another project. */
export async function externalServiceEnvironment(projectId: string, id: string): Promise<string> {
    return (await requireService(projectId, id)).environmentId;
}

/**
 * The credential behind a row, as the string a driver takes.
 *
 * A string, because every other provider here issues one and the seam is the
 * poorer for pretending otherwise. AWS issues none - a request is signed with the
 * secret rather than carrying a token - so its key pair travels as the JSON its
 * own driver reads back, and nothing between here and there has to know that.
 */
async function tokenFor(row: { connectionId: string; provider: string }): Promise<string> {
    const credential = await readCredential(row.connectionId);
    if (row.provider === AWS && credential?.accessKeyId && credential.secretAccessKey) {
        return JSON.stringify({
            accessKeyId: credential.accessKeyId,
            secretAccessKey: credential.secretAccessKey,
            region: credential.region ?? "",
            ...(credential.sessionToken ? { sessionToken: credential.sessionToken } : {})
        });
    }
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
export async function refreshExternalService(
    projectId: string,
    id: string
): Promise<ExternalServiceView> {
    const row = await requireService(projectId, id);
    let state: ExternalState | null = null;
    let failure: string | null = null;
    // The domains and the repository, when their own clock says so. Each is
    // best-effort: a provider that will not say keeps what was last read.
    let slow: { productionDomains?: string; repo?: string | null; domainsCheckedAt: Date } | null =
        null;
    try {
        const token = await tokenFor(row);
        const driver = driverFor(row.provider);
        state = await driver.state(token, row.externalId, refOf(row));
        if (!row.domainsCheckedAt || Date.now() - row.domainsCheckedAt.getTime() > DOMAINS_TTL_MS) {
            const [domains, source] = await Promise.all([
                driver.productionDomains
                    ? driver.productionDomains(token, row.externalId, refOf(row)).catch(() => null)
                    : Promise.resolve(null),
                driver.source(token, row.externalId, refOf(row)).catch(() => undefined)
            ]);
            slow = {
                ...(domains ? { productionDomains: JSON.stringify(domains.slice(0, 20)) } : {}),
                ...(source !== undefined ? { repo: source?.repo.toLowerCase() ?? null } : {}),
                domainsCheckedAt: new Date()
            };
        }
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
                  checkedAt: new Date(),
                  ...slow
              }
            : { error: failure, checkedAt: new Date() },
        select: FIELDS
    });
    const accounts = await accountsFor([updated]);
    return toView(updated, accounts.get(updated.connectionId) ?? null);
}

/**
 * Say which Polaris service a row is the same thing as, or that it is none.
 *
 * Refused for a service that is not in this project: the link is what puts this
 * provider's domains on that service's card, and a card in another project is
 * somebody else's.
 */
export async function linkExternalService(
    projectId: string,
    id: string,
    applicationId: string | null
): Promise<ExternalServiceView> {
    const row = await requireService(projectId, id);
    if (applicationId) {
        const app = await prisma.application.findFirst({
            where: { id: applicationId, environment: { projectId } },
            select: { id: true }
        });
        if (!app) throw new ProviderError("That service is not in this project", "refused");
    }
    const updated = await prisma.externalService.update({
        where: { id: row.id },
        data: { applicationId },
        select: FIELDS
    });
    const accounts = await accountsFor([updated]);
    return toView(updated, accounts.get(updated.connectionId) ?? null);
}

/** What a service's card says about the copy of it running elsewhere. */
export interface ElsewhereSummary {
    readonly id: string;
    readonly provider: string;
    readonly name: string;
    readonly status: string;
    readonly domains: readonly string[];
    /** The release URL, for a provider that reports no domains of its own. */
    readonly url: string | null;
    /** Linked by somebody, or matched because both build the same repository. */
    readonly linked: "explicit" | "repository";
}

/** `owner/name`, lowercased, of the GitHub repository a service builds, or null. */
export function repoOfSource(sourceConfig: string): string | null {
    try {
        const source = JSON.parse(sourceConfig) as Record<string, unknown>;
        const raw = typeof source.repoUrl === "string" ? source.repoUrl : "";
        const parsed = parseGithubRepo(raw);
        return parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : null;
    } catch {
        return null;
    }
}

/**
 * Which of a project's services also run elsewhere, in one query.
 *
 * A row counts for a service when somebody linked them, or - with no link on the
 * row at all - when both build the same repository, which is the one fact that
 * makes two of them the same code without anybody guessing from a name. Read from
 * the stored rows only: what keeps those current is `refreshStale`, which is never
 * awaited by the page that draws this.
 */
export async function elsewhereByService(
    projectId: string,
    apps: readonly { id: string; sourceConfig: string }[]
): Promise<Map<string, ElsewhereSummary[]>> {
    const result = new Map<string, ElsewhereSummary[]>();
    if (apps.length === 0) return result;
    const rows = await prisma.externalService.findMany({
        where: { environment: { projectId } },
        orderBy: { name: "asc" },
        select: {
            id: true,
            provider: true,
            name: true,
            status: true,
            url: true,
            applicationId: true,
            repo: true,
            productionDomains: true
        }
    });
    if (rows.length === 0) return result;
    for (const app of apps) {
        const repo = repoOfSource(app.sourceConfig);
        const matched = rows.flatMap((row): ElsewhereSummary[] => {
            const linked =
                row.applicationId === app.id
                    ? ("explicit" as const)
                    : !row.applicationId && repo && row.repo === repo
                      ? ("repository" as const)
                      : null;
            if (!linked) return [];
            return [
                {
                    id: row.id,
                    provider: row.provider,
                    name: row.name,
                    status: row.status,
                    domains: domainsOf(row.productionDomains),
                    url: row.url,
                    linked
                }
            ];
        });
        if (matched.length > 0) result.set(app.id, matched);
    }
    return result;
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
    // The same reading the rows use, so a provider whose credential is not a token
    // works here too rather than only once it is on the board.
    const token = await tokenFor({ connectionId: link.id, provider: link.provider });
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
    if (!isProvider(link.provider))
        throw new ProviderError("Polaris cannot watch that service", "refused");

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
export async function deployExternalService(
    projectId: string,
    id: string
): Promise<ExternalServiceView> {
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
