/**
 * Alert topics: who may manage one, the secret half of its address, who gets
 * what it receives, and the delivery itself.
 *
 * The address is `/api/alerts/<id>/<secret>`, the same pattern as a chat
 * channel's webhook: only the secret's SHA-256 is stored, it is compared in
 * constant time, and the full address is shown once, when it is made or reset.
 *
 * Delivery goes through `notify` as one of the `alerts.*` events, so everything
 * a reader set for notifications - muting the group or one severity, its hours,
 * quiet hours - applies. Urgent is the catalogue's critical one and comes
 * through quiet hours; min never reaches a device, only the bell.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { AlertMessage } from "./parse";
import { notify } from "@/lib/notifications/dispatch";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rateLimit, type RateLimitResult } from "@/lib/rate-limit-service";

/** Alerts one topic takes per minute; past it the sender is told to wait. */
export const PER_TOPIC = 60;
export const WINDOW_MS = 60_000;
/** The most people one alert reaches. */
export const MAX_RECIPIENTS = 500;
/** How long a delivery is kept for the list and the page it opens. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export class AlertTopicError extends Error {
    constructor(readonly code: "forbidden" | "missing" | "invalid") {
        super(code);
    }
}

export interface AlertTopicView {
    readonly id: string;
    readonly name: string;
    readonly orgId: string | null;
    readonly orgName: string | null;
    readonly tail: string;
    readonly defaultPriority: number;
    readonly pushFrom: number;
    readonly recipientUserIds: readonly string[];
    readonly recipientTeamIds: readonly string[];
    readonly lastUsedAt: string | null;
    readonly createdAt: string;
}

export interface AlertDeliveryView {
    readonly id: string;
    readonly priority: number;
    readonly title: string;
    readonly message: string;
    readonly tags: readonly string[];
    readonly source: string;
    readonly recipients: number;
    readonly status: string;
    readonly createdAt: string;
}

export function hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
}

export function newSecret(): string {
    return randomBytes(32).toString("base64url");
}

/** Whether a presented secret is the one whose hash is stored, in constant time. */
export function secretMatches(secret: string, storedHash: string): boolean {
    const presented = Buffer.from(hashSecret(secret), "hex");
    const stored = Buffer.from(storedHash, "hex");
    return presented.length === stored.length && timingSafeEqual(presented, stored);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TopicRow = NonNullable<Awaited<ReturnType<typeof prisma.alertTopic.findUnique>>>;

/** The topic an address names, or null for an unknown id or a wrong secret. */
export async function topicFor(id: string, secret: string): Promise<TopicRow | null> {
    if (!UUID.test(id) || !secret || secret.length > 200) return null;
    const topic = await prisma.alertTopic.findUnique({ where: { id } });
    if (!topic) return null;
    return secretMatches(secret, topic.tokenHash) ? topic : null;
}

export function topicPostAllowed(topicId: string): Promise<RateLimitResult> {
    return rateLimit(`alert-topic:${topicId}`, PER_TOPIC, WINDOW_MS);
}

/** The organizations this account runs (owner or admin). */
export async function adminOrgIds(userId: string): Promise<string[]> {
    const [owned, admin] = await Promise.all([
        prisma.organization.findMany({ where: { ownerId: userId }, select: { id: true } }),
        prisma.organizationMember.findMany({ where: { userId, role: "admin" }, select: { orgId: true } })
    ]);
    return [...new Set([...owned.map((org) => org.id), ...admin.map((row) => row.orgId)])];
}

/** Whether this account may change a topic: its own personal one, or one of an organization it runs. */
export async function canManage(userId: string, topic: Pick<TopicRow, "ownerId" | "orgId">): Promise<boolean> {
    if (!topic.orgId) return topic.ownerId === userId;
    return (await adminOrgIds(userId)).includes(topic.orgId);
}

/**
 * Who an alert on this topic reaches. A personal topic: its owner. An
 * organization's: its owner and the people and teams it names, each only while
 * still a member of that organization.
 */
export async function recipientsOf(
    topic: Pick<TopicRow, "ownerId" | "orgId" | "recipientUserIds" | "recipientTeamIds">
): Promise<string[]> {
    if (!topic.orgId) return [topic.ownerId];
    const orgId = topic.orgId;
    const [org, teamMembers] = await Promise.all([
        prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } }),
        topic.recipientTeamIds.length
            ? prisma.teamMember.findMany({
                  where: { teamId: { in: topic.recipientTeamIds }, team: { orgId } },
                  select: { userId: true },
                  take: MAX_RECIPIENTS
              })
            : Promise.resolve([])
    ]);
    if (!org) return [];
    const wanted = new Set([topic.ownerId, ...topic.recipientUserIds, ...teamMembers.map((row) => row.userId)]);
    const members = await prisma.organizationMember.findMany({
        where: { orgId, userId: { in: [...wanted] } },
        select: { userId: true },
        take: MAX_RECIPIENTS
    });
    const current = new Set(members.map((row) => row.userId));
    if (wanted.has(org.ownerId)) current.add(org.ownerId);
    return [...current].slice(0, MAX_RECIPIENTS);
}

