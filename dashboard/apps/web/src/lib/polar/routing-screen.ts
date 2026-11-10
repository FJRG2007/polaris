/**
 * What the routing screens read: the routing in force, the keys a route may
 * pin, and what the person's calls spent this month by key and by surface,
 * with the calls a fallback answered.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { PolarAccess } from "@/lib/polar/access";
import type { PolarRouting } from "@/lib/polar/routing";
import type { RouteKeyOption } from "@/lib/polar/routing-keys";
import { instanceRouting, ownRouting } from "@/lib/polar/router/store";
import { INSTANCE, instanceKeysAreShared, listProviderKeys } from "@/lib/agents/model-keys";

/** The deployment's keys as a route may pin them. */
export async function instanceRouteKeys(): Promise<RouteKeyOption[]> {
    const keys = await listProviderKeys(INSTANCE);
    return keys.map((key) => ({
        id: key.id,
        provider: key.provider,
        name: key.name,
        source: "instance" as const
    }));
}

/** The keys this person may pin: their own, then the deployment's where it
 *  shares them and this person may spend them. */
export async function routeKeysFor(userId: string, access: PolarAccess): Promise<RouteKeyOption[]> {
    const [own, shared] = await Promise.all([listProviderKeys(userId), instanceKeysAreShared()]);
    const mine = own.map((key) => ({
        id: key.id,
        provider: key.provider,
        name: key.name,
        source: "own" as const
    }));
    if (!shared || !access.spend) return mine;
    return [...mine, ...(await instanceRouteKeys())];
}

export interface RoutingScreen {
    /** The person's own routing; null while they follow the deployment's. */
    own: PolarRouting | null;
    deployment: PolarRouting;
    keys: RouteKeyOption[];
}

export async function routingScreenFor(userId: string, access: PolarAccess): Promise<RoutingScreen> {
    const [own, deployment, keys] = await Promise.all([
        ownRouting(userId),
        instanceRouting(),
        routeKeysFor(userId, access)
    ]);
    return { own, deployment, keys };
}

/** One key's share of this month. `keyId` null is the calls recorded without
 *  the stored key that paid - before keys were itemized, or by a path that
 *  does not name one - told apart by who paid (`payer`); a name of null is a
 *  key removed since. */
export interface KeyUsageRow {
    keyId: string | null;
    provider: string;
    /** Whose key paid: the person's own, or the one this Polaris shares. */
    payer: "own" | "instance";
    name: string | null;
    source: "own" | "instance" | null;
    requests: number;
    tokens: number;
    /** Null when no call on it had a price. */
    costUsd: number | null;
}

export interface SurfaceUsageRow {
    surface: string;
    requests: number;
    tokens: number;
    costUsd: number | null;
}

export interface FallbackRow {
    at: string;
    /** `provider/model` first asked. */
    from: string;
    provider: string;
    model: string;
    /** The failure kind that moved the call on, when recorded. */
    kind: string | null;
    surface: string;
}

export interface RoutingUsage {
    byKey: KeyUsageRow[];
    bySurface: SurfaceUsageRow[];
    fallbacks: FallbackRow[];
}

/** The most recent fallbacks shown, and how far back they are looked for. */
export const RECENT_FALLBACKS = 20;
const FALLBACK_WINDOW_MS = 30 * 86_400_000;

function startOfMonthUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type Sums = { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };

const tokensOf = (sum: Sums) => (sum.inputTokens ?? 0) + (sum.outputTokens ?? 0);

/**
 * This month's calls of one person, by key and by surface, and their recent
 * fallbacks. Three reads on the `[userId, createdAt]` index, each bounded by
 * a date and the last by a count as well.
 */
export async function routingUsageFor(userId: string, now = new Date()): Promise<RoutingUsage> {
    const since = startOfMonthUtc(now);
    const [byKey, bySurface, fallbacks, own, instance] = await Promise.all([
        prisma.polarUsage.groupBy({
            by: ["keyId", "provider", "payer"],
            where: { userId, createdAt: { gte: since } },
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, costUsd: true }
        }),
        prisma.polarUsage.groupBy({
            by: ["surface"],
            where: { userId, createdAt: { gte: since } },
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, costUsd: true }
        }),
        prisma.polarUsage.findMany({
            where: {
                userId,
                fellBackFrom: { not: null },
                createdAt: { gte: new Date(now.getTime() - FALLBACK_WINDOW_MS) }
            },
            orderBy: { createdAt: "desc" },
            take: RECENT_FALLBACKS,
            select: {
                createdAt: true,
                fellBackFrom: true,
                fellBackKind: true,
                provider: true,
                model: true,
                surface: true
            }
        }),
        listProviderKeys(userId),
        listProviderKeys(INSTANCE)
    ]);
    const names = new Map<string, { name: string; source: "own" | "instance" }>();
    for (const key of instance) names.set(key.id, { name: key.name, source: "instance" });
    for (const key of own) names.set(key.id, { name: key.name, source: "own" });
    return {
        byKey: byKey
            .map((row) => {
                const known = row.keyId ? names.get(row.keyId) : undefined;
                return {
                    keyId: row.keyId,
                    provider: row.provider,
                    payer: row.payer === "instance" ? ("instance" as const) : ("own" as const),
                    name: known?.name ?? null,
                    source: known?.source ?? null,
                    requests: row._count._all,
                    tokens: tokensOf(row._sum),
                    costUsd: row._sum.costUsd ?? null
                };
            })
            .sort((a, b) => b.requests - a.requests),
        bySurface: bySurface
            .map((row) => ({
                surface: row.surface,
                requests: row._count._all,
                tokens: tokensOf(row._sum),
                costUsd: row._sum.costUsd ?? null
            }))
            .sort((a, b) => b.requests - a.requests),
        fallbacks: fallbacks.map((row) => ({
            at: row.createdAt.toISOString(),
            from: row.fellBackFrom ?? "",
            provider: row.provider,
            model: row.model,
            kind: row.fellBackKind,
            surface: row.surface
        }))
    };
}
