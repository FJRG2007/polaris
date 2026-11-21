/**
 * A call ringing on an iPhone with the app closed.
 *
 * iOS gives an app no way to keep a connection open in the background, so the
 * Android path (`api/mobile/notices`, a service holding a stream) has no
 * counterpart there. What iOS offers instead is a VoIP push: Apple wakes the app
 * and the app shows the system's own incoming-call screen (CallKit). Sending one
 * takes a key from the operator's Apple Developer account, pasted on the
 * Integrations screen (`apple-push`); without it nothing here runs and an iPhone
 * hears a call only while the app is open, as before.
 *
 * Only a ring is pushed. iOS ends any app that receives a VoIP push and does not
 * show a call for it, so the end of a call is never a push: the app, awake while
 * its call screen is up, listens to the same stream Android does and takes the
 * call screen down when the ring ends there.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { createPrivateKey, sign } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import { publicAppUrl } from "@/lib/domain-service";

export const APPLE_PUSH_PROVIDER = "apple-push";

/** The identifier the published iPhone app is signed with (`mobile/ios/project.yml`). */
export const DEFAULT_IOS_BUNDLE = "app.polaris.mobile";

/** Apple's limits on the token's age: older than an hour is refused, and a new
 *  one more often than every twenty minutes is throttled. */
const JWT_REUSE_MS = 50 * 60_000;
/** How long Apple keeps trying a phone that is off: past the ring, a call is over. */
const RING_SECONDS = 45;
/** Pushes in flight at once, so a large group call does not open hundreds of streams. */
const CONCURRENCY = 8;

const HOSTS = {
    production: "https://api.push.apple.com",
    sandbox: "https://api.sandbox.push.apple.com"
} as const;

/** What the operator enters, as stored (non-secret part). */
export const applePushConfigSchema = z.object({
    keyId: z.string().trim().regex(/^[A-Z0-9]{10}$/),
    teamId: z.string().trim().regex(/^[A-Z0-9]{10}$/),
    bundleId: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
        .max(155),
    sandbox: z.boolean()
});
export type ApplePushConfig = z.infer<typeof applePushConfigSchema>;

/** What the app registers: PushKit's token, as hex. */
export const voipTokenSchema = z.object({
    token: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[0-9a-f]{64,200}$/)
});

/** Whether a pasted key reads as the .p8 file Apple hands out: an EC private key. */
export function validApnsKey(p8: string): boolean {
    try {
        const key = createPrivateKey(p8.trim());
        return key.asymmetricKeyType === "ec";
    } catch {
        return false;
    }
}

function base64url(input: Buffer | string): string {
    return Buffer.from(input).toString("base64url");
}

/** Apple's provider token: ES256 over the key id and team id. Pure. */
export function apnsJwt(config: Pick<ApplePushConfig, "keyId" | "teamId">, p8: string, nowMs: number): string {
    const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
    const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }));
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
        key: createPrivateKey(p8.trim()),
        dsaEncoding: "ieee-p1363"
    });
    return `${header}.${claims}.${base64url(signature)}`;
}

/** A ring, as the app reads it. Nothing in it is shown before the app checks it
 *  against the Polaris it belongs to. */
export interface VoipRing {
    readonly channelId: string;
    readonly meetingId: string;
    readonly caller: string;
}

/** The push body. Pure. `origin` lets an app with several Polaris instances
 *  tell which one is calling. */
export function voipPayload(ring: VoipRing, origin: string): string {
    return JSON.stringify({
        kind: "call",
        origin,
        channelId: ring.channelId,
        meetingId: ring.meetingId,
        caller: ring.caller,
        tag: `call:${ring.channelId}`,
        path: `/chat/c/${ring.channelId}`
    });
}

/** Whether Apple's answer means the phone no longer takes pushes for this app. */
export function tokenGone(status: number, reason: string | undefined): boolean {
    if (status === 410) return true;
    return status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic");
}

/** Register a phone's token for this account. A token moves to whoever signed
 *  in on that phone last. */
export async function registerVoipToken(userId: string, token: string): Promise<void> {
    await prisma.mobileVoipToken.upsert({
        where: { token },
        create: { userId, token },
        update: { userId, lastUsedAt: new Date() }
    });
}

