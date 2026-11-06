/**
 * Chat lock and hidden chats, the way a messenger has them.
 *
 * A locked conversation opens only after the reader's own chat lock code, and
 * its notifications carry no text. Whether locked conversations are left out of
 * the list (and reached through "Locked chats") is the reader's setting. A
 * hidden conversation needs no code: it is out of the list until a message
 * arrives in it, unless it is muted - the archive rule.
 *
 * The code is stretched with the same scrypt helper as link passwords, and
 * guesses are throttled per person, since a short code is the whole guard.
 * Everything here is the reader's own: nobody else in the conversation is told.
 *
 * Opening one with the code hands back an unlock proof: a signature over the
 * reader, the conversation and an expiry, kept by the tab in sessionStorage and
 * presented with every message read. The server refuses a locked conversation
 * without it, so a stale tab or a hand-made request reads nothing - and nothing
 * is stored server-side for an unlock, so closing the tab is the whole relock.
 * The expiry is the reader's own choice (`lock-timing`), and using the open
 * locked chat pushes it on.
 */

import { z } from "zod";
import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { publishChatChange } from "./live";
import { prisma, type Prisma } from "@polaris/db";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import { onShelf } from "@/app/(app)/chat/lock-shelf";
import * as timing from "./lock-timing";

/** Shortest and longest code accepted. Short is allowed on purpose: it guards a
 *  screen somebody is already signed in to, and guesses are throttled. */
export const LOCK_CODE_MIN = 4;
export const LOCK_CODE_MAX = 64;

/** Guesses allowed per person in one window before the code stops answering. */
const GUESSES = 8;
const GUESS_WINDOW_MS = 15 * 60_000;

export const lockCodeSchema = z.string().trim().min(LOCK_CODE_MIN).max(LOCK_CODE_MAX);

/** A new code: 4, 6 or 8 digits, so its box can submit on the last one. Codes
 *  set before this keep working through `lockCodeSchema`. */
export const newLockCodeSchema = z
    .string()
    .trim()
    .regex(/^\d+$/)
    .refine((code) => (timing.LOCK_CODE_LENGTHS as readonly number[]).includes(code.length));

export const setLockCodeSchema = z.object({
    code: newLockCodeSchema,
    /** Required once a code exists: changing it asks the one it replaces. */
    current: lockCodeSchema.optional()
});

export const channelFlagSchema = z.object({
    channelId: z.string().uuid(),
    on: z.boolean()
});

export const unlockMinutesSchema = z.object({
    minutes: z
        .number()
        .int()
        .refine((minutes) => (timing.CHAT_UNLOCK_CHOICES as readonly number[]).includes(minutes))
});

/** The reader's lock as a screen may know it - never the hash. */
export interface ChatLockState {
    readonly hasCode: boolean;
    readonly hideLocked: boolean;
    /** How long locked chats stay open after the code - see `lock-timing`. */
    readonly unlockMinutes: number;
    /** Digits in the code, or null when the box has to wait for a button. */
    readonly codeLength: number | null;
}

export async function lockState(userId: string): Promise<ChatLockState> {
    const row = await prisma.chatLock.findUnique({
        where: { userId },
        select: { hideLocked: true, unlockMinutes: true, codeLength: true }
    });
    return {
        hasCode: row !== null,
        hideLocked: row?.hideLocked ?? false,
        unlockMinutes: timing.unlockMinutesOf(row?.unlockMinutes),
        codeLength: timing.knownCodeLength(row?.codeLength)
    };
}

export async function hashLockCode(code: string): Promise<string> {
    return hashLinkPassword(code);
}

export async function lockCodeMatches(code: string, stored: string): Promise<boolean> {
    return verifyLinkPassword(code, stored);
}

/** Check a presented code, counting it against the reader's guesses. */
export async function verifyLockCode(actor: ChatActor, code: string): Promise<boolean> {
    const row = await prisma.chatLock.findUnique({
        where: { userId: actor.id },
        select: { codeHash: true }
    });
    if (!row) throw new ChatAccessError({ key: "errors.lockNoCode" });
    const key = `chat-lock:${actor.id}`;
    const allowed = await rateLimit(key, GUESSES, GUESS_WINDOW_MS);
    if (!allowed.ok) throw new ChatAccessError({ key: "errors.lockTooMany" });
    const ok = await lockCodeMatches(code, row.codeHash);
    if (ok) await resetRateLimit(key);
    return ok;
}

