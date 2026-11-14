"use server";

/**
 * Who "Notify about the alert" may reach on an organization's automation: its
 * members, found by name, and its teams. Only for an automation the caller may
 * edit, and only within that automation's own organization.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { load } from "@/lib/automations/service";
import { requirePermission } from "@/lib/session";

const peopleSchema = z.object({ automationId: z.string().uuid(), query: z.string().trim().min(2).max(100) });

async function orgOf(automationId: string, edit: boolean): Promise<string | null> {
    const user = await requirePermission("automations.use");
    const row = await load({ id: user.id, isAdmin: user.isAdmin }, automationId, edit);
    return row.orgId;
}

/** Members of the automation's organization, for the step's recipients. */
export async function alertPeopleAction(
    automationId: unknown,
    query: unknown
): Promise<{ results: Array<{ id: string; name: string }> }> {
    try {
        const parsed = peopleSchema.safeParse({ automationId, query });
        if (!parsed.success) return { results: [] };
        const orgId = await orgOf(parsed.data.automationId, true);
        if (!orgId) return { results: [] };
        const needle = parsed.data.query;
        const rows = await prisma.organizationMember.findMany({
            where: {
                orgId,
                user: {
                    OR: [
                        { name: { contains: needle, mode: "insensitive" } },
                        { username: { contains: needle, mode: "insensitive" } }
                    ]
                }
            },
            select: { user: { select: { id: true, name: true, username: true } } },
            take: 20
        });
        return {
            results: rows.map(({ user: person }) => ({ id: person.id, name: person.name || person.username || person.id }))
        };
    } catch {
        return { results: [] };
    }
}

export interface AlertAudience {
    /** Null on a personal automation: the step reaches its owner only. */
    readonly orgId: string | null;
    readonly teams: Array<{ id: string; name: string }>;
    readonly people: Array<{ id: string; name: string }>;
}

/** The automation's organization, its teams, and the names of the people the step already names. */
export async function alertAudienceAction(automationId: unknown, userIds: unknown): Promise<AlertAudience> {
    const none: AlertAudience = { orgId: null, teams: [], people: [] };
    try {
        const id = z.string().uuid().safeParse(automationId);
        const ids = z.array(z.string().uuid()).max(core.ALERT_LIMITS.recipients).safeParse(userIds);
        if (!id.success || !ids.success) return none;
        // Read access: a viewer sees who the step reaches without changing it.
        const orgId = await orgOf(id.data, false);
        if (!orgId) return none;
        const [teams, people] = await Promise.all([
            prisma.team.findMany({
                where: { orgId },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
                take: 200
            }),
            prisma.organizationMember.findMany({
                where: { orgId, userId: { in: ids.data } },
                select: { user: { select: { id: true, name: true, username: true } } }
            })
        ]);
        return {
            orgId,
            teams,
            people: people.map(({ user: person }) => ({ id: person.id, name: person.name || person.username || person.id }))
        };
    } catch {
        return none;
    }
}
