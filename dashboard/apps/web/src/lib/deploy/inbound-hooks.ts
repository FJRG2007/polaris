/**
 * Inbound webhooks: a signed URL that redeploys one service when something
 * outside - a CI job, a registry - posts to it.
 *
 * A request must carry, with the secret shown once when the hook was made:
 *
 *   X-Polaris-Delivery:  a unique id for this request
 *   X-Polaris-Timestamp: unix seconds, within five minutes of this server's clock
 *   X-Polaris-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *
 * A signature is accepted once: the delivery id is not signed, so it is the
 * signature, not the id, that refuses a replay.
 *
 * The same scheme Polaris signs its own outbound webhooks with, so one verifier
 * serves both directions.
 *
 * It runs as the account that made it, and only while that account may still
 * deploy the service: the permission and the project access are both checked
 * again on every call, so a person who lost access cannot keep redeploying
 * through a URL they made while they had it.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { timingSafeEqual } from "node:crypto";
import { userHasPermission } from "@polaris/auth";
import { rateLimit } from "@/lib/rate-limit-service";
import * as access from "@/lib/deploy-project-access";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { newSigningSecret, signPayload } from "@/lib/notifications/outbound-hooks";

/** How far a request's timestamp may be from this server's clock. */
export const MAX_SKEW_SECONDS = 5 * 60;

/** How long an accepted signature is remembered: longer than any timestamp
 *  that could still pass, so a replay is always caught. */
const RECEIPT_TTL_MS = 2 * MAX_SKEW_SECONDS * 1000;

/** How many inbound hooks one account may keep. */
export const MAX_INBOUND_HOOKS = 20;

/** The most a request body may be; it is only signed over, never read. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface InboundHookView {
    id: string;
    name: string;
    applicationId: string;
    serviceName: string;
    enabled: boolean;
    lastUsedAt: string | null;
    createdAt: string;
}

export interface RedeployableService {
    id: string;
    name: string;
    project: string;
}

export const inboundHookInputSchema = z.object({
    name: z.string().trim().min(1).max(60),
    applicationId: z.string().uuid()
});

/** The headers a request has to carry, checked before anything is looked up. */
export const inboundHeadersSchema = z.object({
    delivery: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[A-Za-z0-9._:-]+$/),
    timestamp: z
        .string()
        .regex(/^\d{1,12}$/)
        .transform(Number),
    signature: z.string().regex(/^sha256=[0-9a-f]{64}$/i)
});

/** What a request came to. The status is the HTTP status the route answers. */
export type InboundOutcome =
    | { status: 202; deploymentId: string }
    | { status: 400 | 401 | 403 | 404 | 409 | 413 | 429; reason: string };