/** Set the code for the first time, or change it with the current one. */
export async function setLockCode(actor: ChatActor, code: string, current?: string): Promise<void> {
    const existing = await prisma.chatLock.findUnique({
        where: { userId: actor.id },
        select: { codeHash: true }
    });
    if (existing) {
        if (!current || !(await verifyLockCode(actor, current)))
            throw new ChatAccessError({ key: "errors.lockWrongCode" });
    }
    const codeHash = await hashLockCode(code);
    const codeLength = timing.knownCodeLength(code.length);
    await prisma.chatLock.upsert({
        where: { userId: actor.id },
        update: { codeHash, codeLength },
        create: { userId: actor.id, codeHash, codeLength }
    });
}

/** How long locked chats stay open after the code. Proofs already handed out
 *  keep the expiry they were minted with; the next one follows the choice. */
export async function setUnlockMinutes(actor: ChatActor, minutes: number): Promise<void> {
    const updated = await prisma.chatLock.updateMany({
        where: { userId: actor.id },
        data: { unlockMinutes: timing.unlockMinutesOf(minutes) }
    });
    if (updated.count === 0) throw new ChatAccessError({ key: "errors.lockNoCode" });
}

/** Take the code away, and with it every lock it guarded: the way back for a
 *  reader who forgot it, once they have proved who they are. */
export async function resetLockCode(actor: ChatActor): Promise<void> {
    await prisma.$transaction([
        prisma.chatChannelMember.updateMany({
            where: { userId: actor.id, locked: true },
            data: { locked: false }
        }),
        prisma.chatLock.deleteMany({ where: { userId: actor.id } })
    ]);
    await resetRateLimit(`chat-lock:${actor.id}`);
    publishChatChange({ kind: "channels", actorId: actor.id, audience: [actor.id] });
}

export async function setHideLocked(actor: ChatActor, hide: boolean): Promise<void> {
    const updated = await prisma.chatLock.updateMany({
        where: { userId: actor.id },
        data: { hideLocked: hide }
    });
    if (updated.count === 0) throw new ChatAccessError({ key: "errors.lockNoCode" });
    publishChatChange({ kind: "channels", actorId: actor.id, audience: [actor.id] });
}

/** Lock or unlock one conversation. Locking needs a code to exist; unlocking
 *  needs the code, since it is what takes the guard away. */
export async function setChannelLocked(
    actor: ChatActor,
    channelId: string,
    locked: boolean,
    code?: string
): Promise<void> {
    await requireChannel(actor, channelId);
    const state = await lockState(actor.id);
    if (!state.hasCode) throw new ChatAccessError({ key: "errors.lockNoCode" });
    if (!locked && !(code && (await verifyLockCode(actor, code))))
        throw new ChatAccessError({ key: "errors.lockWrongCode" });
    await prisma.chatChannelMember.upsert({
        where: { channelId_userId: { channelId, userId: actor.id } },
        update: { locked },
        create: { channelId, userId: actor.id, locked }
    });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
}

export async function setChannelHidden(
    actor: ChatActor,
    channelId: string,
    hidden: boolean
): Promise<void> {
    await requireChannel(actor, channelId);
    const hiddenAt = hidden ? new Date() : null;
    await prisma.chatChannelMember.upsert({
        where: { channelId_userId: { channelId, userId: actor.id } },
        update: { hiddenAt },
        create: { channelId, userId: actor.id, hiddenAt }
    });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
}

/**
 * Which memberships a new message brings back into the list: hidden ones in
 * this conversation, other than the author's, whose mute is not in force.
 */
export function unhideWhere(
    channelId: string,
    authorId: string | null,
    now: Date
): Prisma.ChatChannelMemberWhereInput {
    return {
        channelId,
        hiddenAt: { not: null },
        ...(authorId ? { userId: { not: authorId } } : {}),
        OR: [{ muted: false }, { mutedUntil: { lte: now } }]
    };
}

