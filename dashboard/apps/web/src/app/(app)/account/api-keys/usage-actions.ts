"use server";

/**
 * One key's usage, for the screen behind it. Only the owner's own keys: the key
 * is looked up by id AND owner, so an id belonging to somebody else reads the
 * same as one that does not exist.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { operationId } from "@/lib/api-docs/openapi";
import { DOCUMENTED_ROUTES } from "@/lib/api-docs/routes";
import { USAGE_RANGES, keyUsageReport, type KeyUsageReport } from "@/lib/api-usage/report";

const inputSchema = z.object({ keyId: z.string().uuid(), range: z.enum(USAGE_RANGES) });

export type KeyUsage = KeyUsageReport & {
    /** Each route's anchor in the API reference, or null for one it does not hold. */
    anchors: (string | null)[];
};

export async function keyUsageAction(input: unknown): Promise<{ usage?: KeyUsage; error?: "notFound" | "invalid" }> {
    const user = await requireUser();
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return { error: "invalid" };
    const key = await prisma.apiKey.findFirst({
        where: { id: parsed.data.keyId, userId: user.id },
        select: { id: true }
    });
    if (!key) return { error: "notFound" };
    const report = await keyUsageReport(key.id, parsed.data.range);
    const anchors = report.routes.map((row) => {
        const route = DOCUMENTED_ROUTES.find((r) => r.method === row.method && r.path === row.route);
        return route ? operationId(route) : null;
    });
    return { usage: { ...report, anchors } };
}
