/**
 * The places an account can have alerts sent, besides the bell and its mailbox.
 *
 * A destination's target - a webhook URL or a phone number - is envelope
 * encrypted under the same master key as every other credential here, and is
 * never read back to a client. What the UI gets is the masked hint stored beside
 * it, so the list renders without ever touching the key.
 *
 * Everything is scoped to the owning user on every query, so one account can
 * neither see nor send through another's destinations.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    detectWebhookFormat,
    maskPhone,
    maskWebhookUrl,
    type DestinationInput,
    type NotificationDestinationKind,
    type WebhookFormat
} from "@polaris/core";
import { forgetDestination } from "./preferences";

/** A destination as the UI sees it. Never carries the target itself. */
export interface DestinationView {
    id: string;
    kind: NotificationDestinationKind;
    name: string;
    format: WebhookFormat | null;
    /** Masked URL or number, safe to render. */
    targetHint: string;
    enabled: boolean;
    /** ok | error | untested */
    status: string;
    lastError: string | null;
    lastUsedAt: string | null;
}

/** A destination with its target decrypted. Server-side only, never returned
 *  to a client - the senders take this and nothing else. */
export interface ResolvedDestination {
    id: string;
    kind: NotificationDestinationKind;
    name: string;
    format: WebhookFormat | null;
    targetHint: string;
    target: string;
}

const ROW_FIELDS = {
    id: true,
    kind: true,
    name: true,
    format: true,
    targetHint: true,
    enabled: true,
    status: true,
    lastError: true,
    lastUsedAt: true
} as const;

function toView(row: {
    id: string;
    kind: string;
    name: string;
    format: string | null;
    targetHint: string;
    enabled: boolean;
    status: string;
    lastError: string | null;
    lastUsedAt: Date | null;
}): DestinationView {
    return {
        id: row.id,
        kind: row.kind === "sms" ? "sms" : "webhook",
        name: row.name,
        format: (row.format as WebhookFormat | null) ?? null,
        targetHint: row.targetHint,
        enabled: row.enabled,
        status: row.status,
        lastError: row.lastError,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null
    };
}

export async function listDestinations(userId: string): Promise<DestinationView[]> {
    const rows = await prisma.notificationDestination.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: ROW_FIELDS
    });
    return rows.map(toView);
}

/** Whether every id belongs to this account. Guards a saved rule, so a tampered
 *  payload cannot route an account's alerts at somebody else's endpoint. */
export async function ownsDestinations(userId: string, ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const owned = await prisma.notificationDestination.count({
        where: { userId, id: { in: [...new Set(ids)] } }
    });
    return owned === new Set(ids).size;
}

/** What a destination is and where it points, without decrypting it. Used to
 *  describe a destination a send could not resolve. */
export async function destinationSummary(
    userId: string,
    id: string
): Promise<{ kind: NotificationDestinationKind; targetHint: string } | null> {
    const row = await prisma.notificationDestination.findFirst({
        where: { id, userId },
        select: { kind: true, targetHint: true }
    });
    if (!row) return null;
    return { kind: row.kind === "sms" ? "sms" : "webhook", targetHint: row.targetHint };
}

/** The target and shape of one destination, for a sender. Returns null when the
 *  row is gone, belongs to somebody else, is switched off, or cannot decrypt. */
export async function resolveDestination(userId: string, id: string): Promise<ResolvedDestination | null> {
    const row = await prisma.notificationDestination.findFirst({
        where: { id, userId, enabled: true }
    });
    if (!row || !row.encryptedTarget || !row.targetNonce) return null;
    let target: string;
    try {
        target = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedTarget),
                nonce: Buffer.from(row.targetNonce),
                keyId: row.targetKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        // The master key changed under it. Say nothing here; the send records
        // the failure so the destinations list shows why.
        return null;
    }
    return {
        id: row.id,
        kind: row.kind === "sms" ? "sms" : "webhook",
        name: row.name,
        format: (row.format as WebhookFormat | null) ?? null,
        targetHint: row.targetHint,
        target
    };
}

/** The target a destination points at, and how it should be displayed. */
function describeTarget(input: DestinationInput): { target: string; hint: string; format: WebhookFormat | null } {
    if (input.kind === "sms") {
        return { target: input.phone, hint: maskPhone(input.phone), format: null };
    }
    const format = input.format === "auto" ? detectWebhookFormat(input.url) : input.format;
    return { target: input.url, hint: maskWebhookUrl(input.url), format };
}

export async function createDestination(
    userId: string,
    input: DestinationInput
): Promise<{ destination?: DestinationView; error?: string }> {
    const { target, hint, format } = describeTarget(input);
    const blob = encryptSecret(target, loadEnv().POLARIS_MASTER_KEY);
    const row = await prisma.notificationDestination.create({
        data: {
            userId,
            kind: input.kind,
            name: input.label,
            format,
            targetHint: hint,
            encryptedTarget: blob.ciphertext,
            targetNonce: blob.nonce,
            targetKeyId: blob.keyId
        },
        select: ROW_FIELDS
    });
    return { destination: toView(row) };
}

/** Turn a destination on or off without losing it, or where it is routed. */
export async function setDestinationEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
    await prisma.notificationDestination.updateMany({ where: { id, userId }, data: { enabled } });
}

/** Remove a destination and stop every rule pointing at it. */
export async function deleteDestination(userId: string, id: string): Promise<void> {
    const removed = await prisma.notificationDestination.deleteMany({ where: { id, userId } });
    if (removed.count > 0) await forgetDestination(userId, id);
}

/** Record how a send to a destination went, for the card and for troubleshooting. */
export async function recordDestinationResult(id: string, error: string | null): Promise<void> {
    await prisma.notificationDestination.updateMany({
        where: { id },
        data: { status: error ? "error" : "ok", lastError: error, lastUsedAt: new Date() }
    });
}
