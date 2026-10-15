/**
 * Cloud accounts and the servers created through them.
 *
 * Every read and write is narrowed to the signed-in operator's own rows inside
 * the query. Provider calls happen only when somebody asks for something here,
 * and from the hourly job while the app is installed.
 *
 * Server-only.
 */

import { cloudT } from "./i18n";
import { prisma } from "@polaris/db";
import { ProviderError } from "./http";
import { host } from "@polaris/app-host";
import { adapterFor } from "./providers";
import { renderFirstBoot } from "./cloud-init";
import { serverCosts, totalsByCurrency } from "./cost";
import {
    credentialSchemas,
    RESIZE,
    type CloudMachine,
    type PowerAction,
    type ProviderAdapter,
    type ProviderId
} from "./providers/types";

/** A refusal the person can act on; its message is shown as it is. */
export class CloudRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CloudRefusal";
    }
}

async function refuse(key: Parameters<Awaited<ReturnType<typeof cloudT>>>[0]): Promise<never> {
    throw new CloudRefusal((await cloudT())(key));
}

/** A provider's own refusal, said as the provider said it. */
async function providerRefusal(caught: unknown): Promise<never> {
    if (caught instanceof ProviderError) {
        throw new CloudRefusal((await cloudT())("errors.provider", { detail: caught.message }));
    }
    throw caught;
}

/** The person who may use the app: whoever manages servers. */
export async function requireCloudUser() {
    return host.session.requirePermission("system.manage");
}

/** The most servers one refresh reads, so a job pass stays bounded. */
const REFRESH_LIMIT = 500;

/** How long a provider's published price is kept before it is read again. */
export const PRICE_TTL_MS = 24 * 3_600_000;

/** Whether a price read at `fetchedAt` is still good at `now`. */
export function priceFresh(fetchedAt: Date, now: Date): boolean {
    return now.getTime() - fetchedAt.getTime() < PRICE_TTL_MS;
}

type PriceFigures = { priceHourly: number | null; priceMonthly: number | null; currency: string | null };

/**
 * A size's price, from the day-old cache or the provider. A failed read keeps
 * the last known figure and is not cached, so it is tried again next time; a
 * provider that publishes no price is cached as that, so it is not asked hourly.
 */
async function cachedPrice(provider: string, adapter: ProviderAdapter, region: string, size: string): Promise<PriceFigures | null> {
    const where = { provider_region_size: { provider, region, size } };
    const row = await prisma.cloudPrice.findUnique({ where });
    const fromRow = (r: PriceFigures) =>
        r.priceHourly === null && r.priceMonthly === null ? null : { priceHourly: r.priceHourly, priceMonthly: r.priceMonthly, currency: r.currency };
    if (row && priceFresh(row.fetchedAt, new Date())) return fromRow(row);
    let read: Awaited<ReturnType<ProviderAdapter["monthlyCost"]>>;
    try {
        read = await adapter.monthlyCost(region, size);
    } catch {
        return row ? fromRow(row) : null;
    }
    const figures = {
        priceHourly: read?.priceHourly ?? null,
        priceMonthly: read?.priceMonthly ?? null,
        currency: read?.currency ?? null
    };
    await prisma.cloudPrice.upsert({
        where,
        create: { provider, region, size, ...figures },
        update: { ...figures, fetchedAt: new Date() }
    });
    return fromRow(figures);
}

const accountSelect = {
    id: true,
    provider: true,
    name: true,
    lastError: true,
    createdAt: true,
    encryptedSecret: true,
    secretNonce: true,
    secretKeyId: true
} as const;

type AccountRow = { provider: string; encryptedSecret: Uint8Array; secretNonce: Uint8Array; secretKeyId: string };

async function adapterOf(account: AccountRow): Promise<ProviderAdapter> {
    const secret = await host.cloudServersHost.openCloudSecret(account);
    if (!secret) return refuse("errors.secretLost");
    return adapterFor(account.provider as ProviderId, secret);
}

async function ownAccount(userId: string, accountId: string) {
    const account = await prisma.cloudAccount.findFirst({ where: { id: accountId, ownerId: userId }, select: accountSelect });
    return account ?? refuse("errors.accountNotFound");
}

async function ownServer(userId: string, serverId: string) {
    const server = await prisma.cloudServer.findFirst({
        where: { id: serverId, ownerId: userId },
        include: { account: { select: accountSelect } }
    });
    return server ?? refuse("errors.serverNotFound");
}

// ---- Accounts --------------------------------------------------------------

export interface AccountView {
    readonly id: string;
    readonly provider: ProviderId;
    readonly name: string;
    readonly lastError: string | null;
}

