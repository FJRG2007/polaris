/**
 * Alert addresses: where other systems post alerts, each one the address of an
 * automation's "When an alert arrives" trigger.
 *
 * The address is `/api/alerts/<id>/<secret>`, the same pattern as a chat
 * channel's webhook: only the secret's SHA-256 is stored, it is compared in
 * constant time, and the full address is shown once, when it is made or reset.
 * A former alert topic kept its id and secret, so integrations set up before
 * topics moved into Automations keep posting to the same address.
 *
 * An alert starts a run of the automation; what happens next is its steps.
 * "Notify about the alert" delivers through `notify` as one of the `alerts.*`
 * events, so everything a reader set for notifications - muting the group or
 * one severity, its hours, quiet hours - applies. Urgent is the catalogue's
 * critical one and comes through quiet hours; min never reaches a device.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { AlertMessage } from "./parse";
import type { RunActor } from "@/lib/automations/types";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rateLimit, type RateLimitResult } from "@/lib/rate-limit-service";

/** Alerts one address takes per minute; past it the sender is told to wait. */
export const PER_ADDRESS = 60;
export const WINDOW_MS = 60_000;
/** The most people one alert reaches. */
export const MAX_RECIPIENTS = 500;
/** The node id the trigger of a former alert topic has. */
export const CARRIED_NODE_ID = "alert";

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

export interface AlertAddress {
    readonly id: string;
    readonly automationId: string;
    readonly nodeId: string;
    readonly name: string;
}

/** The address a path names, or null for an unknown id or a wrong secret. */
export async function addressFor(id: string, secret: string): Promise<AlertAddress | null> {
    if (!UUID.test(id) || !secret || secret.length > 200) return null;
    const row = await prisma.automationAlertAddress.findUnique({
        where: { id },
        select: {
            id: true,
            automationId: true,
            nodeId: true,
            tokenHash: true,
            automation: { select: { name: true } }
        }
    });
    if (!row || !secretMatches(secret, row.tokenHash)) return null;
    return { id: row.id, automationId: row.automationId, nodeId: row.nodeId, name: row.automation.name };
}

export function addressPostAllowed(addressId: string): Promise<RateLimitResult> {
    return rateLimit(`alert-topic:${addressId}`, PER_ADDRESS, WINDOW_MS);
}

export type AlertSource = "ntfy" | "gotify" | "json" | "automation";

/** What the trigger hands its run, read as `{{trigger.<field>}}`. */
export function alertCause(
    nodeId: string,
    alert: AlertMessage,
    defaultPriority: number,
    source: AlertSource,
    at: Date
): Record<string, unknown> {
    const priority = alert.priority ?? defaultPriority;
    return {
        id: nodeId,
        at: at.toISOString(),
        title: alert.title,
        message: alert.message,
        markdown: alert.markdown,
        priority,
        tags: alert.tags.join(", "),
        click: alert.click ?? "",
        actions: alert.actions.map((action) => ({ ...action })),
        dedupKey: alert.dedupKey ?? "",
        source
    };
}

export type FireResult =
    | { readonly ok: true; readonly runId: string; readonly priority: number }
    /** The automation is off, unpublished, or its published version has no such trigger. */
    | { readonly ok: false; readonly reason: "off" };

/** Start a run of the address's automation for one alert. */
export async function fireAlert(
    address: Pick<AlertAddress, "id" | "automationId" | "nodeId">,
    alert: AlertMessage,
    source: AlertSource,
    depth = 0
): Promise<FireResult> {
    const [{ fireTrigger }, { advanceRun }] = await Promise.all([
        import("@/lib/automations/combine"),
        import("@/lib/automations/engine")
    ]);
    const [automation, armed] = await Promise.all([
        prisma.automation.findUnique({
            where: { id: address.automationId },
            select: { enabled: true, publishedVersionId: true }
        }),
        prisma.automationTrigger.findUnique({
            where: { automationId_nodeId: { automationId: address.automationId, nodeId: address.nodeId } },
            select: { versionId: true, eventType: true, subjectKey: true, state: true }
        })
    ]);
    if (
        !automation?.enabled ||
        !automation.publishedVersionId ||
        !armed ||
        armed.eventType !== "core.alert" ||
        armed.subjectKey !== address.id
    )
        return { ok: false, reason: "off" };
    const config = core.CORE_NODE_CONFIGS["core.alertIn"].safeParse(
        JSON.parse(String((armed.state as { config?: unknown } | null)?.config ?? "{}"))
    );
    const at = new Date();
    const cause = alertCause(address.nodeId, alert, config.success ? config.data.defaultPriority : 3, source, at);
    const run = await fireTrigger({
        automationId: address.automationId,
        versionId: armed.versionId,
        triggerNodeId: address.nodeId,
        // Every alert is its own run; a sender's dedup key folds repeats on the bell instead.
        firingKey: `${address.nodeId}:alert:${newSecret().slice(0, 16)}`,
        cause,
        depth
    });
    await prisma.automationAlertAddress.updateMany({ where: { id: address.id }, data: { lastUsedAt: at } });
    if (!run) return { ok: false, reason: "off" };
    if (run.status === "running")
        void advanceRun(run.id).catch((caught: unknown) =>
            console.error("polaris: an automation run failed to step:", caught)
        );
    return { ok: true, runId: run.id, priority: cause.priority as number };
}

