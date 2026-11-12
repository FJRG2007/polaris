/**
 * The picker's per-person order and "Recent" group, read and written for one
 * person. The order is a column on their `PolarPreference` row; "Recent" is
 * read from what they already used - Polar's usage rows for Chat and their
 * agent sessions for Code - so nothing is tracked twice. Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import {
    rankRecent,
    sourceOrderSchema,
    type PickerPrefs,
    type RecentPick
} from "@/lib/polar/picker-order";
import { accountSourceKey, machineSourceKey, polarSourceKey } from "@/lib/polar/agents/code-sources";

/** How far back "Recent" reads, in rows of each kind: bounded by the
 *  (userId, createdAt) indexes both tables carry. */
const RECENT_ROWS = 200;

async function recentFor(userId: string): Promise<RecentPick[]> {
    const [usage, sessions] = await Promise.all([
        prisma.polarUsage
            .findMany({
                where: { userId, surface: "chat" },
                orderBy: { createdAt: "desc" },
                take: RECENT_ROWS,
                select: { provider: true, model: true, createdAt: true }
            })
            .catch(() => []),
        prisma.agentSession
            .findMany({
                where: { startedById: userId },
                orderBy: { createdAt: "desc" },
                take: RECENT_ROWS,
                select: {
                    cli: true,
                    accountId: true,
                    useMachineLogin: true,
                    modelProvider: true,
                    model: true,
                    createdAt: true
                }
            })
            .catch(() => [])
    ]);
    const uses: (RecentPick & { at: Date })[] = [];
    for (const row of usage) {
        if (!row.provider || !row.model) continue;
        uses.push({ source: polarSourceKey(row.provider), provider: row.provider, model: row.model, at: row.createdAt });
    }
    for (const row of sessions) {
        const provider = row.modelProvider ?? core.agentCliById(row.cli)?.model?.provider ?? "";
        const source = row.accountId
            ? accountSourceKey(row.accountId)
            : row.useMachineLogin
              ? machineSourceKey(row.cli)
              : row.modelProvider && row.model
                ? polarSourceKey(row.modelProvider)
                : null;
        if (!source) continue;
        uses.push({ source, provider, model: row.model ?? null, at: row.createdAt });
    }
    return rankRecent(uses);
}

export async function pickerPrefsFor(userId: string): Promise<PickerPrefs> {
    const [row, recent] = await Promise.all([
        prisma.polarPreference
            .findUnique({ where: { userId }, select: { sourceOrder: true } })
            .catch(() => null),
        recentFor(userId)
    ]);
    const order = sourceOrderSchema.safeParse(row?.sourceOrder ?? []);
    return { order: order.success ? order.data : [], recent };
}

/** Stores the order, already validated, and answers it. */
export async function setPickerOrder(userId: string, order: readonly string[]): Promise<readonly string[]> {
    const row = await prisma.polarPreference.upsert({
        where: { userId },
        create: { userId, sourceOrder: [...order] },
        update: { sourceOrder: [...order] },
        select: { sourceOrder: true }
    });
    return row.sourceOrder;
}
