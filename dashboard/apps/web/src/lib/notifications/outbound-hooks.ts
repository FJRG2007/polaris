/**
 * Signed webhooks: an account's own endpoints that Polaris posts its alerts to.
 *
 * Unlike an alert destination, which reshapes an alert for a chat app, these are
 * for a program. Every body is Polaris's own JSON and is signed, so the endpoint
 * can prove it came from here:
 *
 *   X-Polaris-Timestamp: <unix seconds>
 *   X-Polaris-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *
 * Each alert becomes a delivery row first and is sent from that row, so an
 * endpoint that is down gets it later: retries at 1m, 5m, 30m, 2h and 6h. A row
 * is claimed with a conditional update before it is sent, so two runners - the
 * request that raised the alert and the background job - never send it twice. An
 * endpoint whose deliveries run out of attempts five times in a row is switched
 * off, and its owner is told.
 *
 * The URL and the secret are envelope encrypted like every other credential here
 * and never read back to a client; the secret is shown once, when it is made.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { createHmac, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    MAX_OUTBOUND_WEBHOOKS,
    maskWebhookUrl,
    type NotificationLevel,
    type OutboundWebhookInput
} from "@polaris/core";
import { rateLimit } from "@/lib/rate-limit-service";
import { configuredRequest, reachable, RefusedAddressError, safeUrl } from "@/lib/safe-fetch";

const MINUTE = 60_000;

/** When each retry is due, counted from the attempt before it. */
export const RETRY_DELAYS_MS = [
    MINUTE,
    5 * MINUTE,
    30 * MINUTE,
    2 * 60 * MINUTE,
    6 * 60 * MINUTE
] as const;

/** Deliveries in a row that ran out of attempts before an endpoint is switched off. */
export const DISABLE_AFTER_FAILURES = 5;

/** How long the delivery log is kept. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * MINUTE;

/** How long a claimed row is held before another runner may take it, should the
 *  one that claimed it die partway through. Longer than a send can take. */
const CLAIM_MS = 2 * MINUTE;

const SEND_TIMEOUT_MS = 10_000;

/** Rows one background pass sends at most; the rest wait for the next minute. */
const PASS_LIMIT = 200;

/** Why a delivery failed, as a code the page puts into words. */
export type DeliveryErrorCode =
    | "refused"
    | "redirect"
    | "http"
    | "timeout"
    | "network"
    | "unreadable"
    | "disabled";

/** What a webhook body carries. Stored as sent, so a redelivery is the same bytes. */
export interface OutboundPayload {
    event: string;
    level: NotificationLevel;
    title: string;
    body: string | null;
    url: string | null;
    at: string;
}

/** An endpoint as the page sees it. Never the URL or the secret. */
export interface OutboundHookView {
    id: string;
    name: string;
    urlHint: string;
    events: string[];
    enabled: boolean;
    consecutiveFailures: number;
    disabledReason: string | null;
    lastDeliveryAt: string | null;
    createdAt: string;
}

export interface OutboundDeliveryView {
    id: string;
    event: string;
    status: "pending" | "sent" | "failed";
    attempts: number;
    nextAttemptAt: string | null;
    responseStatus: number | null;
    error: DeliveryErrorCode | null;
    durationMs: number | null;
    createdAt: string;
}

export interface DeliveryPage {
    items: OutboundDeliveryView[];
    nextCursor: string | null;
}

/** The reasons a request here is refused, as codes the page puts into words. */
export type HookRefusal = "limit" | "rateLimited" | "unreachable" | "notFound";

const HOOK_FIELDS = {
    id: true,
    name: true,
    urlHint: true,
    events: true,
    enabled: true,
    consecutiveFailures: true,
    disabledReason: true,
    lastDeliveryAt: true,
    createdAt: true
} as const;

type HookRow = {
    id: string;
    name: string;
    urlHint: string;
    events: string[];
    enabled: boolean;
    consecutiveFailures: number;
    disabledReason: string | null;
    lastDeliveryAt: Date | null;
    createdAt: Date;
};