export type AlertSource = "ntfy" | "gotify" | "json" | "test" | "automation";

export interface DeliveryResult {
    readonly id: string;
    readonly recipients: number;
    readonly priority: core.AlertPriority;
}

/** Severity to the bell's tone. */
export function levelOf(priority: core.AlertPriority): "info" | "warning" | "danger" {
    return priority === 5 ? "danger" : priority === 4 ? "warning" : "info";
}

/** Raise one alert on a topic: record it, then tell every recipient. */
export async function deliverAlert(
    topic: TopicRow,
    alert: AlertMessage,
    source: AlertSource
): Promise<DeliveryResult> {
    const priority = (alert.priority ?? topic.defaultPriority) as core.AlertPriority;
    const recipients = await recipientsOf(topic);
    const delivery = await prisma.alertDelivery.create({
        data: {
            topicId: topic.id,
            priority,
            title: alert.title,
            message: alert.message,
            markdown: alert.markdown,
            tags: [...alert.tags],
            click: alert.click,
            actions: alert.actions.map((action) => ({ ...action })),
            dedupKey: alert.dedupKey,
            source,
            recipients: recipients.length,
            status: "delivered"
        },
        select: { id: true }
    });
    const pushing = priority > 1 && priority >= topic.pushFrom;
    const title = alert.title || topic.name;
    const reports = await Promise.all(
        recipients.map((userId) =>
            notify({
                userId,
                event: core.alertEventId(priority),
                title,
                body: alert.message.slice(0, 1000),
                href: `/account/alerts/d/${delivery.id}`,
                level: levelOf(priority),
                shelf: { orgId: topic.orgId },
                audienceLabel: topic.name,
                // A sender's dedup key folds its repeats into the row already on
                // the bell for an hour; without one every alert is its own.
                dedupKey: alert.dedupKey ? `alert:${topic.id}:${alert.dedupKey}` : undefined,
                metadata: { alertTopicId: topic.id, alertTopic: topic.name, priority, tags: alert.tags },
                push: pushing
                    ? {
                          tag: alert.dedupKey ? `alert:${topic.id}:${alert.dedupKey}` : `alert:${delivery.id}`,
                          requireInteraction: priority === 5
                      }
                    : undefined
            }).catch(() => null)
        )
    );
    const folded = reports.length > 0 && reports.every((report) => report?.inapp === "collapsed");
    await Promise.all([
        folded
            ? prisma.alertDelivery.update({ where: { id: delivery.id }, data: { status: "folded" } })
            : null,
        prisma.alertTopic.update({ where: { id: topic.id }, data: { lastUsedAt: new Date() } }),
        prisma.alertDelivery.deleteMany({
            where: { topicId: topic.id, createdAt: { lt: new Date(Date.now() - KEEP_MS) } }
        })
    ]);
    return { id: delivery.id, recipients: recipients.length, priority };
}

function view(topic: TopicRow & { org: { name: string } | null }): AlertTopicView {
    return {
        id: topic.id,
        name: topic.name,
        orgId: topic.orgId,
        orgName: topic.org?.name ?? null,
        tail: topic.tokenTail,
        defaultPriority: topic.defaultPriority,
        pushFrom: topic.pushFrom,
        recipientUserIds: topic.recipientUserIds,
        recipientTeamIds: topic.recipientTeamIds,
        lastUsedAt: topic.lastUsedAt?.toISOString() ?? null,
        createdAt: topic.createdAt.toISOString()
    };
}