export async function listAccounts(userId: string): Promise<AccountView[]> {
    const rows = await prisma.cloudAccount.findMany({
        where: { ownerId: userId },
        select: { id: true, provider: true, name: true, lastError: true },
        orderBy: { createdAt: "asc" },
        take: 100
    });
    return rows.map((r) => ({ ...r, provider: r.provider as ProviderId }));
}

/** Connect an account, after one read proves the credential works. */
export async function addAccount(
    userId: string,
    input: { provider: ProviderId; name: string; credentials: Record<string, string> }
): Promise<AccountView> {
    const parsed = credentialSchemas[input.provider].safeParse(input.credentials);
    if (!parsed.success) return refuse("errors.credentials");
    const json = JSON.stringify(parsed.data);
    const adapter = await adapterFor(input.provider, json).catch(providerRefusal);
    await adapter.listRegions().catch(providerRefusal);
    const sealed = await host.cloudServersHost.sealCloudSecret(json);
    const row = await prisma.cloudAccount.create({
        data: { ownerId: userId, provider: input.provider, name: input.name, ...sealed },
        select: { id: true, provider: true, name: true, lastError: true }
    });
    await host.auditService.recordAudit({
        actorId: userId,
        action: "cloud.account.connect",
        targetType: "cloud-account",
        targetId: row.id,
        metadata: { provider: input.provider }
    });
    return { ...row, provider: input.provider };
}

/** Forget an account. Refused while it still has servers, which would go on
 *  costing money with nothing here watching them. */
export async function removeAccount(userId: string, accountId: string): Promise<void> {
    await ownAccount(userId, accountId);
    const live = await prisma.cloudServer.count({ where: { accountId, destroyedAt: null } });
    if (live > 0) await refuse("errors.accountHasServers");
    await prisma.cloudAccount.delete({ where: { id: accountId } });
    await host.auditService.recordAudit({
        actorId: userId,
        action: "cloud.account.remove",
        targetType: "cloud-account",
        targetId: accountId
    });
}

/** Regions, or a region's sizes and images. */
export async function accountOptions(userId: string, accountId: string, region: string | null) {
    const adapter = await adapterOf(await ownAccount(userId, accountId));
    if (!region) return { regions: await adapter.listRegions().catch(providerRefusal), sizes: [], images: [] };
    const [sizes, images] = await Promise.all([
        adapter.listSizes(region).catch(providerRefusal),
        adapter.listImages(region).catch(providerRefusal)
    ]);
    return { regions: [], sizes, images };
}

// ---- Servers ---------------------------------------------------------------

export interface ServerView {
    readonly id: string;
    readonly accountId: string;
    readonly provider: ProviderId;
    readonly name: string;
    readonly region: string;
    readonly size: string;
    readonly image: string;
    readonly status: string;
    readonly ipv4: string | null;
    readonly hostId: string | null;
    readonly error: string | null;
    readonly createdAt: string;
    readonly destroyedAt: string | null;
    readonly priceHourly: number | null;
    readonly priceMonthly: number | null;
    readonly currency: string | null;
    readonly sinceCreation: number | null;
    readonly thisMonth: number | null;
    readonly resize: "online" | "stopped" | "none";
}

type ServerRow = Awaited<ReturnType<typeof prisma.cloudServer.findMany>>[number] & {
    account: { provider: string };
};

function view(row: ServerRow, now: Date): ServerView {
    const provider = row.account.provider as ProviderId;
    const price = { hourly: row.priceHourly, monthly: row.priceMonthly, currency: row.currency };
    const costs = serverCosts(price, row.createdAt, row.destroyedAt, now);
    return {
        id: row.id,
        accountId: row.accountId,
        provider,
        name: row.name,
        region: row.region,
        size: row.size,
        image: row.image,
        status: row.status,
        ipv4: row.ipv4,
        hostId: row.hostId,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        destroyedAt: row.destroyedAt?.toISOString() ?? null,
        priceHourly: row.priceHourly,
        priceMonthly: row.priceMonthly,
        currency: row.currency,
        ...costs,
        resize: RESIZE[provider]
    };
}

function monthStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Live servers and the ones destroyed this month, with what they cost, and
 *  each account's total for the month. Reads the database only. */
export async function listServers(userId: string) {
    const now = new Date();
    const rows = await prisma.cloudServer.findMany({
        where: { ownerId: userId, OR: [{ destroyedAt: null }, { destroyedAt: { gte: monthStart(now) } }] },
        include: { account: { select: { provider: true } } },
        orderBy: { createdAt: "desc" },
        take: 500
    });
    const servers = rows.map((r) => view(r, now));
    const byAccount = new Map<string, ServerView[]>();
    for (const s of servers) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
    const monthTotals = Object.fromEntries(
        [...byAccount].map(([accountId, list]) => [
            accountId,
            totalsByCurrency(list.map((s) => ({ currency: s.currency, amount: s.thisMonth })))
        ])
    );
    return { servers, monthTotals };
}