function toView(row: HookRow): OutboundHookView {
    return {
        id: row.id,
        name: row.name,
        urlHint: row.urlHint,
        events: row.events,
        enabled: row.enabled,
        consecutiveFailures: row.consecutiveFailures,
        disabledReason: row.disabledReason,
        lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    };
}

const DELIVERY_FIELDS = {
    id: true,
    event: true,
    status: true,
    attempts: true,
    nextAttemptAt: true,
    responseStatus: true,
    error: true,
    durationMs: true,
    createdAt: true
} as const;

const ERROR_CODES: readonly DeliveryErrorCode[] = [
    "refused",
    "redirect",
    "http",
    "timeout",
    "network",
    "unreadable",
    "disabled"
];

function toDeliveryView(row: {
    id: string;
    event: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date | null;
    responseStatus: number | null;
    error: string | null;
    durationMs: number | null;
    createdAt: Date;
}): OutboundDeliveryView {
    const status = row.status === "sent" || row.status === "failed" ? row.status : "pending";
    const error = ERROR_CODES.includes(row.error as DeliveryErrorCode)
        ? (row.error as DeliveryErrorCode)
        : null;
    return {
        id: row.id,
        event: row.event,
        status,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        responseStatus: row.responseStatus,
        error,
        durationMs: row.durationMs,
        createdAt: row.createdAt.toISOString()
    };
}

