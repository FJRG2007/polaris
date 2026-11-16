/**
 * Disappearing messages, delete for me, and deleting a whole chat, for direct
 * conversations (a 1:1 or a group outside any space).
 *
 * The rules themselves are pure (`vanish-rules`); this is the part with a
 * database. Every write checks membership here, whatever the screen offered:
 * the screen reads `directRulesFor`, which asks the same questions.
 *
 * A message that has disappeared is never served - every reader filters on
 * `expiresAt` through `history-visibility` - and is then deleted for real by
 * `sweepExpiredMessages`, with its files, reactions, replies, pins and
 * everything else that hangs off the row.
 */

import { prisma } from "@polaris/db";
import * as rules from "./vanish-rules";
import { publishChatChange } from "./live";
import { postNoticeBody } from "./notices";
import { noticeMention } from "./notice-text";
import * as history from "./history-visibility";
import { discardAttachments } from "./attachments";
import { rateLimit } from "@/lib/rate-limit-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { ChatAccessError, ChatRuleError, requireChannel, type ChatActor } from "./access";

const MODE_KEY = "chat.dmRules";
const LINE_KEY = "chat.deleteChatLine";

/** How the instance decides direct-message rules. Open unless an
 *  administrator chose otherwise: no row is the default. */
export async function dmRuleMode(): Promise<rules.DmRuleMode> {
    return (await getSetting(MODE_KEY)) === "agreement" ? "agreement" : "open";
}

export async function setDmRuleMode(mode: rules.DmRuleMode): Promise<void> {
    await setSetting(MODE_KEY, mode === "agreement" ? "agreement" : null);
}

/** Whether deleting a chat for everybody leaves a line saying who did. On
 *  unless an administrator turned it off. */
export async function deleteChatLineShown(): Promise<boolean> {
    return (await getSetting(LINE_KEY)) !== "off";
}

export async function setDeleteChatLineShown(shown: boolean): Promise<void> {
    await setSetting(LINE_KEY, shown ? null : "off");
}

/** A proposal as its conversation shows it. */
export interface RuleProposalView {
    readonly id: string;
    readonly proposedById: string;
    readonly vanishAfter: number;
    readonly deleteForAll: boolean;
    /** Whether this reader may accept or decline it. */
    readonly mayAnswer: boolean;
    /** Whether this reader proposed it, and so may withdraw it by proposing
     *  again or wait. */
    readonly mine: boolean;
}

/** What a conversation's screen needs to draw and offer the rules. */
export interface DirectRulesView {
    readonly mode: rules.DmRuleMode;
    readonly vanishAfter: number;
    /** Whether "also delete for everybody" may be used here now. */
    readonly deleteForAll: boolean;
    /** Whether the members have agreed rules (agreement mode only). */
    readonly agreed: boolean;
    readonly proposal: RuleProposalView | null;
}

interface DirectChannel {
    readonly id: string;
    readonly kind: string;
    readonly spaceId: string | null;
    readonly vanishAfter: number;
    readonly deleteForAll: boolean;
    readonly rulesAgreedAt: Date | null;
}

const CHANNEL_SELECT = {
    id: true,
    kind: true,
    spaceId: true,
    vanishAfter: true,
    deleteForAll: true,
    rulesAgreedAt: true
} as const;

/** The conversation, refused unless the reader is one of its members and it
 *  has direct rules at all. */
async function requireDirect(actor: ChatActor, channelId: string): Promise<DirectChannel> {
    const access = await requireChannel(actor, channelId);
    if (!access.member) throw new ChatAccessError();
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: CHANNEL_SELECT
    });
    if (!channel || !rules.hasDirectRules(channel)) {
        throw new ChatRuleError({ key: "errors.vanishNotHere" });
    }
    return channel;
}

async function memberIds(channelId: string): Promise<string[]> {
    const rows = await prisma.chatChannelMember.findMany({
        where: { channelId },
        select: { userId: true },
        // A group has a ceiling well under this; it is here so the read is bounded.
        take: 1000
    });
    return rows.map((row) => row.userId);
}

async function requireNotTooFast(actor: ChatActor): Promise<void> {
    const allowed = await rateLimit(`chat-rules:${actor.id}`, 20, 10 * 60_000);
    if (!allowed.ok) throw new ChatRuleError({ key: "errors.vanishTooFast" });
}

async function mentionOf(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return noticeMention({ id: userId, name: user?.name ?? "Somebody" });
}