function rowStatus(machine: CloudMachine, enrolled: boolean): string {
    if (machine.status === "running" && !enrolled) return "enrolling";
    return machine.status;
}

/** Hosts an enrollment can call back to from the internet. */
function reachableFromCloud(command: string): boolean {
    const url = /https?:\/\/[^\s/]+/.exec(command)?.[0];
    if (!url) return false;
    const hostname = new URL(url).hostname;
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".lan")) return false;
    return !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?fd|\[?fe80)/i.test(hostname);
}

export async function createServer(
    userId: string,
    input: { accountId: string; name: string; region: string; size: string; image: string }
): Promise<ServerView> {
    const account = await ownAccount(userId, input.accountId);
    const clash = await prisma.cloudServer.count({
        where: { accountId: account.id, name: input.name, destroyedAt: null }
    });
    if (clash > 0) await refuse("errors.nameTaken");
    const adapter = await adapterOf(account);
    const enrollment = await host.cloudServersHost.openCloudEnrollment(userId, input.name);
    if (!reachableFromCloud(enrollment.command)) await refuse("errors.notReachable");
    if (!enrollment.command.includes(" https://")) await refuse("errors.notHttps");
    const price = await cachedPrice(account.provider, adapter, input.region, input.size);
    const machine = await adapter
        .create({ ...input, userData: renderFirstBoot(enrollment.command) })
        .catch(providerRefusal);
    const row = await prisma.cloudServer.create({
        data: {
            accountId: account.id,
            ownerId: userId,
            providerId: machine.providerId,
            name: input.name,
            region: input.region,
            size: input.size,
            image: input.image,
            status: machine.status === "running" ? "enrolling" : "creating",
            ipv4: machine.ipv4,
            enrollmentId: enrollment.id,
            priceHourly: price?.priceHourly ?? null,
            priceMonthly: price?.priceMonthly ?? null,
            currency: price?.currency ?? null
        },
        include: { account: { select: { provider: true } } }
    });
    await host.auditService.recordAudit({
        actorId: userId,
        action: "cloud.server.create",
        targetType: "cloud-server",
        targetId: row.id,
        metadata: { provider: account.provider, region: input.region, size: input.size }
    });
    return view(row, new Date());
}

/** Read one server from its provider and its enrollment, and record it. */
export async function serverProgress(userId: string, serverId: string): Promise<ServerView> {
    const server = await ownServer(userId, serverId);
    if (server.destroyedAt) return view(server, new Date());
    const adapter = await adapterOf(server.account);
    const machine = await adapter.get({ providerId: server.providerId, region: server.region }).catch(providerRefusal);
    let { hostId, error } = server;
    if (!hostId && server.enrollmentId) {
        const enrollment = await host.cloudServersHost.cloudEnrollmentStatus(server.enrollmentId, userId);
        if (enrollment?.hostId) hostId = enrollment.hostId;
        else if (enrollment?.error) error = enrollment.error;
        else if (enrollment?.expired) error = (await cloudT())("errors.enrollmentExpired");
    }
    const updated = await prisma.cloudServer.update({
        where: { id: server.id },
        data: {
            status: machine ? rowStatus(machine, !!hostId) : "failed",
            ipv4: machine?.ipv4 ?? server.ipv4,
            size: machine?.size || server.size,
            hostId,
            error: machine ? (hostId ? null : error) : (await cloudT())("errors.goneAtProvider")
        },
        include: { account: { select: { provider: true } } }
    });
    return view(updated, new Date());
}

export async function powerServer(userId: string, serverId: string, action: PowerAction): Promise<void> {
    const server = await ownServer(userId, serverId);
    if (server.destroyedAt) await refuse("errors.serverNotFound");
    const adapter = await adapterOf(server.account);
    await adapter.action({ providerId: server.providerId, region: server.region }, action).catch(providerRefusal);
    await prisma.cloudServer.update({ where: { id: server.id }, data: { status: "transitioning" } });
    await host.auditService.recordAudit({
        actorId: userId,
        action: `cloud.server.${action}`,
        targetType: "cloud-server",
        targetId: server.id
    });
}

export async function resizeServer(userId: string, serverId: string, size: string): Promise<void> {
    const server = await ownServer(userId, serverId);
    if (server.destroyedAt) await refuse("errors.serverNotFound");
    const adapter = await adapterOf(server.account);
    if (!adapter.resize || RESIZE[server.account.provider as ProviderId] === "none") await refuse("errors.noResize");
    const sizes = await adapter.listSizes(server.region).catch(providerRefusal);
    const chosen = sizes.find((s) => s.id === size);
    if (!chosen) await refuse("errors.unknownSize");
    await adapter.resize!({ providerId: server.providerId, region: server.region }, size).catch(providerRefusal);
    const price = await cachedPrice(server.account.provider, adapter, server.region, size);
    await prisma.cloudServer.update({
        where: { id: server.id },
        data: {
            size,
            status: "transitioning",
            priceHourly: price?.priceHourly ?? null,
            priceMonthly: price?.priceMonthly ?? null,
            currency: price?.currency ?? null
        }
    });
    await host.auditService.recordAudit({
        actorId: userId,
        action: "cloud.server.resize",
        targetType: "cloud-server",
        targetId: server.id,
        metadata: { size }
    });
}