/** The value of X-Polaris-Signature for one body. */
export function signPayload(secret: string, timestamp: number, body: string): string {
    return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** A fresh signing secret: 32 random bytes, prefixed so it is recognisable. */
export function newSigningSecret(): string {
    return `whsec_${randomBytes(32).toString("base64url")}`;
}

function seal(value: string): { ciphertext: Uint8Array; nonce: Uint8Array; keyId: string } {
    const blob = encryptSecret(value, loadEnv().POLARIS_MASTER_KEY);
    return { ciphertext: blob.ciphertext, nonce: blob.nonce, keyId: blob.keyId };
}

function open(ciphertext: Uint8Array, nonce: Uint8Array, keyId: string | null): string {
    return decryptSecret(
        { ciphertext: Buffer.from(ciphertext), nonce: Buffer.from(nonce), keyId: keyId ?? "" },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** Count one create, test or redelivery against the account. */
async function allowed(userId: string, action: "create" | "test" | "redeliver"): Promise<boolean> {
    const limits = { create: 10, test: 20, redeliver: 30 } as const;
    const result = await rateLimit(
        `outbound-hook:${action}:${userId}`,
        limits[action],
        10 * MINUTE
    );
    return result.ok;
}

/** Whether an address may be posted to: http(s), no credentials, a public host. */
async function addressAllowed(address: string): Promise<boolean> {
    const url = safeUrl(address, Number.POSITIVE_INFINITY);
    return url !== null && (await reachable(url.hostname));
}

export async function listOutboundHooks(userId: string): Promise<OutboundHookView[]> {
    const rows = await prisma.outboundWebhook.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take: MAX_OUTBOUND_WEBHOOKS,
        select: HOOK_FIELDS
    });
    return rows.map(toView);
}

/** Add an endpoint. The secret is returned here and never again. */
export async function createOutboundHook(
    userId: string,
    input: OutboundWebhookInput
): Promise<{ hook: OutboundHookView; secret: string } | { error: HookRefusal }> {
    if (!(await allowed(userId, "create"))) return { error: "rateLimited" };
    const count = await prisma.outboundWebhook.count({ where: { userId } });
    if (count >= MAX_OUTBOUND_WEBHOOKS) return { error: "limit" };
    if (!(await addressAllowed(input.url))) return { error: "unreachable" };

    const secret = newSigningSecret();
    const url = seal(input.url);
    const sealed = seal(secret);
    const row = await prisma.outboundWebhook.create({
        data: {
            userId,
            name: input.name,
            urlHint: maskWebhookUrl(input.url),
            encryptedUrl: url.ciphertext,
            urlNonce: url.nonce,
            urlKeyId: url.keyId,
            encryptedSecret: sealed.ciphertext,
            secretNonce: sealed.nonce,
            secretKeyId: sealed.keyId,
            events: input.events
        },
        select: HOOK_FIELDS
    });
    return { hook: toView(row), secret };
}

/** Change which events an endpoint is sent. */
export async function setOutboundHookEvents(
    userId: string,
    id: string,
    events: string[]
): Promise<boolean> {
    const result = await prisma.outboundWebhook.updateMany({
        where: { id, userId },
        data: { events }
    });
    return result.count > 0;
}

/** Switch an endpoint on or off. Switching it on starts its failure count over. */
export async function setOutboundHookEnabled(
    userId: string,
    id: string,
    enabled: boolean
): Promise<boolean> {
    const result = await prisma.outboundWebhook.updateMany({
        where: { id, userId },
        data: enabled ? { enabled, consecutiveFailures: 0, disabledReason: null } : { enabled }
    });
    return result.count > 0;
}

/** Replace the signing secret. The new one is returned here and never again. */
export async function rotateOutboundHookSecret(userId: string, id: string): Promise<string | null> {
    const secret = newSigningSecret();
    const sealed = seal(secret);
    const result = await prisma.outboundWebhook.updateMany({
        where: { id, userId },
        data: {
            encryptedSecret: sealed.ciphertext,
            secretNonce: sealed.nonce,
            secretKeyId: sealed.keyId
        }
    });
    return result.count > 0 ? secret : null;
}

/** Remove an endpoint and its log. */
export async function deleteOutboundHook(userId: string, id: string): Promise<boolean> {
    const result = await prisma.outboundWebhook.deleteMany({ where: { id, userId } });
    return result.count > 0;
}

/** One page of an endpoint's log, newest first. The cursor is the last row's id. */
export async function listOutboundDeliveries(
    userId: string,
    webhookId: string,
    cursor: string | null,
    limit = 20
): Promise<DeliveryPage> {
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await prisma.outboundWebhookDelivery.findMany({
        where: { webhookId, webhook: { userId } },
        orderBy: { id: "desc" },
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: DELIVERY_FIELDS
    });
    const more = rows.length > take;
    const items = (more ? rows.slice(0, take) : rows).map(toDeliveryView);
    return { items, nextCursor: more ? (items[items.length - 1]?.id ?? null) : null };
}

/**
 * Queue an alert for every endpoint of the account that asked for its event,
 * then try each one straight away. Never throws at the caller.
 */
export async function queueOutboundHooks(userId: string, payload: OutboundPayload): Promise<void> {
    const hooks = await prisma.outboundWebhook.findMany({
        where: { userId, enabled: true, events: { has: payload.event } },
        take: MAX_OUTBOUND_WEBHOOKS,
        select: { id: true }
    });
    if (hooks.length === 0) return;
    const body = JSON.stringify(payload);
    const now = new Date();
    const rows = await Promise.all(
        hooks.map((hook) =>
            prisma.outboundWebhookDelivery.create({
                data: {
                    webhookId: hook.id,
                    event: payload.event,
                    payload: body,
                    nextAttemptAt: now
                },
                select: { id: true }
            })
        )
    );
    await Promise.allSettled(rows.map((row) => attemptDelivery(row.id)));
}

/** Post one body, signed. Only a 2xx counts; a redirect is never followed. */
async function post(
    url: string,
    secret: string,
    deliveryId: string,
    event: string,
    body: string
): Promise<
    { ok: true; status: number } | { ok: false; status: number | null; error: DeliveryErrorCode }
> {
    const timestamp = Math.floor(Date.now() / 1000);
    try {
        const response = await configuredRequest(
            url,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Polaris-Webhooks/1",
                    "X-Polaris-Event": event,
                    "X-Polaris-Delivery": deliveryId,
                    "X-Polaris-Timestamp": String(timestamp),
                    "X-Polaris-Signature": signPayload(secret, timestamp, body)
                },
                body,
                timeoutMs: SEND_TIMEOUT_MS
            },
            { allowPrivate: false }
        );
        // The body is never read: it is somebody else's text and nothing here
        // shows it. Released so the socket goes back to the pool.
        await response.body?.cancel().catch(() => {});
        if (response.status >= 200 && response.status < 300)
            return { ok: true, status: response.status };
        if (response.status >= 300 && response.status < 400) {
            return { ok: false, status: response.status, error: "redirect" };
        }
        return { ok: false, status: response.status, error: "http" };
    } catch (error) {
        if (error instanceof RefusedAddressError)
            return { ok: false, status: null, error: "refused" };
        const name = (error as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError")
            return { ok: false, status: null, error: "timeout" };
        return { ok: false, status: null, error: "network" };
    }
}