function sealed(value: string) {
    const blob = encryptSecret(value, loadEnv().POLARIS_MASTER_KEY);
    return { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

/** Whether the account may redeploy services at all: the deploy permission, or
 *  an administrator. */
async function mayDeploy(userId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (!user) return false;
    return user.isAdmin || (await userHasPermission(userId, "deploy.manage"));
}

/** The project access to redeploy this service, or null when it is not held. */
async function redeployAccess(
    applicationId: string,
    userId: string
): Promise<access.ProjectAccess | null> {
    if (!(await mayDeploy(userId))) return null;
    try {
        return await access.requireApplicationAccess(applicationId, userId, "deploy.run");
    } catch {
        return null;
    }
}

/** The services this account may redeploy, which are the only ones offered. */
export async function redeployableServices(userId: string): Promise<RedeployableService[]> {
    if (!(await mayDeploy(userId))) return [];
    const projectIds = await access.visibleProjectIds(userId);
    const reachable = (
        await Promise.all(
            projectIds.map((id) => access.projectAccess(id, userId).catch(() => null))
        )
    ).filter(
        (entry): entry is access.ProjectAccess =>
            entry !== null && access.accessCan(entry, "deploy.run")
    );
    if (reachable.length === 0) return [];
    const apps = await prisma.application.findMany({
        where: { environment: { projectId: { in: reachable.map((entry) => entry.projectId) } } },
        orderBy: { name: "asc" },
        take: 500,
        select: {
            id: true,
            name: true,
            environmentId: true,
            environment: { select: { projectId: true, project: { select: { name: true } } } }
        }
    });
    const byProject = new Map(reachable.map((entry) => [entry.projectId, entry]));
    return apps
        .filter((app) => {
            const granted = byProject.get(app.environment.projectId);
            return granted !== undefined && access.accessInEnvironment(granted, app.environmentId);
        })
        .map((app) => ({ id: app.id, name: app.name, project: app.environment.project.name }));
}

/** The account's hooks, or - given a service - only the ones that redeploy it. */
export async function listInboundHooks(
    userId: string,
    applicationId?: string
): Promise<InboundHookView[]> {
    const rows = await prisma.inboundWebhook.findMany({
        where: applicationId ? { userId, applicationId } : { userId },
        orderBy: { createdAt: "asc" },
        take: MAX_INBOUND_HOOKS,
        select: {
            id: true,
            name: true,
            applicationId: true,
            enabled: true,
            lastUsedAt: true,
            createdAt: true,
            application: { select: { name: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        applicationId: row.applicationId,
        serviceName: row.application.name,
        enabled: row.enabled,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    }));
}

/** Make a hook for a service the account may redeploy. The secret is returned
 *  here and never again. */
export async function createInboundHook(
    userId: string,
    input: z.infer<typeof inboundHookInputSchema>
): Promise<
    { hook: InboundHookView; secret: string } | { error: "rateLimited" | "limit" | "forbidden" }
> {
    const limited = await rateLimit(`inbound-hook:create:${userId}`, 10, 10 * 60_000);
    if (!limited.ok) return { error: "rateLimited" };
    if ((await prisma.inboundWebhook.count({ where: { userId } })) >= MAX_INBOUND_HOOKS)
        return { error: "limit" };
    if (!(await redeployAccess(input.applicationId, userId))) return { error: "forbidden" };
    const secret = newSigningSecret();
    const row = await prisma.inboundWebhook.create({
        data: { userId, applicationId: input.applicationId, name: input.name, ...sealed(secret) },
        select: {
            id: true,
            name: true,
            applicationId: true,
            enabled: true,
            lastUsedAt: true,
            createdAt: true,
            application: { select: { name: true } }
        }
    });
    return {
        secret,
        hook: {
            id: row.id,
            name: row.name,
            applicationId: row.applicationId,
            serviceName: row.application.name,
            enabled: row.enabled,
            lastUsedAt: null,
            createdAt: row.createdAt.toISOString()
        }
    };
}

export async function setInboundHookEnabled(
    userId: string,
    id: string,
    enabled: boolean
): Promise<boolean> {
    return (
        (await prisma.inboundWebhook.updateMany({ where: { id, userId }, data: { enabled } }))
            .count > 0
    );
}

/**
 * Replace a hook's secret, keeping its URL: whoever held the old one can no
 * longer sign for it. The new one is returned here and never again.
 */
export async function rotateInboundHookSecret(
    userId: string,
    id: string
): Promise<{ secret: string } | { error: "rateLimited" | "notFound" }> {
    const limited = await rateLimit(`inbound-hook:rotate:${userId}`, 10, 10 * 60_000);
    if (!limited.ok) return { error: "rateLimited" };
    const secret = newSigningSecret();
    const result = await prisma.inboundWebhook.updateMany({
        where: { id, userId },
        data: sealed(secret)
    });
    return result.count > 0 ? { secret } : { error: "notFound" };
}

export async function deleteInboundHook(userId: string, id: string): Promise<boolean> {
    return (await prisma.inboundWebhook.deleteMany({ where: { id, userId } })).count > 0;
}

/** Compare two signatures in constant time. */
function sameSignature(expected: string, given: string): boolean {
    const a = Buffer.from(expected.toLowerCase());
    const b = Buffer.from(given.toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
}

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === "P2002";
}

/**
 * Check one request and, when it passes everything, start the deploy.
 *
 * The order is the cheapest refusal first, and nothing about the hook is told to
 * a caller who cannot sign for it: an unknown hook, a disabled one and a bad
 * signature all read the same from outside.
 */
export async function receiveInbound(input: {
    id: string;
    ip: string | null;
    headers: { delivery: string | null; timestamp: string | null; signature: string | null };
    body: string;
    now?: Date;
}): Promise<InboundOutcome> {
    const now = input.now ?? new Date();
    if (!z.string().uuid().safeParse(input.id).success)
        return { status: 404, reason: "Not found." };
    if (Buffer.byteLength(input.body) > MAX_BODY_BYTES)
        return { status: 413, reason: "Body too large." };
    const headers = inboundHeadersSchema.safeParse(input.headers);
    if (!headers.success) {
        return {
            status: 400,
            reason: "X-Polaris-Delivery, X-Polaris-Timestamp and X-Polaris-Signature are required."
        };
    }

    const [byIp, byHook] = await Promise.all([
        rateLimit(`inbound-hook:ip:${input.ip ?? "unknown"}`, 60, 60_000),
        rateLimit(`inbound-hook:${input.id}`, 30, 60_000)
    ]);
    if (!byIp.ok || !byHook.ok) return { status: 429, reason: "Too many requests." };

    const unsigned: InboundOutcome = { status: 401, reason: "Signature does not match." };
    const hook = await prisma.inboundWebhook.findUnique({
        where: { id: input.id },
        select: {
            id: true,
            userId: true,
            applicationId: true,
            enabled: true,
            encryptedSecret: true,
            secretNonce: true,
            secretKeyId: true
        }
    });
    if (!hook || !hook.enabled) return unsigned;

    const { timestamp, signature } = headers.data;
    if (Math.abs(now.getTime() / 1000 - timestamp) > MAX_SKEW_SECONDS) {
        return { status: 401, reason: "Timestamp is more than five minutes off." };
    }
    let secret: string;
    try {
        secret = decryptSecret(
            {
                ciphertext: Buffer.from(hook.encryptedSecret),
                nonce: Buffer.from(hook.secretNonce),
                keyId: hook.secretKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return unsigned;
    }
    if (!sameSignature(signPayload(secret, timestamp, input.body), signature)) return unsigned;

    // Recorded before anything runs, so two copies of one request arriving
    // together cannot both get past this line.
    let receiptId: string;
    try {
        const receipt = await prisma.inboundWebhookReceipt.create({
            data: {
                hookId: hook.id,
                deliveryId: signature.toLowerCase(),
                expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS)
            },
            select: { id: true }
        });
        receiptId = receipt.id;
    } catch (error) {
        if (isUniqueViolation(error))
            return { status: 409, reason: "This delivery was already received." };
        throw error;
    }
    const release = () =>
        prisma.inboundWebhookReceipt.deleteMany({ where: { id: receiptId } }).catch(() => null);

    const granted = await redeployAccess(hook.applicationId, hook.userId).catch(
        async (error: unknown) => {
            await release();
            throw error;
        }
    );
    if (!granted) {
        await release();
        return {
            status: 403,
            reason: "The account that made this hook may no longer deploy this service."
        };
    }

    const deployService = await import("@/lib/deploy-service");
    let deploymentId: string;
    try {
        deploymentId = await deployService.deployApplication(
            hook.applicationId,
            granted.ownerId,
            hook.userId
        );
    } catch (error) {
        await release();
        throw error;
    }
    await prisma.inboundWebhook
        .update({ where: { id: hook.id }, data: { lastUsedAt: now } })
        .catch(() => null);
    return { status: 202, deploymentId };
}

/** Forget signatures that could no longer pass the timestamp check anyway. */
export async function pruneInboundReceipts(now: Date = new Date()): Promise<number> {
    return (await prisma.inboundWebhookReceipt.deleteMany({ where: { expiresAt: { lt: now } } }))
        .count;
}
