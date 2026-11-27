/**
 * `/api/e2ee/mls`, as a plain function over a Request so the tests drive what
 * the route serves. 404 while sealed chat is off (`sealedChatServed()`): nothing about it
 * exists then.
 *
 * Authorization, on every op: a session; a device is only ever the session's
 * own (`registerDevice` first); every conversation op needs the account to
 * reach the conversation (`channelAccess`), and so does every account the op
 * names - whose key packages are claimed, who a Welcome or a history-key
 * envelope is for. A device reads only the group-wide log and its own
 * Welcomes, and only history keys sealed to its own account.
 *
 * `account-keys` hands out public keys only of accounts that reach the
 * conversation, and answers an account outside it exactly as one without a
 * key (left out, never refused), so it cannot be used to learn who exists or
 * who has set up encryption anywhere but in a conversation the caller is in.
 * `member-account-keys` lists the keys of the conversation's own people only,
 * to a caller who is one of them. `roster` answers a member which of the
 * accounts it names have left the conversation - what anybody in it sees on
 * its member list - and who is in it with a device but holds no leaf.
 */

import { chatE2eeEnabled, sealedChatServed } from "./flag";
import { NextResponse } from "next/server";
import * as delivery from "./mls-delivery";
import * as sealed from "./sealed-messages";
import * as segments from "./search-segments-service";
import { conversationSealed } from "./sealed-conversation";
import { backgroundUser } from "@/lib/session";
import { sealedAppOutdated } from "./client-version";
import { mlsBody, type MlsBody } from "./schemas";
import { LEGACY_EPOCH } from "./mls-history-keys";
import { channelAccess, conversationAudience, type ChatAccessError } from "@/lib/chat/access";
import { rateLimit } from "@/lib/rate-limit-service";

const WINDOW_MS = 15 * 60 * 1000;
const PER_ACCOUNT = 1_200;
/** The organisation recovery key's envelope recipient (proposal 3.5). */
const ORG_RECIPIENT = "org";
/** Members per `member-account-keys` page. */
const MEMBER_PAGE = 100;
/** Accounts `roster` checks outside the list, and names to add, at most (a `claim-key-packages` call's worth). */
const JOINABLE_PAGE = 100;

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

/** The device is the session's own and known; its use keeps it from counting as inactive. */
async function ownDevice(userId: string, device: string): Promise<boolean> {
    return delivery.touchDevice(userId, device);
}

const REFUSED = { error: "refused" } as const;

export async function handleMls(request: Request): Promise<Response> {
    if (!sealedChatServed()) return json({ error: "Not found" }, 404);
    const user = await backgroundUser();
    // i18n-ignore: a status body no screen shows
    if (!user) return json({ error: "Unauthorized" }, 401);
    // A Polaris app too old for sealed chat gets no device here, and its page says
    // to update instead (owner decision 5: no plaintext copy for old clients).
    const outdated = sealedAppOutdated(request.headers.get("user-agent"));
    if (outdated) return json({ error: "updateApp", app: outdated.app, minimum: outdated.minimum }, 426);
    const parsed = mlsBody.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid" }, 400);
    const limit = await rateLimit(`e2ee-mls:${user.id}`, PER_ACCOUNT, WINDOW_MS);
    if (!limit.ok) return json({ error: "tooMany", retryAfterMs: limit.retryAfterMs }, 429);
    return answerMls(user.id, parsed.data);
}

/**
 * One op, as `userId`, past the session and the rate limit: the route's own
 * answer, and the in-process transport of the members the server runs
 * (`service-device.ts`), which have no session. Every per-account check the
 * route makes still holds - `channelAccess` answers a service account too.
 */