/**
 * Claim one due row and send it. Returns the row's status afterwards, or null
 * when another runner holds it or it is not due.
 *
 * `final` sends it once with no retries and leaves the endpoint's failure count
 * alone: a test is somebody checking their endpoint, not a delivery it missed.
 */
export async function attemptDelivery(
    deliveryId: string,
    options: { final?: boolean; now?: Date } = {}
): Promise<"sent" | "pending" | "failed" | null> {
    const now = options.now ?? new Date();
    const later = () => Math.max(now.getTime(), Date.now());
    const row = await prisma.outboundWebhookDelivery.findUnique({
        where: { id: deliveryId },
        select: {
            id: true,
            event: true,
            payload: true,
            status: true,
            attempts: true,
            nextAttemptAt: true,
            webhook: {
                select: {
                    id: true,
                    userId: true,
                    name: true,
                    enabled: true,
                    encryptedUrl: true,
                    urlNonce: true,
                    urlKeyId: true,
                    encryptedSecret: true,
                    secretNonce: true,
                    secretKeyId: true
                }
            }
        }
    });
    if (!row || row.status !== "pending" || !row.nextAttemptAt || row.nextAttemptAt > now)
        return null;

    // The claim: only the runner whose update matched sends it.
    const claimed = await prisma.outboundWebhookDelivery.updateMany({
        where: {
            id: row.id,
            status: "pending",
            attempts: row.attempts,
            nextAttemptAt: { lte: now }
        },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(later() + CLAIM_MS) }
    });
    if (claimed.count !== 1) return null;
    const attempts = row.attempts + 1;

    const hook = row.webhook;
    if (!hook.enabled && !options.final) {
        // Switched off while it waited: it is not sent, and not counted against it.
        await prisma.outboundWebhookDelivery.update({
            where: { id: row.id },
            data: { status: "failed", nextAttemptAt: null, error: "disabled" }
        });
        return "failed";
    }

    let url: string;
    let secret: string;
    try {
        url = open(hook.encryptedUrl, hook.urlNonce, hook.urlKeyId);
        secret = open(hook.encryptedSecret, hook.secretNonce, hook.secretKeyId);
    } catch {
        await prisma.outboundWebhookDelivery.update({
            where: { id: row.id },
            data: { status: "failed", nextAttemptAt: null, error: "unreadable" }
        });
        return "failed";
    }

    const started = Date.now();
    const result = await post(url, secret, row.id, row.event, row.payload);
    const durationMs = Date.now() - started;

    if (result.ok) {
        await prisma.outboundWebhookDelivery.update({
            where: { id: row.id },
            data: {
                status: "sent",
                nextAttemptAt: null,
                responseStatus: result.status,
                error: null,
                durationMs,
                deliveredAt: new Date()
            }
        });
        if (!options.final) {
            await prisma.outboundWebhook.updateMany({
                where: { id: hook.id },
                data: { consecutiveFailures: 0, lastDeliveryAt: new Date() }
            });
        }
        return "sent";
    }

    const retryIn = options.final ? undefined : RETRY_DELAYS_MS[attempts - 1];
    if (retryIn !== undefined) {
        await prisma.outboundWebhookDelivery.update({
            where: { id: row.id },
            data: {
                nextAttemptAt: new Date(later() + retryIn),
                responseStatus: result.status,
                error: result.error,
                durationMs
            }
        });
        return "pending";
    }

    await prisma.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
            status: "failed",
            nextAttemptAt: null,
            responseStatus: result.status,
            error: result.error,
            durationMs
        }
    });
    if (!options.final) await countFailure(hook.id, hook.userId, hook.name);
    return "failed";
}