/** When a message sent now into this conversation disappears, or null. */
export async function expiryForChannel(channelId: string, sentAt: Date): Promise<Date | null> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: CHANNEL_SELECT
    });
    if (!channel || !rules.hasDirectRules(channel) || channel.vanishAfter === 0) return null;
    const current = rules.effectiveRules(await dmRuleMode(), channel);
    return rules.expiryFor(sentAt, current.vanishAfter);
}

/** The rules of one conversation as this reader sees them, or null where the
 *  conversation has none (a space's channel). */
export async function directRulesFor(
    actor: ChatActor,
    channelId: string
): Promise<DirectRulesView | null> {
    const access = await requireChannel(actor, channelId);
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: {
            ...CHANNEL_SELECT,
            ruleProposals: {
                where: { status: "pending" },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                    id: true,
                    proposedById: true,
                    vanishAfter: true,
                    deleteForAll: true,
                    acceptedBy: true,
                    status: true
                }
            }
        }
    });
    if (!channel || !rules.hasDirectRules(channel) || !access.member) return null;
    const mode = await dmRuleMode();
    const current = rules.effectiveRules(mode, channel);
    const pending = mode === "agreement" ? (channel.ruleProposals[0] ?? null) : null;
    const members = pending ? await memberIds(channelId) : [];
    return {
        mode,
        vanishAfter: current.vanishAfter,
        deleteForAll: current.deleteForAll,
        agreed: channel.rulesAgreedAt !== null,
        proposal: pending
            ? {
                  id: pending.id,
                  proposedById: pending.proposedById,
                  vanishAfter: pending.vanishAfter,
                  deleteForAll: pending.deleteForAll,
                  mayAnswer: rules.mayAnswerProposal(pending, actor.id, members),
                  mine: pending.proposedById.toLowerCase() === actor.id.toLowerCase()
              }
            : null
    };
}

/**
 * Change the timer, in the open mode. In the agreement mode this is a proposal
 * instead, keeping the agreed delete rule as it is.
 */
export async function setVanishTimer(
    actor: ChatActor,
    channelId: string,
    seconds: number
): Promise<void> {
    if (!rules.isVanishDuration(seconds)) throw new ChatRuleError({ key: "errors.vanishBadDuration" });
    const channel = await requireDirect(actor, channelId);
    const mode = await dmRuleMode();
    if (mode === "agreement") {
        const current = rules.effectiveRules(mode, channel);
        await proposeRules(actor, channelId, {
            vanishAfter: seconds,
            deleteForAll: current.deleteForAll
        });
        return;
    }
    await requireNotTooFast(actor);
    if (rules.effectiveRules(mode, channel).vanishAfter === seconds) return;
    await prisma.chatChannel.update({
        where: { id: channelId },
        // A change nobody agreed to is not an agreement: the agreement mode, if
        // the instance goes back to it, starts this conversation over.
        data: { vanishAfter: seconds, rulesAgreedAt: null }
    });
    await postNoticeBody(channelId, timerLine(await mentionOf(actor.id), seconds), actor.id);
}

function timerLine(who: string, seconds: number): string {
    return seconds === 0
        ? `${who} turned off disappearing messages`
        : `${who} set messages to disappear after ${rules.spokenVanish(seconds)}`;
}

/** Propose new rules, in the agreement mode. Replaces a proposal still
 *  waiting; the one proposing has accepted it by proposing. */
export async function proposeRules(
    actor: ChatActor,
    channelId: string,
    proposed: { readonly vanishAfter: number; readonly deleteForAll: boolean }
): Promise<void> {
    if (!rules.isVanishDuration(proposed.vanishAfter)) {
        throw new ChatRuleError({ key: "errors.vanishBadDuration" });
    }
    await requireDirect(actor, channelId);
    if ((await dmRuleMode()) !== "agreement") {
        throw new ChatRuleError({ key: "errors.vanishNoAgreement" });
    }
    await requireNotTooFast(actor);
    await prisma.$transaction([
        prisma.chatRuleProposal.updateMany({
            where: { channelId, status: "pending" },
            data: { status: "replaced", decidedAt: new Date() }
        }),
        prisma.chatRuleProposal.create({
            data: {
                channelId,
                proposedById: actor.id,
                vanishAfter: proposed.vanishAfter,
                deleteForAll: proposed.deleteForAll,
                acceptedBy: [actor.id]
            }
        })
    ]);
    const who = await mentionOf(actor.id);
    const timer =
        proposed.vanishAfter === 0
            ? "no disappearing messages"
            : `messages that disappear after ${rules.spokenVanish(proposed.vanishAfter)}`;
    const deletion = proposed.deleteForAll
        ? "deleting the chat for everybody allowed"
        : "deleting the chat for everybody off";
    await postNoticeBody(channelId, `${who} proposed ${timer}, with ${deletion}`, actor.id);
}