export async function answerMls(userId: string, body: MlsBody): Promise<Response> {
    if (!sealedChatServed()) return json({ error: "Not found" }, 404);
    try {
        return await run(userId, body);
    } catch (caught) {
        if (caught instanceof delivery.MlsDeliveryRefusal || caught instanceof sealed.SealedRefusal || caught instanceof segments.SearchSegmentRefusal)
            return json({ error: caught.reason }, 409);
        // A chat rule (an edit past its window, somebody else's message) is an answer the reader is shown, in their language.
        if (caught instanceof Error && (caught.name === "ChatAccessError" || caught.name === "ChatRuleError"))
            return json({ error: "refused", text: await readerText(caught as ChatAccessError) }, 409);
        console.error("polaris: an MLS delivery step failed:", caught);
        return json(REFUSED, 400);
    }
}

/** A chat refusal in the reader's language; English where no request names one (a member the server runs). */
async function readerText(refusal: ChatAccessError): Promise<string> {
    const locale = await import("@/lib/i18n/request").then((i18n) => i18n.getLocale()).catch(() => null);
    return locale ? refusal.textIn(locale) : refusal.message;
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
    if (body.op === "retire-device") {
        await delivery.retireDevice(userId, body.device);
        return json({ ok: true });
    }
    if (body.op === "index-segments") {
        const reaches = (channelId: string) => channelAccess({ id: userId }, channelId).then(Boolean);
        if (body.channelId && !(await reaches(body.channelId))) return json(REFUSED, 403);
        const listed = await segments.listIndexSegments(
            userId,
            {
                ...(body.channelId ? { channelId: body.channelId } : {}),
                ...(body.channelId && body.epoch !== undefined ? { epoch: BigInt(body.epoch) } : {}),
                ...(body.before ? { before: new Date(body.before) } : {})
            },
            reaches
        );
        return json({
            segments: listed.segments.map((s) => ({ ...s, epoch: s.epoch.toString(), createdAt: s.createdAt.toISOString() })),
            next: listed.next?.toISOString() ?? null
        });
    }
    // Every other op is about one conversation the account has to reach.
    if (!(await channelAccess({ id: userId }, body.channelId))) return json(REFUSED, 403);
    switch (body.op) {
        case "claim-key-packages": {
            if (!(await allReach(body.channelId, body.userIds))) return json(REFUSED, 403);
            const claimed = await delivery.claimKeyPackages(body.userIds, body.ciphersuite);
            return json({ keyPackages: claimed.map((c) => ({ address: c.address, keyPackage: text(c.keyPackage) })) });
        }
        case "account-keys": {
            const distinct = [...new Set(body.userIds)];
            const reach = await Promise.all(distinct.map((id) => channelAccess({ id }, body.channelId)));
            const keys = await delivery.accountPublicKeys(distinct.filter((_, i) => reach[i]));
            return json({
                accountKeys: keys.map((k) => ({
                    userId: k.userId,
                    akVersion: k.akVersion,
                    signPublicKey: text(k.signPublicKey),
                    hpkePublicKey: text(k.hpkePublicKey)
                }))
            });
        }
        case "member-account-keys": {
            // The people in the conversation (the same list @ offers), by id, after the cursor.
            const audience = ((await conversationAudience({ id: userId }, body.channelId)) ?? []).sort();
            const page = audience.filter((id) => !body.after || id > body.after).slice(0, MEMBER_PAGE);
            const keys = await delivery.accountPublicKeys(page);
            return json({
                accountKeys: keys.map((k) => ({ userId: k.userId, akVersion: k.akVersion, hpkePublicKey: text(k.hpkePublicKey) })),
                next: page.length === MEMBER_PAGE ? page[page.length - 1] : null
            });
        }
        case "legacy-key-gaps": {
            // Only a member who holds a key the server sealed and forgot can pass it on; anybody else learns nothing.
            // A page of such epochs, highest (the migration's) first, sharing one budget of gaps: an epoch the budget
            // cut short is answered again from `next`, by when the caller has sealed to the ones it was given.
            const epochs = await delivery.serverSealedEpochs(body.channelId, userId, body.upTo === undefined ? undefined : BigInt(body.upTo));
            if (!epochs.length) return json({ accountKeys: [], epochs: [], next: null });
            const audience = ((await conversationAudience({ id: userId }, body.channelId)) ?? []).filter((id) => id !== userId).sort();
            const answered: { epoch: string; accountKeys: { userId: string; hpkePublicKey: string }[] }[] = [];
            let budget = delivery.MAX_CLAIM_USERS;
            let next: string | null = epochs.length === delivery.GAP_EPOCHS && epochs[epochs.length - 1]! > 0n ? (epochs[epochs.length - 1]! - 1n).toString() : null;
            for (const epoch of epochs) {
                const gaps = await delivery.legacyKeyGaps(body.channelId, epoch, audience, budget);
                if (gaps.length) answered.push({ epoch: epoch.toString(), accountKeys: gaps.map((k) => ({ userId: k.userId, hpkePublicKey: text(k.hpkePublicKey) })) });
                budget -= gaps.length;
                if (budget <= 0) {
                    next = epoch.toString();
                    break;
                }
            }
            // `accountKeys`: the migrated history's gaps alone, what older callers read.
            const legacy = answered.find((entry) => entry.epoch === LEGACY_EPOCH.toString());
            return json({ accountKeys: legacy?.accountKeys ?? [], epochs: answered, next });
        }
        case "roster": {
            // The people on the conversation's list reach it; anybody else named (a member the
            // server runs, or one who left) is asked of `channelAccess`, the rule every op follows -
            // at most a page of them per call, so naming made-up ids buys no more than any other op.
            const audience = new Set((await conversationAudience({ id: userId }, body.channelId)) ?? []);
            const named = new Set(body.accounts);
            const others = [...named].filter((id) => id !== userId && !audience.has(id)).slice(0, JOINABLE_PAGE);
            const reach = await Promise.all(others.map((id) => channelAccess({ id }, body.channelId)));
            const candidates = [...audience].filter((id) => id !== userId && !named.has(id));
            // Devices are answered only for the accounts named here or the caller's own, so the
            // call says nothing about the devices of anybody outside the caller's group.
            const devices = body.devices.filter((address) => {
                const account = address.slice(0, address.indexOf("/"));
                return account === userId || named.has(account);
            });
            return json({
                departed: others.filter((_, i) => !reach[i]),
                joinable: await delivery.accountsWithKeyPackages(candidates, body.ciphersuite, JOINABLE_PAGE),
                retired: await delivery.retiredDevices(devices)
            });
        }
        case "group": {
            const group = await delivery.groupState(body.channelId);
            return json({
                // Sealed with no group yet (the migration cut it): a send into it is sealed, also while held.
                sealed: group ? true : await conversationSealed(body.channelId),
                group: group && {
                    groupId: text(group.groupId),
                    ciphersuite: group.ciphersuite,
                    epoch: group.epoch.toString(),
                    groupInfo: group.groupInfo ? text(group.groupInfo) : null,
                    // A large group's GroupInfo leaves the tree out: it is kept in this many parts (`ratchet-tree`).
                    treeParts: await delivery.currentTreeParts(body.channelId, group.epoch)
                }
            });
        }
        case "put-tree-part":
            if (!(await ownDevice(userId, body.device))) return json(REFUSED, 403);
            await delivery.putTreePart(
                body.channelId,
                delivery.deviceAddress(userId, body.device),
                BigInt(body.epoch),
                body.part,
                body.parts,
                bytes(body.bytes)
            );
            return json({ ok: true });
        case "ratchet-tree": {
            const part = await delivery.readTreePart(body.channelId, BigInt(body.epoch), body.part);
            if (!part) return json({ error: "notFound" }, 404);
            return json({ parts: part.parts, bytes: text(part.bytes) });
        }
        case "create-group":
            // Held (the kill switch): nothing new becomes sealed - only a conversation sealed already gets its group.
            if (!chatE2eeEnabled() && !(await conversationSealed(body.channelId))) return json({ error: "held" }, 409);
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
                bytes(body.groupInfo),
                body.treeParts
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
        case "send-sealed": {
            const id = await sealed.sendSealed(userId, {
                channelId: body.channelId,
                device: body.device,
                clientKey: body.clientKey,
                parentId: body.parentId,
                replyToId: body.replyToId,
                ...(body.uploads ? { uploads: body.uploads } : {}),
                ...(body.poll ? { poll: body.poll } : {}),
                ...(body.forum ? { forum: body.forum } : {}),
                epoch: BigInt(body.epoch),
                senderLeaf: body.senderLeaf,
                ciphertext: bytes(body.ciphertext),
                signature: bytes(body.signature)
            });
            return json({ id });
        }
        case "schedule-sealed": {
            const { scheduleSealed } = await import("@/lib/chat/scheduled");
            const id = await scheduleSealed(
                { id: userId },
                {
                    channelId: body.channelId,
                    device: body.device,
                    clientKey: body.clientKey,
                    parentId: body.parentId,
                    replyToId: body.replyToId,
                    ...(body.uploads ? { uploads: body.uploads } : {}),
                    sendAt: body.sendAt,
                    epoch: BigInt(body.epoch),
                    senderLeaf: body.senderLeaf,
                    ciphertext: bytes(body.ciphertext),
                    signature: bytes(body.signature)
                }
            );
            return json({ id });
        }
        case "reseal-scheduled": {
            const { resealScheduled } = await import("@/lib/chat/scheduled");
            await resealScheduled(
                { id: userId },
                {
                    id: body.scheduledId,
                    channelId: body.channelId,
                    device: body.device,
                    epoch: BigInt(body.epoch),
                    senderLeaf: body.senderLeaf,
                    ciphertext: bytes(body.ciphertext),
                    signature: bytes(body.signature)
                }
            );
            return json({ ok: true });
        }
        case "edit-sealed": {
            const editedAt = await sealed.editSealed(userId, {
                channelId: body.channelId,
                device: body.device,
                messageId: body.messageId,
                epoch: BigInt(body.epoch),
                senderLeaf: body.senderLeaf,
                revision: body.revision,
                ciphertext: bytes(body.ciphertext),
                signature: bytes(body.signature)
            });
            return json({ editedAt: editedAt.toISOString() });
        }
        case "claim-index-build": {
            if (!(await ownDevice(userId, body.device))) return json(REFUSED, 403);
            const lease = await segments.claimIndexBuild(userId, body.device, body.channelId, BigInt(body.epoch), body.seq);
            return json({ granted: lease.granted, until: lease.until.toISOString() });
        }
        case "index-stretch":
            return json(await segments.indexStretch(userId, body.channelId, BigInt(body.epoch), body.afterId));
        case "put-index-segment": {
            if (!(await ownDevice(userId, body.device))) return json(REFUSED, 403);
            await segments.putIndexSegment(userId, {
                channelId: body.channelId,
                device: body.device,
                epoch: BigInt(body.epoch),
                seq: body.seq,
                generation: body.generation,
                base: body.base,
                messages: body.messages,
                lastId: body.lastId,
                nonce: bytes(body.nonce),
                ciphertext: bytes(body.ciphertext),
                signature: bytes(body.signature)
            });
            return json({ ok: true });
        }
        case "index-segment": {
            const found = await segments.readIndexSegment(userId, body.channelId, BigInt(body.epoch), body.seq, body.generation);
            if (!found) return json({ error: "gone" }, 404);
            return json({ ...found, nonce: text(found.nonce), ciphertext: text(found.ciphertext), signature: text(found.signature) });
        }
        case "read-sealed": {
            const rows = await sealed.readSealed(userId, body.channelId, body.messageIds);
            return json({
                messages: rows.map((r) => ({
                    id: r.id,
                    authorId: r.authorId,
                    signer: r.signer,
                    clientKey: r.clientKey,
                    device: r.device,
                    epoch: r.epoch.toString(),
                    senderLeaf: r.senderLeaf,
                    revision: r.revision,
                    ciphertext: text(r.ciphertext),
                    signature: text(r.signature),
                    signatureKey: text(r.signatureKey)
                }))
            });
        }
    }
}