/** One more delivery ran out of attempts. The fifth in a row switches it off. */
async function countFailure(hookId: string, userId: string, name: string): Promise<void> {
    const updated = await prisma.outboundWebhook.update({
        where: { id: hookId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true }
    });
    if (updated.consecutiveFailures < DISABLE_AFTER_FAILURES) return;
    // Conditional, so only one runner switches it off and only one tells the owner.
    const switched = await prisma.outboundWebhook.updateMany({
        where: { id: hookId, enabled: true },
        data: { enabled: false, disabledReason: "failures" }
    });
    if (switched.count !== 1) return;
    try {
        // Loaded here: dispatch queues these hooks, so a static import is a cycle.
        const [{ notify }, { wordsFor }] = await Promise.all([
            import("./dispatch"),
            import("./notice-words")
        ]);
        const t = await wordsFor(userId, "notices");
        await notify({
            userId,
            event: "webhook.disabled",
            title: t("webhooks.disabledTitle", { name }),
            body: t("webhooks.disabledBody"),
            href: "/account/webhooks"
        });
    } catch (error) {
        console.error("polaris: could not announce a switched-off webhook:", error);
    }
}

/** Send a sample event to one endpoint now, once. */
export async function testOutboundHook(
    userId: string,
    id: string,
    sample: Omit<OutboundPayload, "event" | "at">
): Promise<{ status: "sent" | "failed"; delivery: OutboundDeliveryView } | { error: HookRefusal }> {
    if (!(await allowed(userId, "test"))) return { error: "rateLimited" };
    const hook = await prisma.outboundWebhook.findFirst({
        where: { id, userId },
        select: { id: true }
    });
    if (!hook) return { error: "notFound" };
    const body = JSON.stringify({ event: "test", ...sample, at: new Date().toISOString() });
    return sendOnce(hook.id, "test", body);
}

/** Send a logged delivery again, as a new row with the same body. */
export async function redeliverOutbound(
    userId: string,
    deliveryId: string
): Promise<{ status: "sent" | "failed"; delivery: OutboundDeliveryView } | { error: HookRefusal }> {
    if (!(await allowed(userId, "redeliver"))) return { error: "rateLimited" };
    const original = await prisma.outboundWebhookDelivery.findFirst({
        where: { id: deliveryId, webhook: { userId } },
        select: { webhookId: true, event: true, payload: true }
    });
    if (!original) return { error: "notFound" };
    return sendOnce(original.webhookId, original.event, original.payload);
}

async function sendOnce(
    webhookId: string,
    event: string,
    body: string
): Promise<{ status: "sent" | "failed"; delivery: OutboundDeliveryView }> {
    const now = new Date();
    const row = await prisma.outboundWebhookDelivery.create({
        data: { webhookId, event, payload: body, nextAttemptAt: now },
        select: { id: true }
    });
    const status = await attemptDelivery(row.id, { final: true, now });
    const saved = await prisma.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id: row.id },
        select: DELIVERY_FIELDS
    });
    return { status: status === "sent" ? "sent" : "failed", delivery: toDeliveryView(saved) };
}

/**
 * The background pass: send what is due, then drop log rows past retention.
 * Run under a lease, but safe without one - every row is claimed on its own.
 */
export async function runOutboundHooks(
    now: Date = new Date()
): Promise<{ attempted: number; pruned: number }> {
    const due = await prisma.outboundWebhookDelivery.findMany({
        where: { status: "pending", nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: "asc" },
        take: PASS_LIMIT,
        select: { id: true }
    });
    // A few at a time: one slow endpoint must not hold up everybody else's.
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < due.length) {
            const row = due[next++];
            if (row) await attemptDelivery(row.id, { now }).catch(() => null);
        }
    };
    await Promise.all(Array.from({ length: Math.min(5, due.length) }, worker));

    const pruned = await prisma.outboundWebhookDelivery.deleteMany({
        where: { createdAt: { lt: new Date(now.getTime() - LOG_RETENTION_MS) } }
    });
    return { attempted: due.length, pruned: pruned.count };
}