/** Every topic this account may manage: its own and those of organizations it runs. */
export async function listTopics(userId: string): Promise<AlertTopicView[]> {
    const orgIds = await adminOrgIds(userId);
    const rows = await prisma.alertTopic.findMany({
        where: { OR: [{ ownerId: userId, orgId: null }, { orgId: { in: orgIds } }] },
        include: { org: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        take: 200
    });
    return rows.map(view);
}

async function managed(userId: string, topicId: string): Promise<TopicRow> {
    const topic = await prisma.alertTopic.findUnique({ where: { id: topicId } });
    if (!topic) throw new AlertTopicError("missing");
    if (!(await canManage(userId, topic))) throw new AlertTopicError("forbidden");
    return topic;
}

export interface CreatedTopic {
    readonly topic: AlertTopicView;
    readonly secret: string;
}

export async function createTopic(userId: string, input: core.AlertTopicForm): Promise<CreatedTopic> {
    if (input.orgId && !(await adminOrgIds(userId)).includes(input.orgId)) {
        throw new AlertTopicError("forbidden");
    }
    const secret = newSecret();
    const row = await prisma.alertTopic.create({
        data: {
            ownerId: userId,
            orgId: input.orgId,
            name: input.name,
            tokenHash: hashSecret(secret),
            tokenTail: secret.slice(-4),
            defaultPriority: input.defaultPriority,
            pushFrom: input.pushFrom,
            recipientUserIds: input.orgId ? input.recipientUserIds : [],
            recipientTeamIds: input.orgId ? input.recipientTeamIds : []
        },
        include: { org: { select: { name: true } } }
    });
    return { topic: view(row), secret };
}

export async function updateTopic(
    userId: string,
    input: Omit<core.AlertTopicForm, "orgId"> & { topicId: string }
): Promise<AlertTopicView> {
    const topic = await managed(userId, input.topicId);
    const row = await prisma.alertTopic.update({
        where: { id: topic.id },
        data: {
            name: input.name,
            defaultPriority: input.defaultPriority,
            pushFrom: input.pushFrom,
            recipientUserIds: topic.orgId ? input.recipientUserIds : [],
            recipientTeamIds: topic.orgId ? input.recipientTeamIds : []
        },
        include: { org: { select: { name: true } } }
    });
    return view(row);
}

export async function resetTopicSecret(userId: string, topicId: string): Promise<CreatedTopic> {
    await managed(userId, topicId);
    const secret = newSecret();
    const row = await prisma.alertTopic.update({
        where: { id: topicId },
        data: { tokenHash: hashSecret(secret), tokenTail: secret.slice(-4) },
        include: { org: { select: { name: true } } }
    });
    return { topic: view(row), secret };
}

export async function deleteTopic(userId: string, topicId: string): Promise<void> {
    await managed(userId, topicId);
    await prisma.alertTopic.delete({ where: { id: topicId } });
}

export async function sendTestAlert(userId: string, topicId: string, words: AlertMessage): Promise<DeliveryResult> {
    return deliverAlert(await managed(userId, topicId), words, "test");
}

export async function recentDeliveries(userId: string, topicId: string): Promise<AlertDeliveryView[]> {
    await managed(userId, topicId);
    const rows = await prisma.alertDelivery.findMany({
        where: { topicId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
            id: true,
            priority: true,
            title: true,
            message: true,
            tags: true,
            source: true,
            recipients: true,
            status: true,
            createdAt: true
        }
    });
    return rows.map((row) => ({ ...row, message: row.message.slice(0, 200), createdAt: row.createdAt.toISOString() }));
}

/** Topics an automation's run-as account may raise alerts on (it manages them). */
export async function topicChoices(userId: string, query: string): Promise<Array<{ id: string; name: string }>> {
    const topics = await listTopics(userId);
    const needle = query.trim().toLowerCase();
    return topics
        .filter((topic) => !needle || topic.name.toLowerCase().includes(needle))
        .map((topic) => ({ id: topic.id, name: topic.orgName ? `${topic.name} (${topic.orgName})` : topic.name }));
}

export { managed as managedTopic };
