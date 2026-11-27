/**
 * Which conversations are end-to-end encrypted (docs/chat-e2ee-mls.md,
 * "Encryption policy"), and how many people a sealed one holds.
 *
 * Direct messages, groups, private channels and the channels of a space you
 * join by invitation are sealed. A public channel - one in a space everybody
 * on the instance (or the organization) reaches without an invitation or an
 * approval - is not: it stays encrypted in transit and at rest, and the server
 * keeps moderating and searching it. Discord, Slack and Matrix's public rooms
 * draw the same line; Matrix turns encryption on by default for private rooms
 * only.
 *
 * That public mode is built but held behind `PUBLIC_CHANNELS_OPEN` until the
 * owner confirms it: with it off, every conversation is what it was before -
 * sealed whenever sealed chat is - and the sweep changes nothing.
 *
 * Server-only.
 */

import { prisma, type Prisma } from "@polaris/db";
import { ChatAccessError } from "@/lib/chat/access";
import { sealedChatServed } from "./flag";
import { encryptionModeOf, seatsAfter, PUBLIC_CHANNELS_OPEN, SEALED_MEMBER_CAP, SEALED_WARN_AT, type EncryptionMode } from "./encryption-mode";
import { postNoticeBody, spaceNoticeChannel } from "@/lib/chat/notices";

/** The Prisma filter for the open conversations (`encryptionModeOf`), for the passes that skip them. */
export function openChannelWhere(publicOpen: boolean = PUBLIC_CHANNELS_OPEN): Prisma.ChatChannelWhereInput | null {
    if (!publicOpen) return null;
    return { kind: { notIn: ["dm", "group"] }, private: false, space: { visibility: "internal" } };
}

const RULE_SELECT = { kind: true, private: true, e2eeMode: true, space: { select: { visibility: true } } } as const;

/** A conversation's mode now; sealed for one that does not exist, which refuses nothing it would not. */
export async function channelEncryptionMode(channelId: string): Promise<EncryptionMode> {
    if (!PUBLIC_CHANNELS_OPEN) return "sealed";
    const channel = await prisma.chatChannel.findUnique({ where: { id: channelId }, select: RULE_SELECT });
    if (!channel) return "sealed";
    return encryptionModeOf({ kind: channel.kind, private: channel.private, spaceVisibility: channel.space?.visibility ?? null });
}

/** The line a conversation shows when it stops sealing new messages. Stored English, as every notice is. */
export const STOPPED_SEALING_NOTICE =
    "This channel is now public. New messages are not end-to-end encrypted; earlier encrypted messages stay encrypted.";
/** The line a conversation shows when it starts sealing again. */
export const STARTED_SEALING_NOTICE = "This channel is now private. New messages are end-to-end encrypted.";

/**
 * Bring these conversations' recorded mode in line with their join rule, and
 * say so in each one that changed after it was first decided. A conversation
 * that stops sealing keeps every sealed message sealed (its MLS group and
 * history keys stay); only what is sent from then on goes in the clear. The
 * first decision for a conversation (`e2eeMode` null) writes a line only when
 * it already holds sealed history and is now open.
 */
export async function applyEncryptionModes(channelIds: readonly string[], actorId: string | null = null): Promise<number> {
    if (!PUBLIC_CHANNELS_OPEN || !channelIds.length) return 0;
    const channels = await prisma.chatChannel.findMany({ where: { id: { in: [...new Set(channelIds)] } }, select: { id: true, ...RULE_SELECT } });
    let changed = 0;
    for (const channel of channels) {
        const mode = encryptionModeOf({ kind: channel.kind, private: channel.private, spaceVisibility: channel.space?.visibility ?? null });
        if (channel.e2eeMode === mode) continue;
        // Guarded on the value read, so two passes racing write one line between them.
        const moved = await prisma.chatChannel.updateMany({ where: { id: channel.id, e2eeMode: channel.e2eeMode }, data: { e2eeMode: mode } });
        if (!moved.count) continue;
        changed++;
        const hadSealed = channel.e2eeMode === "sealed" || (await sealedHistory(channel.id));
        if (mode === "open" && hadSealed) await postNoticeBody(channel.id, STOPPED_SEALING_NOTICE, actorId ?? "system");
        if (mode === "sealed" && channel.e2eeMode === "open") await postNoticeBody(channel.id, STARTED_SEALING_NOTICE, actorId ?? "system");
    }
    return changed;
}