/** Apply the archive rule after a message lands. */
export async function unhideOnMessage(
    db: Pick<Prisma.TransactionClient, "chatChannelMember">,
    channelId: string,
    authorId: string | null,
    now = new Date()
): Promise<void> {
    await db.chatChannelMember.updateMany({
        where: unhideWhere(channelId, authorId, now),
        data: { hiddenAt: null }
    });
}

/** How long an unlock proof answers when nothing says otherwise. */
const PROOF_TTL_MS = timing.proofTtlMs(timing.DEFAULT_UNLOCK_MINUTES);

/** At most this many proofs renewed in one request: more than anybody locks. */
export const RENEW_MAX = 500;

export const renewSchema = z.object({
    proofs: z
        .record(z.string().uuid(), z.string().max(200))
        .refine((proofs) => Object.keys(proofs).length <= RENEW_MAX)
});

export const unlockSchema = z.object({
    channelId: z.string().uuid(),
    code: lockCodeSchema
});

function signProof(userId: string, channelId: string, codeHash: string, expires: string): string {
    return createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET)
        .update(`chat-lock:${userId}:${channelId}:${expires}:${codeHash}`)
        .digest("base64url");
}

/** The reader's stored code hash, which every proof is bound to: a new code
 *  turns every proof handed out under the old one away. */
export async function lockCodeHash(userId: string): Promise<string | null> {
    return (await proofTerms(userId))?.codeHash ?? null;
}

/** What a proof is minted under: the code it is bound to and how long it lasts. */
async function proofTerms(userId: string): Promise<{ codeHash: string; ttlMs: number } | null> {
    const row = await prisma.chatLock.findUnique({
        where: { userId },
        select: { codeHash: true, unlockMinutes: true }
    });
    return row ? { codeHash: row.codeHash, ttlMs: timing.proofTtlMs(row.unlockMinutes) } : null;
}

/** A proof that this reader opened this conversation with their code. */
export function unlockProof(
    userId: string,
    channelId: string,
    codeHash: string,
    now = Date.now(),
    ttlMs = PROOF_TTL_MS
): string {
    const expires = String(now + ttlMs);
    return `${expires}.${signProof(userId, channelId, codeHash, expires)}`;
}

/** Whether a proof was minted for exactly this reader and conversation, under
 *  the code they have now, and is still good. */
export function readUnlockProof(
    proof: string | null | undefined,
    userId: string,
    channelId: string,
    codeHash: string | null,
    now = Date.now()
): boolean {
    if (!proof || !codeHash) return false;
    const [expires, signature] = proof.split(".");
    if (!expires || !signature || !/^\d{10,16}$/.test(expires)) return false;
    if (Number(expires) < now) return false;
    const expected = Buffer.from(signProof(userId, channelId, codeHash, expires), "utf8");
    const given = Buffer.from(signature, "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Refuse a locked conversation's messages to a reader without a fresh proof. */
export async function requireUnlocked(
    actor: ChatActor,
    channelId: string,
    proof?: string | null
): Promise<void> {
    const row = await prisma.chatChannelMember.findUnique({
        where: { channelId_userId: { channelId, userId: actor.id } },
        select: { locked: true }
    });
    if (!row?.locked) return;
    if (!readUnlockProof(proof, actor.id, channelId, await lockCodeHash(actor.id)))
        throw new ChatAccessError({ key: "errors.lockRequired" });
}

/** Open one locked conversation with the code: the proof for it, or a refusal. */
export async function unlockChannel(
    actor: ChatActor,
    channelId: string,
    code: string
): Promise<string> {
    await requireChannel(actor, channelId);
    if (!(await verifyLockCode(actor, code)))
        throw new ChatAccessError({ key: "errors.lockWrongCode" });
    const terms = await proofTerms(actor.id);
    if (!terms) throw new ChatAccessError({ key: "errors.lockNoCode" });
    return unlockProof(actor.id, channelId, terms.codeHash, Date.now(), terms.ttlMs);
}

/** Open the "Locked chats" list with the code: a proof for each of them, so
 *  opening one from there does not ask a second time. */
export async function unlockAll(actor: ChatActor, code: string): Promise<Record<string, string>> {
    if (!(await verifyLockCode(actor, code)))
        throw new ChatAccessError({ key: "errors.lockWrongCode" });
    const [rows, terms] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: { userId: actor.id, locked: true },
            select: { channelId: true }
        }),
        proofTerms(actor.id)
    ]);
    if (!terms) throw new ChatAccessError({ key: "errors.lockNoCode" });
    const now = Date.now();
    return Object.fromEntries(
        rows.map((row) => [
            row.channelId,
            unlockProof(actor.id, row.channelId, terms.codeHash, now, terms.ttlMs)
        ])
    );
}

