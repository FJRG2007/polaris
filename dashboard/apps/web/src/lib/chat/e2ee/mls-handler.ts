/**
 * `/api/e2ee/mls`, as a plain function over a Request so the tests drive what
 * the route serves. 404 while `chatE2eeEnabled()` is off: nothing about it
 * exists then.
 *
 * Authorization, on every op: a session; a device is only ever the session's
 * own (`registerDevice` first); every conversation op needs the account to
 * reach the conversation (`channelAccess`), and so does every account the op
 * names - whose key packages are claimed, who a Welcome or a history-key
 * envelope is for. A device reads only the group-wide log and its own
 * Welcomes, and only history keys sealed to its own account.
 */

import { prisma } from "@polaris/db";
import { chatE2eeEnabled } from "./flag";
import { NextResponse } from "next/server";
import * as delivery from "./mls-delivery";
import { backgroundUser } from "@/lib/session";
import { mlsBody, type MlsBody } from "./schemas";
import { channelAccess } from "@/lib/chat/access";
import { rateLimit } from "@/lib/rate-limit-service";

const WINDOW_MS = 15 * 60 * 1000;
const PER_ACCOUNT = 1_200;
/** The organisation recovery key's envelope recipient (proposal 3.5). */
const ORG_RECIPIENT = "org";

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readBody(request: Request): Promise<unknown> {
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json(;|$)/i.test(type.trim())) return null;
    try {
        return await request.json();
    } catch {
        return null;
    }
}

const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));
const text = (value: Uint8Array) => Buffer.from(value).toString("base64url");

/** Every one of these accounts reaches the conversation. */
async function allReach(channelId: string, userIds: Iterable<string>): Promise<boolean> {
    const distinct = [...new Set(userIds)];
    const reached = await Promise.all(distinct.map((id) => channelAccess({ id }, channelId)));
    return reached.every(Boolean);
}

/** The account half of a `${userId}/${device}` address (the schema fixes its shape). */
const accountOf = (address: string) => address.slice(0, address.indexOf("/"));

async function ownDevice(userId: string, device: string): Promise<boolean> {
    const row = await prisma.mlsDevice.findUnique({ where: { userId_device: { userId, device } }, select: { userId: true } });
    return Boolean(row);
}

const REFUSED = { error: "refused" } as const;

export async function handleMls(request: Request): Promise<Response> {
    if (!chatE2eeEnabled()) return json({ error: "Not found" }, 404);
    const user = await backgroundUser();
    // i18n-ignore: a status body no screen shows
    if (!user) return json({ error: "Unauthorized" }, 401);
    const parsed = mlsBody.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid" }, 400);
    const limit = await rateLimit(`e2ee-mls:${user.id}`, PER_ACCOUNT, WINDOW_MS);
    if (!limit.ok) return json({ error: "tooMany", retryAfterMs: limit.retryAfterMs }, 429);
    try {
        return await run(user.id, parsed.data);
    } catch (caught) {
        if (caught instanceof delivery.MlsDeliveryRefusal) return json({ error: caught.reason }, 409);
        console.error("polaris: an MLS delivery step failed:", caught);
        return json(REFUSED, 400);
    }
}

async function run(userId: string, body: MlsBody): Promise<Response> {
    if (body.op === "register-device") {
        await delivery.registerDevice(userId, body.device, bytes(body.signatureKey), body.e2eeVersion);
        return json({ ok: true, heldKeyPackages: await delivery.heldKeyPackages(userId, body.device, body.ciphersuite) });
    }
    if (body.op === "publish-key-packages") {
        await delivery.publishKeyPackages(userId, body.device, body.ciphersuite, body.keyPackages.map(bytes), body.lastResort);
        return json({ ok: true });
    }
    // Every other op is about one conversation the account has to reach.
    if (!(await channelAccess({ id: userId }, body.channelId))) return json(REFUSED, 403);
    switch (body.op) {
        case "claim-key-packages": {
            if (!(await allReach(body.channelId, body.userIds))) return json(REFUSED, 403);
            const claimed = await delivery.claimKeyPackages(body.userIds, body.ciphersuite);
            return json({ keyPackages: claimed.map((c) => ({ address: c.address, keyPackage: text(c.keyPackage) })) });
        }
        case "group": {
            const group = await delivery.groupState(body.channelId);
            return json({
                group: group && {
                    groupId: text(group.groupId),
                    ciphersuite: group.ciphersuite,
                    epoch: group.epoch.toString(),
                    groupInfo: group.groupInfo ? text(group.groupInfo) : null
                }
            });
        }
        case "create-group":
            await delivery.createGroup(body.channelId, bytes(body.groupId), body.ciphersuite, bytes(body.groupInfo));
            return json({ ok: true });
        case "commit": {
            if (!(await ownDevice(userId, body.device))) return json(REFUSED, 403);
            if (!(await allReach(body.channelId, body.welcomes.map((w) => accountOf(w.recipient))))) return json(REFUSED, 403);
            const moved = await delivery.submitCommit(
                body.channelId,
                delivery.deviceAddress(userId, body.device),
                BigInt(body.epoch),
                bytes(body.commit),
                body.welcomes.map((w) => ({ recipient: w.recipient, welcome: bytes(w.welcome) })),
                bytes(body.groupInfo)
            );
            return json({ epoch: moved.epoch.toString() });
        }
        case "application":
            if (!(await ownDevice(userId, body.device))) return json(REFUSED, 403);
            await delivery.sendApplication(body.channelId, delivery.deviceAddress(userId, body.device), BigInt(body.epoch), bytes(body.payload));
            return json({ ok: true });
        case "events": {
            if (!(await ownDevice(userId, body.device))) return json(REFUSED, 403);
            const events = await delivery.readEvents(body.channelId, delivery.deviceAddress(userId, body.device), BigInt(body.after));
            return json({
                events: events.map((e) => ({ seq: e.seq.toString(), epoch: e.epoch.toString(), kind: e.kind, sender: e.sender, payload: text(e.payload) }))
            });
        }
        case "put-history-keys": {
            const accounts = body.envelopes.map((e) => e.recipient).filter((r) => r !== ORG_RECIPIENT);
            if (accounts.some((r) => !/^[0-9a-f-]{36}$/.test(r)) || !(await allReach(body.channelId, accounts))) return json(REFUSED, 403);
            await delivery.putHistoryKeys(body.channelId, BigInt(body.epoch), body.envelopes.map((e) => ({ recipient: e.recipient, envelope: bytes(e.envelope) })));
            return json({ ok: true });
        }
        case "history-keys": {
            const keys = await delivery.historyKeys(body.channelId, userId, BigInt(body.from));
            return json({ historyKeys: keys.map((k) => ({ epoch: k.epoch.toString(), envelope: text(k.envelope) })) });
        }
    }
}