async function sealedHistory(channelId: string): Promise<boolean> {
    const [group, cut] = await Promise.all([
        prisma.mlsGroup.count({ where: { channelId }, take: 1 }),
        prisma.chatMigration.count({ where: { channelId, state: "cut" }, take: 1 })
    ]);
    return group + cut > 0;
}

/**
 * The once-per-server pass: every conversation not decided yet gets its mode
 * from its current join rule. Each is decided once (`e2eeMode` set), so it is
 * cheap to run on every boot; a no-op while the public mode is held.
 */
export async function sweepEncryptionModes(page = 200): Promise<number> {
    if (!PUBLIC_CHANNELS_OPEN) return 0;
    let decided = 0;
    let after: string | null = null;
    for (;;) {
        const rows: { id: string }[] = await prisma.chatChannel.findMany({
            where: { e2eeMode: null, ...(after ? { id: { gt: after } } : {}) },
            select: { id: true },
            orderBy: { id: "asc" },
            take: page
        });
        if (!rows.length) return decided;
        decided += await applyEncryptionModes(rows.map((row) => row.id));
        after = rows[rows.length - 1]!.id;
    }
}

/** Where a join lands: one conversation, or a space whose sealed channels everybody in it reads. */
export type SeatTarget = { readonly channelId: string } | { readonly spaceId: string };

/**
 * How many people the conversation (or the space's sealed channels) hold now,
 * or null when what they join is not sealed and has no cap. A private channel
 * and a group are their member rows; a space's open-to-the-space channels are
 * read by its members and its owner.
 */
export async function sealedHeadcount(target: SeatTarget): Promise<number | null> {
    if ("channelId" in target) {
        const channel = await prisma.chatChannel.findUnique({ where: { id: target.channelId }, select: { ...RULE_SELECT, spaceId: true } });
        if (!channel) return null;
        if (encryptionModeOf({ kind: channel.kind, private: channel.private, spaceVisibility: channel.space?.visibility ?? null }) === "open") return null;
        // A channel open to its space is counted by the space's people.
        if (channel.spaceId && !channel.private) return sealedHeadcount({ spaceId: channel.spaceId });
        return prisma.chatChannelMember.count({ where: { channelId: target.channelId } });
    }
    const space = await prisma.chatSpace.findUnique({ where: { id: target.spaceId }, select: { visibility: true } });
    if (!space) return null;
    if (encryptionModeOf({ kind: "text", private: false, spaceVisibility: space.visibility }) === "open") return null;
    return (await prisma.chatSpaceMember.count({ where: { spaceId: target.spaceId } })) + 1;
}

/**
 * Refuse a join that would take a sealed conversation past `SEALED_MEMBER_CAP`,
 * in a sentence the person who asked reads, before anything is written. Never
 * a silent stop: the join is refused whole, and the conversation keeps sealing.
 * Answers whether the join crosses the warning line, for `warnFillingUp`.
 */
export async function refuseSealedPastCap(target: SeatTarget, adding: number): Promise<boolean> {
    // Nothing is sealed while sealed chat is off, so nothing is capped either.
    if (adding <= 0 || !sealedChatServed()) return false;
    const current = await sealedHeadcount(target);
    if (current === null) return false;
    const seats = seatsAfter(current, adding);
    if (seats.refused) {
        throw new ChatAccessError({
            key: "errors.sealedGroupFull",
            params: { cap: SEALED_MEMBER_CAP }
        });
    }
    return seats.warn;
}

/** The line written once a sealed conversation reaches the warning line, for whoever runs it to see. */
export const FILLING_UP_NOTICE = `This private conversation has reached ${SEALED_WARN_AT.toLocaleString("en-US")} of the ${SEALED_MEMBER_CAP.toLocaleString("en-US")} people an end-to-end encrypted conversation holds. Once it is full, nobody new can join until someone leaves.`;

/** Write the warning line where the conversation (or the space) is read. */
export async function warnFillingUp(target: SeatTarget, actorId: string): Promise<void> {
    if ("channelId" in target) return postNoticeBody(target.channelId, FILLING_UP_NOTICE, actorId);
    const channelId = await spaceNoticeChannel(target.spaceId);
    if (channelId) await postNoticeBody(channelId, FILLING_UP_NOTICE, actorId);
}