/**
 * Push on the proofs the tab already holds, because the reader is using the
 * open locked chat: the window slides instead of running out mid-conversation.
 * Only a proof that still answers is renewed - an expired or forged one is left
 * out, and the code is asked for again - and no code is needed, since the proof
 * is the evidence the code was given.
 */
export function renewProofs(
    userId: string,
    proofs: Readonly<Record<string, string>>,
    terms: { codeHash: string; ttlMs: number },
    now = Date.now()
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(proofs)
            .filter(([channelId, proof]) =>
                readUnlockProof(proof, userId, channelId, terms.codeHash, now)
            )
            .map(([channelId]) => [
                channelId,
                unlockProof(userId, channelId, terms.codeHash, now, terms.ttlMs)
            ])
    );
}

export async function renewUnlocks(
    actor: ChatActor,
    proofs: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
    const terms = await proofTerms(actor.id);
    return terms ? renewProofs(actor.id, proofs, terms) : {};
}

/** What an alert about a locked conversation may say: that something arrived,
 *  and nothing about what or from whom. */
export function redactAlert<
    T extends {
        readonly conversation: string;
        readonly authorId: string | null;
        readonly authorName: string;
        readonly excerpt: string;
        readonly media: unknown;
    }
>(alert: T): T & { readonly locked: true } {
    return {
        ...alert,
        conversation: "",
        authorId: null,
        authorName: "",
        excerpt: "",
        media: null,
        locked: true
    };
}

/** Who among these readers keeps this one conversation behind their code. */
export async function lockedFor(
    channelId: string,
    userIds: readonly string[]
): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await prisma.chatChannelMember.findMany({
        where: { channelId, locked: true, userId: { in: [...userIds] } },
        select: { userId: true }
    });
    return new Set(rows.map((row) => row.userId));
}

/** The conversations this reader hid, and the ones behind their code - what a
 *  list that reaches across conversations has to know to leave them out. */
export interface ChatConcealed {
    readonly hidden: ReadonlySet<string>;
    readonly locked: ReadonlySet<string>;
    readonly hideLocked: boolean;
}

export async function concealedFor(userId: string): Promise<ChatConcealed> {
    return concealedFrom(
        userId,
        await prisma.chatChannelMember.findMany({
            where: { userId, OR: [{ locked: true }, { hiddenAt: { not: null } }] },
            select: { channelId: true, locked: true, hiddenAt: true }
        })
    );
}

/** The same, from memberships a caller already read with both marks. */
export async function concealedFrom(
    userId: string,
    rows: readonly { channelId: string; locked?: boolean; hiddenAt?: Date | null }[]
): Promise<ChatConcealed> {
    const hidden = new Set(rows.filter((row) => Boolean(row.hiddenAt)).map((row) => row.channelId));
    const locked = new Set(rows.filter((row) => row.locked === true).map((row) => row.channelId));
    // The setting is only worth a read when something is locked.
    const hideLocked = locked.size > 0 ? (await lockState(userId)).hideLocked : false;
    return { hidden, locked, hideLocked };
}

/** Whether a conversation is on the reader's usual list - the sidebar's rule
 *  (`onShelf`), for the lists that are not the sidebar. */
export function listedFor(concealed: ChatConcealed, channelId: string): boolean {
    return onShelf(
        { locked: concealed.locked.has(channelId), hidden: concealed.hidden.has(channelId) },
        "all",
        concealed.hideLocked
    );
}