/** Accept or decline a proposal. Only another member who has not accepted it
 *  yet may; once every member has, it becomes the conversation's rules. */
export async function answerProposal(
    actor: ChatActor,
    proposalId: string,
    accept: boolean
): Promise<void> {
    const proposal = await prisma.chatRuleProposal.findUnique({
        where: { id: proposalId },
        select: {
            id: true,
            channelId: true,
            status: true,
            acceptedBy: true,
            vanishAfter: true,
            deleteForAll: true
        }
    });
    if (!proposal) throw new ChatRuleError({ key: "errors.proposalGone" });
    await requireDirect(actor, proposal.channelId);
    if ((await dmRuleMode()) !== "agreement" || proposal.status !== "pending") {
        throw new ChatRuleError({ key: "errors.proposalGone" });
    }
    const members = await memberIds(proposal.channelId);
    if (!rules.mayAnswerProposal(proposal, actor.id, members)) {
        throw new ChatRuleError({ key: "errors.proposalNotYours" });
    }
    await requireNotTooFast(actor);
    const who = await mentionOf(actor.id);
    if (!accept) {
        const declined = await prisma.chatRuleProposal.updateMany({
            where: { id: proposal.id, status: "pending" },
            data: { status: "declined", decidedAt: new Date() }
        });
        if (declined.count === 0) throw new ChatRuleError({ key: "errors.proposalGone" });
        await postNoticeBody(proposal.channelId, `${who} declined the proposed chat rules`, actor.id);
        return;
    }
    const acceptedBy = [...proposal.acceptedBy, actor.id];
    const done = rules.proposalAccepted(acceptedBy, members);
    const now = new Date();
    const settled = await prisma.$transaction(async (tx) => {
        const moved = await tx.chatRuleProposal.updateMany({
            where: { id: proposal.id, status: "pending" },
            data: { acceptedBy, ...(done ? { status: "accepted", decidedAt: now } : {}) }
        });
        if (moved.count === 0) return false;
        if (done) {
            await tx.chatChannel.update({
                where: { id: proposal.channelId },
                data: {
                    vanishAfter: proposal.vanishAfter,
                    deleteForAll: proposal.deleteForAll,
                    rulesAgreedAt: now
                }
            });
        }
        return true;
    });
    if (!settled) throw new ChatRuleError({ key: "errors.proposalGone" });
    await postNoticeBody(
        proposal.channelId,
        done
            ? `${who} accepted the chat rules: ${
                  proposal.vanishAfter === 0
                      ? "messages no longer disappear"
                      : `messages disappear after ${rules.spokenVanish(proposal.vanishAfter)}`
              }`
            : `${who} accepted the proposed chat rules`,
        actor.id
    );
}

/** Delete one message for this reader only. Anybody's, mine or not. */
export async function hideMessage(actor: ChatActor, messageId: string): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, parentId: true }
    });
    if (!message) return;
    await requireChannel(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, messageId);
    await prisma.chatMessageHidden.createMany({
        data: [{ messageId, userId: actor.id }],
        skipDuplicates: true
    });
    // Their other screens take it out; nobody else's are told anything.
    publishChatChange({
        channelId: message.channelId,
        kind: "posted",
        actorId: actor.id,
        audience: [actor.id],
        messageIds: message.parentId ? [messageId, message.parentId] : [messageId]
    });
}

/** Delete the chat for this reader only: what was said before now is gone for
 *  them, and the conversation leaves their list until something new arrives. */
export async function clearChatForMe(actor: ChatActor, channelId: string): Promise<void> {
    await requireDirect(actor, channelId);
    const now = new Date();
    const cleared = await prisma.chatChannelMember.updateMany({
        where: { channelId, userId: actor.id },
        data: { clearedAt: now, hiddenAt: now }
    });
    if (cleared.count === 0) throw new ChatAccessError();
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
}