/** The organizations this account runs (owner or admin). */
export async function adminOrgIds(userId: string): Promise<string[]> {
    const [owned, admin] = await Promise.all([
        prisma.organization.findMany({ where: { ownerId: userId }, select: { id: true } }),
        prisma.organizationMember.findMany({ where: { userId, role: "admin" }, select: { orgId: true } })
    ]);
    return [...new Set([...owned.map((org) => org.id), ...admin.map((row) => row.orgId)])];
}

/**
 * Who "Notify about the alert" reaches. A personal automation: the account it
 * runs as. An organization's: that account and the people and teams the step
 * names, each only while still a member of that organization.
 */
export async function alertRecipients(input: {
    readonly runAsId: string;
    readonly orgId: string | null;
    readonly recipientUserIds: readonly string[];
    readonly recipientTeamIds: readonly string[];
}): Promise<string[]> {
    if (!input.orgId) return [input.runAsId];
    const orgId = input.orgId;
    const [org, teamMembers] = await Promise.all([
        prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } }),
        input.recipientTeamIds.length
            ? prisma.teamMember.findMany({
                  where: { teamId: { in: [...input.recipientTeamIds] }, team: { orgId } },
                  select: { userId: true },
                  take: MAX_RECIPIENTS
              })
            : Promise.resolve([])
    ]);
    if (!org) return [];
    const wanted = new Set([input.runAsId, ...input.recipientUserIds, ...teamMembers.map((row) => row.userId)]);
    const members = await prisma.organizationMember.findMany({
        where: { orgId, userId: { in: [...wanted] } },
        select: { userId: true },
        take: MAX_RECIPIENTS
    });
    const current = new Set(members.map((row) => row.userId));
    if (wanted.has(org.ownerId)) current.add(org.ownerId);
    return [...current].slice(0, MAX_RECIPIENTS);
}

/** Severity to the bell's tone. */
export function levelOf(priority: core.AlertPriority): "info" | "warning" | "danger" {
    return priority === 5 ? "danger" : priority === 4 ? "warning" : "info";
}

export interface AddressView {
    readonly id: string;
    readonly tail: string;
    readonly lastUsedAt: string | null;
    readonly createdAt: string;
}

/** The address a trigger node has, when it is that node's. */
export async function addressOf(actor: RunActor, automationId: string, addressId: string, nodeId: string) {
    const { load } = await import("@/lib/automations/service");
    await load(actor, automationId, false);
    if (!UUID.test(addressId)) return null;
    const row = await prisma.automationAlertAddress.findFirst({
        where: { id: addressId, automationId, nodeId },
        select: { id: true, tokenTail: true, lastUsedAt: true, createdAt: true }
    });
    return row
        ? {
              id: row.id,
              tail: row.tokenTail,
              lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
              createdAt: row.createdAt.toISOString()
          }
        : null;
}

/**
 * Make the address of a trigger node, or a new secret for the one it has: the
 * old secret stops working at once. The secret is answered once, here.
 */
export async function issueAddress(
    actor: RunActor,
    automationId: string,
    nodeId: string
): Promise<{ readonly view: AddressView; readonly secret: string }> {
    const { load } = await import("@/lib/automations/service");
    await load(actor, automationId, true);
    const secret = newSecret();
    const data = { tokenHash: hashSecret(secret), tokenTail: secret.slice(-4) };
    const row = await prisma.automationAlertAddress.upsert({
        where: { automationId_nodeId: { automationId, nodeId } },
        create: { automationId, nodeId, ...data },
        update: data,
        select: { id: true, tokenTail: true, lastUsedAt: true, createdAt: true }
    });
    return {
        secret,
        view: {
            id: row.id,
            tail: row.tokenTail,
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString()
        }
    };
}

/** Alert addresses a "Send an alert" step may post to: those of automations this account may edit. */
export async function addressChoices(
    userId: string,
    query: string
): Promise<Array<{ id: string; name: string }>> {
    const orgIds = await adminOrgIds(userId);
    const needle = query.trim();
    const rows = await prisma.automationAlertAddress.findMany({
        where: {
            automation: {
                OR: [{ userId }, { orgId: { in: orgIds } }],
                ...(needle ? { name: { contains: needle, mode: "insensitive" as const } } : {})
            }
        },
        select: { id: true, automation: { select: { name: true, org: { select: { name: true } } } } },
        orderBy: { createdAt: "asc" },
        take: 50
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.automation.org ? `${row.automation.name} (${row.automation.org.name})` : row.automation.name
    }));
}

/** An address with the automation it belongs to, for a "Send an alert" step. */
export async function addressById(id: string): Promise<AlertAddress | null> {
    if (!UUID.test(id)) return null;
    const row = await prisma.automationAlertAddress.findUnique({
        where: { id },
        select: { id: true, automationId: true, nodeId: true, automation: { select: { name: true } } }
    });
    return row ? { id: row.id, automationId: row.automationId, nodeId: row.nodeId, name: row.automation.name } : null;
}