/** Destroy at the provider, then take it out of Polaris. The typed name must
 *  match: the dialog asks for it and the server checks it again. */
export async function destroyServer(userId: string, serverId: string, typedName: string): Promise<void> {
    const server = await ownServer(userId, serverId);
    if (server.destroyedAt) return;
    if (typedName.trim() !== server.name) await refuse("errors.confirmName");
    const adapter = await adapterOf(server.account);
    const machine = await adapter.get({ providerId: server.providerId, region: server.region }).catch(providerRefusal);
    if (machine) await adapter.destroy({ providerId: server.providerId, region: server.region }).catch(providerRefusal);
    let warning: string | null = null;
    if (server.hostId) warning = await host.cloudServersHost.removeCloudHost(userId, server.hostId);
    await prisma.cloudServer.update({
        where: { id: server.id },
        data: { destroyedAt: new Date(), status: "destroyed", hostId: warning ? server.hostId : null, error: warning }
    });
    await host.auditService.recordAudit({
        actorId: userId,
        action: "cloud.server.destroy",
        targetType: "cloud-server",
        targetId: server.id
    });
}

// ---- The hourly job ----------------------------------------------------------

/** Take out of Polaris the server a machine gone at its provider became; the
 *  reason when that could not be done, or null. */
async function removeGoneHost(ownerId: string, hostId: string): Promise<string | null> {
    try {
        return await host.cloudServersHost.removeCloudHost(ownerId, hostId);
    } catch (caught) {
        console.error("polaris: cloud-servers could not remove a server gone at its provider:", caught);
        return (await cloudT())("errors.generic");
    }
}

/**
 * Read every live server's state and price from its provider. One account at a
 * time, one call after another, bounded; an account that refuses is marked and
 * skipped rather than failing the pass.
 */
export async function refreshAll(): Promise<{ read: number; failed: number }> {
    const rows = await prisma.cloudServer.findMany({
        where: { destroyedAt: null },
        include: { account: { select: accountSelect } },
        orderBy: { updatedAt: "asc" },
        take: REFRESH_LIMIT
    });
    const byAccount = new Map<string, typeof rows>();
    for (const row of rows) byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);
    let read = 0;
    let failed = 0;
    for (const [accountId, servers] of byAccount) {
        const first = servers[0]!;
        try {
            const adapter = await adapterOf(first.account);
            const prices = new Map<string, PriceFigures | null>();
            for (const server of servers) {
                const machine = await adapter.get({ providerId: server.providerId, region: server.region });
                const key = `${server.region}\u0000${machine?.size ?? server.size}`;
                if (machine && !prices.has(key)) {
                    prices.set(key, await cachedPrice(first.account.provider, adapter, server.region, machine.size));
                }
                const price = prices.get(key);
                // Gone at the provider: the Polaris server it became goes too,
                // or it stays enrolled with nothing left on this screen to remove it.
                const leftover = !machine && server.hostId ? await removeGoneHost(server.ownerId, server.hostId) : null;
                await prisma.cloudServer.update({
                    where: { id: server.id },
                    data: machine
                        ? {
                              status: rowStatus(machine, !!server.hostId),
                              ipv4: machine.ipv4 ?? server.ipv4,
                              size: machine.size || server.size,
                              ...(price
                                  ? { priceHourly: price.priceHourly, priceMonthly: price.priceMonthly, currency: price.currency }
                                  : {})
                          }
                        : // Gone at the provider without going through here: it no
                          // longer costs anything, so its month ends now.
                          {
                              status: "destroyed",
                              destroyedAt: new Date(),
                              hostId: leftover ? server.hostId : null,
                              error: leftover
                          }
                });
                read++;
            }
            await prisma.cloudAccount.update({ where: { id: accountId }, data: { lastError: null } });
        } catch (caught) {
            failed++;
            const message = caught instanceof ProviderError || caught instanceof CloudRefusal ? caught.message : "refresh failed";
            await prisma.cloudAccount.update({ where: { id: accountId }, data: { lastError: message.slice(0, 300) } });
            if (!(caught instanceof ProviderError || caught instanceof CloudRefusal)) {
                console.error("polaris: cloud-servers refresh failed for an account:", caught);
            }
        }
    }
    return { read, failed };
}