/** Forget a phone's token, for this account only. */
export async function forgetVoipToken(userId: string, token: string): Promise<void> {
    await prisma.mobileVoipToken.deleteMany({ where: { userId, token } });
}

interface Ready {
    readonly config: ApplePushConfig;
    readonly p8: string;
}

let cachedJwt: { readonly key: string; readonly token: string; readonly at: number } | null = null;

function providerToken(ready: Ready, now: number): string {
    const key = `${ready.config.teamId}:${ready.config.keyId}:${ready.p8.length}`;
    if (cachedJwt && cachedJwt.key === key && now - cachedJwt.at < JWT_REUSE_MS) return cachedJwt.token;
    const token = apnsJwt(ready.config, ready.p8, now);
    cachedJwt = { key, token, at: now };
    return token;
}

/** The stored configuration, or null when the operator has not set one up. */
async function readyConfig(): Promise<Ready | null> {
    const state = await getIntegrationState(APPLE_PUSH_PROVIDER);
    if (!state?.enabled || !state.hasSecret) return null;
    const config = applePushConfigSchema.safeParse(state.config);
    if (!config.success) return null;
    const p8 = await getIntegrationSecret(APPLE_PUSH_PROVIDER);
    return p8 ? { config: config.data, p8 } : null;
}

function pushOne(
    session: ClientHttp2Session,
    token: string,
    body: string,
    headers: Record<string, string>
): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve) => {
        const stream = session.request({
            [constants.HTTP2_HEADER_METHOD]: "POST",
            [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
            ...headers
        });
        let status = 0;
        let text = "";
        stream.setEncoding("utf8");
        stream.on("response", (response) => {
            status = Number(response[constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        stream.on("data", (chunk: string) => {
            if (text.length < 4096) text += chunk;
        });
        stream.on("end", () => {
            let reason: string | undefined;
            try {
                reason = (JSON.parse(text) as { reason?: string }).reason;
            } catch {
                reason = undefined;
            }
            resolve({ status, reason });
        });
        stream.on("error", () => resolve({ status: 0 }));
        stream.setTimeout(10_000, () => {
            stream.close();
            resolve({ status: 0 });
        });
        stream.end(body);
    });
}

/**
 * Ring these accounts' iPhones. Never throws and never holds up the ring it was
 * called for: the caller fires it and moves on.
 */
export async function ringIphones(audience: readonly string[], ring: VoipRing): Promise<void> {
    if (audience.length === 0) return;
    try {
        const ready = await readyConfig();
        if (!ready) return;
        // Which Polaris is calling, for an app that holds several. Empty where this
        // one has no public name; the app then reads it as the one it uses.
        const origin = (await publicAppUrl().catch(() => null)) ?? "";
        const rows = await prisma.mobileVoipToken.findMany({
            where: { userId: { in: [...audience] } },
            select: { token: true },
            take: 500
        });
        if (rows.length === 0) return;
        const session = connect(ready.config.sandbox ? HOSTS.sandbox : HOSTS.production);
        session.on("error", (error) => console.error("voip push: connection failed:", error.message));
        const headers = {
            authorization: `bearer ${providerToken(ready, Date.now())}`,
            "apns-push-type": "voip",
            "apns-topic": `${ready.config.bundleId}.voip`,
            "apns-priority": "10",
            "apns-expiration": String(Math.floor(Date.now() / 1000) + RING_SECONDS),
            "apns-collapse-id": `call:${ring.channelId}`.slice(0, 64),
            "content-type": "application/json"
        };
        const body = voipPayload(ring, origin);
        const gone: string[] = [];
        const queue = rows.map((row) => row.token);
        async function worker(): Promise<void> {
            for (let token = queue.shift(); token; token = queue.shift()) {
                const answer = await pushOne(session, token, body, headers);
                if (tokenGone(answer.status, answer.reason)) gone.push(token);
                else if (answer.status !== 200) {
                    console.error(`voip push: refused (${answer.status} ${answer.reason ?? "no reason"})`);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
        session.close();
        if (gone.length > 0) await prisma.mobileVoipToken.deleteMany({ where: { token: { in: gone } } });
    } catch (caught) {
        console.error("voip push: could not ring:", caught instanceof Error ? caught.message : caught);
    }
}
