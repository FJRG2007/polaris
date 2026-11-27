"use server";

/**
 * Keys' usage: one key's for the screen behind it, all of an account's for the
 * overview. Only the owner's own keys: a key is looked up by id AND owner, so
 * an id belonging to somebody else reads the same as one that does not exist.
 */

import { z } from "zod";
import { DEVICE_KINDS } from "@/lib/device-sessions/kinds";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { operationId } from "@/lib/api-docs/openapi";
import { DOCUMENTED_ROUTES } from "@/lib/api-docs/routes";
import {
    USAGE_RANGES,
    windowStart,
    keyUsageReport,
    usageReport,
    type KeyUsageReport
} from "@/lib/api-usage/report";
import { callerReport, type CallerShare } from "@/lib/api-usage/callers";

const inputSchema = z.object({ keyId: z.string().uuid(), range: z.enum(USAGE_RANGES) });

export type KeyUsage = KeyUsageReport & {
    /** Each route's anchor in the API reference, or null for one it does not hold. */
    anchors: (string | null)[];
};

export async function keyUsageAction(
    input: unknown
): Promise<{ usage?: KeyUsage; error?: "notFound" | "invalid" }> {
    const user = await requireUser();
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return { error: "invalid" };
    const key = await prisma.apiKey.findFirst({
        where: { id: parsed.data.keyId, userId: user.id, kind: { notIn: DEVICE_KINDS } },
        select: { id: true }
    });
    if (!key) return { error: "notFound" };
    const report = await keyUsageReport(key.id, parsed.data.range);
    return { usage: { ...report, anchors: anchorsOf(report) } };
}

function anchorsOf(report: KeyUsageReport): (string | null)[] {
    return report.routes.map((row) => {
        const route = DOCUMENTED_ROUTES.find(
            (r) => r.method === row.method && r.path === row.route
        );
        return route ? operationId(route) : null;
    });
}

/** What the overview names a key by, revoked ones included: their calls still happened. */
export interface UsageKeyLabel {
    id: string;
    name: string;
    prefix: string;
    lastUsedAt: string | null;
    revoked: boolean;
}

export type AccountUsage = KeyUsage & { labels: UsageKeyLabel[] };

/** The most keys one account's overview reads. */
const ACCOUNT_KEYS = 1000;

const accountSchema = z.object({ range: z.enum(USAGE_RANGES) });

/** Every one of this account's keys summed as one, and each key's share. */
export async function accountUsageAction(
    input: unknown
): Promise<{ usage?: AccountUsage; error?: "invalid" }> {
    const user = await requireUser();
    const parsed = accountSchema.safeParse(input);
    if (!parsed.success) return { error: "invalid" };
    const keys = await prisma.apiKey.findMany({
        where: { userId: user.id, kind: { notIn: DEVICE_KINDS } },
        select: { id: true, name: true, prefix: true, lastUsedAt: true, revokedAt: true },
        orderBy: { lastUsedAt: { sort: "desc", nulls: "last" } },
        take: ACCOUNT_KEYS
    });
    const labels = keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        revoked: key.revokedAt !== null
    }));
    const report = await usageReport(
        keys.map((key) => key.id),
        parsed.data.range,
        { shares: true }
    );
    return { usage: { ...report, anchors: anchorsOf(report), labels } };
}

const addressesSchema = z.object({
    keyId: z.string().uuid().optional(),
    range: z.enum(USAGE_RANGES)
});

/**
 * The addresses behind a usage report in full, for the owner who asked to see
 * them: one key's (by id AND owner) or, without a key, every key of theirs.
 * The report itself only ever carries them masked.
 */
export async function usageAddressesAction(
    input: unknown
): Promise<{ addresses?: CallerShare[]; error?: "notFound" | "invalid" }> {
    const user = await requireUser();
    const parsed = addressesSchema.safeParse(input);
    if (!parsed.success) return { error: "invalid" };
    const keys = await prisma.apiKey.findMany({
        where: {
            userId: user.id,
            kind: { notIn: DEVICE_KINDS },
            ...(parsed.data.keyId ? { id: parsed.data.keyId } : {})
        },
        select: { id: true },
        take: ACCOUNT_KEYS
    });
    if (keys.length === 0) return parsed.data.keyId ? { error: "notFound" } : { addresses: [] };
    const report = await callerReport(
        keys.map((key) => key.id),
        new Date(windowStart(parsed.data.range)),
        { reveal: true }
    );
    return { addresses: report.addresses };
}