/**
 * Delete the chat for everybody in it: every message of every member. They are
 * marked expired at once - so no reader is served one from this moment - and
 * the sweep deletes them in bounded batches. A line says who did it, unless
 * the instance turned that line off.
 */
export async function deleteChatForAll(actor: ChatActor, channelId: string): Promise<void> {
    const channel = await requireDirect(actor, channelId);
    const mode = await dmRuleMode();
    if (!rules.effectiveRules(mode, channel).deleteForAll) {
        throw new ChatRuleError({ key: "errors.deleteForAllOff" });
    }
    await requireNotTooFast(actor);
    const now = new Date();
    await prisma.chatMessage.updateMany({
        where: { channelId, AND: [history.notExpiredClause(now)] },
        data: { expiresAt: now }
    });
    if (await deleteChatLineShown()) {
        await postNoticeBody(channelId, `${await mentionOf(actor.id)} deleted the chat`, actor.id);
    } else {
        publishChatChange({ channelId, kind: "posted", actorId: actor.id });
    }
    void sweepExpiredMessages().catch((error: unknown) =>
        console.error("[chat] could not sweep a deleted chat:", error)
    );
}

/** The timer a new direct message starts with: its starter's default, in the
 *  open mode. In the agreement mode it is proposed instead. Never throws. */
export async function applyDefaultTimer(actor: ChatActor, channelId: string): Promise<void> {
    try {
        const privacy = await prisma.userPrivacy.findUnique({
            where: { userId: actor.id },
            select: { chatVanishAfter: true }
        });
        const seconds = privacy?.chatVanishAfter ?? 0;
        if (seconds === 0 || !rules.isVanishDuration(seconds)) return;
        await setVanishTimer(actor, channelId, seconds);
    } catch (error) {
        // The conversation stands either way; the default can be set by hand.
        console.error("[chat] could not apply the default disappearing timer:", error);
    }
}

/**
 * Delete every message past its expiry, for real: the row, its files in
 * storage, and through the cascade its reactions, thread replies, poll, stars,
 * reminders, flags, edits and hidden marks. Quotes of it fall back to saying
 * the original is gone. Bounded: `batchSize` rows a round, `maxBatches` rounds
 * a run; whatever is left is the next run's.
 *
 * @returns How many messages were deleted.
 */
export async function sweepExpiredMessages(
    now: Date = new Date(),
    batchSize = 200,
    maxBatches = 10
): Promise<number> {
    let removed = 0;
    for (let round = 0; round < maxBatches; round += 1) {
        const due = await prisma.chatMessage.findMany({
            where: { expiresAt: { lte: now } },
            orderBy: { expiresAt: "asc" },
            take: batchSize,
            select: { id: true, channelId: true, parentId: true }
        });
        if (due.length === 0) break;
        const ids = due.map((row) => row.id);
        const doomed = new Set(ids);

        // Replies go with their root by cascade, so their files are discarded
        // here first: a row deleted before its file leaves a file nothing finds.
        const replies = await prisma.chatMessage.findMany({
            where: { parentId: { in: ids } },
            select: { id: true },
            take: batchSize * 50
        });
        const withFiles = await prisma.chatAttachment.findMany({
            where: { messageId: { in: [...ids, ...replies.map((row) => row.id)] } },
            select: { messageId: true },
            distinct: ["messageId"]
        });
        for (const row of withFiles) await discardAttachments(row.messageId);

        // A reply whose root stays takes one off the root's count.
        const roots = new Map<string, number>();
        for (const row of due) {
            if (row.parentId && !doomed.has(row.parentId)) {
                roots.set(row.parentId, (roots.get(row.parentId) ?? 0) + 1);
            }
        }
        await prisma.$transaction(async (tx) => {
            await tx.chatMessage.deleteMany({ where: { id: { in: ids } } });
            for (const [rootId, count] of roots) {
                await tx.chatMessage.updateMany({
                    where: { id: rootId, replyCount: { gte: count } },
                    data: { replyCount: { decrement: count } }
                });
            }
        });
        removed += due.length;

        const byChannel = new Map<string, string[]>();
        for (const row of due) {
            const list = byChannel.get(row.channelId) ?? [];
            list.push(row.id);
            if (row.parentId) list.push(row.parentId);
            byChannel.set(row.channelId, list);
        }
        for (const [channelId, messageIds] of byChannel) {
            publishChatChange({ channelId, kind: "posted", actorId: "", messageIds });
        }
        if (due.length < batchSize) break;
    }
    return removed;
}
