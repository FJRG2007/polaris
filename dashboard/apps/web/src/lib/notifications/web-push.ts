/**
 * Web Push: telling a phone or a laptop something with every Polaris tab closed.
 *
 * The instance signs what it sends with a VAPID key pair (RFC 8292). The pair is
 * made here the first time anything asks for it and kept in the database, so it
 * exists on every install with no setup and survives restarts and updates; a
 * key that changed would orphan every subscription made with the old one. The
 * private half never leaves the server.
 *
 * Nothing here throws at its caller: a push is one more way an alert reaches
 * somebody, and the alert already happened.
 */

import { z } from "zod";
import webpush from "web-push";
import { prisma } from "@polaris/db";
import { appBaseUrl } from "@/lib/domain-service";

const VAPID_KEY = "push.vapid";

const vapidSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });

type Vapid = z.infer<typeof vapidSchema>;

let cached: Vapid | null = null;

function readVapid(value: string | undefined): Vapid | null {
    if (!value) return null;
    try {
        const parsed = vapidSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * The instance's key pair, made on first use.
 *
 * Created with a plain insert on the unique key, so two requests racing on a
 * fresh install agree: the loser's insert fails and it reads the winner's pair.
 */
export async function vapidKeys(): Promise<Vapid> {
    if (cached) return cached;
    const stored = await prisma.setting.findUnique({ where: { key: VAPID_KEY } });
    const existing = readVapid(stored?.value);
    if (existing) return (cached = existing);
    const fresh = webpush.generateVAPIDKeys();
    try {
        await prisma.setting.create({
            data: { key: VAPID_KEY, value: JSON.stringify(fresh), scope: "global" }
        });
        return (cached = fresh);
    } catch {
        const winner = readVapid(
            (await prisma.setting.findUnique({ where: { key: VAPID_KEY } }))?.value
        );
        if (!winner) throw new Error("Could not store the push key pair");
        return (cached = winner);
    }
}

/** What a browser hands over when it subscribes, checked before it is kept. */
export const pushSubscriptionSchema = z.object({
    endpoint: z
        .string()
        .trim()
        .url()
        .max(2048)
        .refine((value) => value.startsWith("https://"), "The push address must be https"),
    keys: z.object({
        p256dh: z.string().trim().min(1).max(256),
        auth: z.string().trim().min(1).max(256)
    })
});

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/** Keep a device's subscription for this account. The endpoint is the device:
 *  signed in again under another account, it now belongs to that one. */
export async function savePushSubscription(
    userId: string,
    input: PushSubscriptionInput,
    userAgent: string
): Promise<void> {
    const agent = userAgent.slice(0, 200);
    await prisma.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: {
            userId,
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            userAgent: agent
        },
        update: {
            userId,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            userAgent: agent,
            lastUsedAt: new Date()
        }
    });
}

/** Forget a device. Scoped to the account, so nobody can unsubscribe another. */
export async function removePushSubscription(userId: string, endpoint: string): Promise<void> {
    await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

/** How many devices this account has subscribed. */
export async function pushDeviceCount(userId: string): Promise<number> {
    return prisma.pushSubscription.count({ where: { userId } });
}

/** One action button on a notification; the service worker knows each `action`. */
export interface PushAction {
    readonly action: string;
    readonly title: string;
    /** What a press posts, to this Polaris's own API only, with no tab open. */
    readonly request?: { readonly url: string; readonly body: unknown };
}

/** What the service worker draws. Kept small: push services cap a payload at 4 KB. */
export interface PushPayload {
    readonly title: string;
    readonly body?: string | null;
    /** In-app path the notification opens. */
    readonly href?: string | null;
    /** Same tag replaces the earlier notification instead of stacking. */
    readonly tag?: string;
    readonly actions?: readonly PushAction[];
    readonly requireInteraction?: boolean;
}

/** As much text as belongs in a notification. */
function clip(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/** The JSON the service worker receives, trimmed to fit a push. Pure. */
export function pushBody(payload: PushPayload): string {
    return JSON.stringify({
        title: clip(payload.title, 120),
        body: payload.body ? clip(payload.body, 300) : "",
        href: payload.href ?? "/",
        tag: payload.tag ?? null,
        actions: (payload.actions ?? []).slice(0, 3),
        requireInteraction: payload.requireInteraction === true
    });
}

/**
 * The contact the push service is given with every send. Pure.
 *
 * It must be an https or mailto address, or the library refuses the send; an
 * install reached over plain http on its LAN gives its own host under https.
 * The service never opens it, it is only who to ask about this traffic.
 */
export function vapidSubject(base: string): string {
    try {
        const url = new URL(base);
        return `https://${url.host}`;
    } catch {
        return "https://localhost";
    }
}

/** Most a single account sends to at once; older devices beyond it are skipped. */
const MAX_DEVICES = 20;

/**
 * Send one notification to every device the account subscribed.
 *
 * A subscription the push service says is gone (404 or 410) is deleted: the
 * browser dropped it, and sending to it again is wasted work forever.
 */
export async function pushToUser(userId: string, payload: PushPayload): Promise<number> {
    try {
        const devices = await prisma.pushSubscription.findMany({
            where: { userId },
            orderBy: { lastUsedAt: "desc" },
            take: MAX_DEVICES,
            select: { id: true, endpoint: true, p256dh: true, auth: true }
        });
        if (devices.length === 0) return 0;
        const [keys, base] = await Promise.all([vapidKeys(), appBaseUrl()]);
        const options = {
            vapidDetails: { subject: vapidSubject(base), publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: 60 * 60,
            urgency: "high" as const,
            timeout: 10_000
        };
        const body = pushBody(payload);
        let sent = 0;
        await Promise.allSettled(
            devices.map(async (device) => {
                try {
                    await webpush.sendNotification(
                        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
                        body,
                        options
                    );
                    sent++;
                } catch (error) {
                    const status = (error as { statusCode?: number }).statusCode;
                    if (status === 404 || status === 410) {
                        await prisma.pushSubscription.deleteMany({ where: { id: device.id } });
                        return;
                    }
                    console.error(`polaris: push to a device of ${userId} failed (${status ?? "no status"})`);
                }
            })
        );
        return sent;
    } catch (error) {
        console.error("polaris: push delivery failed:", error);
        return 0;
    }
}
