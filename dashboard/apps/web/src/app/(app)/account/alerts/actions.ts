"use server";

/**
 * Account > Alerts: the topics other systems post alerts to. Every action
 * re-checks `alerts.topics`, and every change re-checks that the account still
 * manages the topic (its own, or one of an organization it runs).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as topics from "@/lib/alerts/topics";
import { appBaseUrl } from "@/lib/domain-service";
import { requireUser, sessionCan } from "@/lib/session";
import type { OptionsPage } from "@/lib/deploy-target-options";

type Failure = { error: "forbidden" | "missing" | "invalid" | "failed" };

async function actor() {
    const user = await requireUser();
    if (!(await sessionCan(user, "alerts.topics"))) throw new topics.AlertTopicError("forbidden");
    return user;
}

function failed(caught: unknown): Failure {
    if (caught instanceof topics.AlertTopicError) return { error: caught.code };
    console.error("polaris: an alert topic action failed:", caught);
    return { error: "failed" };
}

const idSchema = z.string().uuid();

export interface AlertsScreen {
    readonly topics: topics.AlertTopicView[];
    readonly orgs: Array<{ id: string; name: string }>;
    readonly base: string;
}

export async function alertsScreenAction(): Promise<AlertsScreen | Failure> {
    try {
        const user = await actor();
        const [list, orgIds, base] = await Promise.all([
            topics.listTopics(user.id),
            topics.adminOrgIds(user.id),
            appBaseUrl()
        ]);
        const orgs = await prisma.organization.findMany({
            where: { id: { in: orgIds } },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        });
        return { topics: list, orgs, base };
    } catch (caught) {
        return failed(caught);
    }
}

export async function createTopicAction(
    input: unknown
): Promise<topics.CreatedTopic | Failure> {
    try {
        const user = await actor();
        const parsed = core.alertTopicFormSchema.safeParse(input);
        if (!parsed.success) return { error: "invalid" };
        return await topics.createTopic(user.id, parsed.data);
    } catch (caught) {
        return failed(caught);
    }
}

export async function updateTopicAction(input: unknown): Promise<topics.AlertTopicView | Failure> {
    try {
        const user = await actor();
        const parsed = core.alertTopicUpdateSchema.safeParse(input);
        if (!parsed.success) return { error: "invalid" };
        return await topics.updateTopic(user.id, parsed.data);
    } catch (caught) {
        return failed(caught);
    }
}

export async function resetTopicAction(topicId: unknown): Promise<topics.CreatedTopic | Failure> {
    try {
        const user = await actor();
        const id = idSchema.safeParse(topicId);
        if (!id.success) return { error: "invalid" };
        return await topics.resetTopicSecret(user.id, id.data);
    } catch (caught) {
        return failed(caught);
    }
}

export async function deleteTopicAction(topicId: unknown): Promise<{ ok: true } | Failure> {
    try {
        const user = await actor();
        const id = idSchema.safeParse(topicId);
        if (!id.success) return { error: "invalid" };
        await topics.deleteTopic(user.id, id.data);
        return { ok: true };
    } catch (caught) {
        return failed(caught);
    }
}

const testSchema = z.object({
    topicId: z.string().uuid(),
    priority: z.number().int().min(1).max(5),
    title: z.string().trim().max(core.ALERT_LIMITS.title),
    message: z.string().trim().min(1).max(core.ALERT_LIMITS.message)
});

export async function testTopicAction(input: unknown): Promise<{ recipients: number } | Failure> {
    try {
        const user = await actor();
        const parsed = testSchema.safeParse(input);
        if (!parsed.success) return { error: "invalid" };
        const { topicId, priority, title, message } = parsed.data;
        const result = await topics.sendTestAlert(user.id, topicId, {
            title,
            message,
            priority: priority as core.AlertPriority,
            tags: ["test"],
            click: null,
            icon: null,
            attach: null,
            markdown: false,
            actions: [],
            dedupKey: null
        });
        return { recipients: result.recipients };
    } catch (caught) {
        return failed(caught);
    }
}

export async function deliveriesAction(topicId: unknown): Promise<topics.AlertDeliveryView[] | Failure> {
    try {
        const user = await actor();
        const id = idSchema.safeParse(topicId);
        if (!id.success) return { error: "invalid" };
        return await topics.recentDeliveries(user.id, id.data);
    } catch (caught) {
        return failed(caught);
    }
}

const peopleSchema = z.object({ orgId: z.string().uuid(), query: z.string().trim().min(2).max(100) });

/** Members of an organization the account runs, for an organization topic's recipients. */
export async function orgPeopleAction(
    orgId: unknown,
    query: unknown
): Promise<{ results: Array<{ id: string; name: string }> }> {
    try {
        const user = await actor();
        const parsed = peopleSchema.safeParse({ orgId, query });
        if (!parsed.success) return { results: [] };
        if (!(await topics.adminOrgIds(user.id)).includes(parsed.data.orgId)) return { results: [] };
        const needle = parsed.data.query;
        const rows = await prisma.organizationMember.findMany({
            where: {
                orgId: parsed.data.orgId,
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
            results: rows.map(({ user: person }) => ({
                id: person.id,
                name: person.name || person.username || person.id
            }))
        };
    } catch {
        return { results: [] };
    }
}

export interface OrgAudience {
    readonly teams: Array<{ id: string; name: string }>;
    readonly people: Array<{ id: string; name: string }>;
}

/** An organization's teams, and the names of the people a topic already names. */
export async function orgAudienceAction(orgId: unknown, userIds: unknown): Promise<OrgAudience> {
    try {
        const user = await actor();
        const id = idSchema.safeParse(orgId);
        const ids = z.array(z.string().uuid()).max(core.ALERT_LIMITS.recipients).safeParse(userIds);
        if (!id.success || !ids.success) return { teams: [], people: [] };
        if (!(await topics.adminOrgIds(user.id)).includes(id.data)) return { teams: [], people: [] };
        const [teams, people] = await Promise.all([
            prisma.team.findMany({
                where: { orgId: id.data },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
                take: 200
            }),
            prisma.organizationMember.findMany({
                where: { orgId: id.data, userId: { in: ids.data } },
                select: { user: { select: { id: true, name: true, username: true } } }
            })
        ]);
        return {
            teams,
            people: people.map(({ user: person }) => ({ id: person.id, name: person.name || person.username || person.id }))
        };
    } catch {
        return { teams: [], people: [] };
    }
}

const choicesSchema = z.object({
    query: z.string().max(100).default(""),
    cursor: z.string().nullish(),
    ids: z.array(z.string().uuid()).max(50).optional()
});

/** The topics an automation step may raise alerts on, for its picker. */
export async function alertTopicChoicesAction(
    input: unknown
): Promise<OptionsPage<{ id: string; name: string }> | { error: string }> {
    try {
        const user = await actor();
        const parsed = choicesSchema.safeParse(input);
        if (!parsed.success) return { items: [], next: null };
        const all = await topics.topicChoices(user.id, parsed.data.ids ? "" : parsed.data.query);
        const items = parsed.data.ids ? all.filter((one) => parsed.data.ids?.includes(one.id)) : all;
        return { items, next: null };
    } catch {
        return { items: [], next: null };
    }
}
