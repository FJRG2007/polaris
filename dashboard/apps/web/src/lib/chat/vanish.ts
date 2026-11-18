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
/** What a new conversation starts with, as the administrator chose. No row is
 *  "follow" for receipts and typing, and the starter's own default timer. */
const START_RECEIPTS_KEY = "chat.defaults.receipts";
const START_TYPING_KEY = "chat.defaults.typing";
const START_TIMER_KEY = "chat.defaults.vanishAfter";

/** How the instance decides direct-message rules. Open unless an
 *  administrator chose otherwise: no row is the default. */
export async function dmRuleMode(): Promise<rules.DmRuleMode> {
    return (await getSetting(MODE_KEY)) === "agreement" ? "agreement" : "open";
}

export async function setDmRuleMode(mode: rules.DmRuleMode): Promise<void> {
    await setSetting(MODE_KEY, mode === "agreement" ? "agreement" : null);
    // A proposal belongs to the mode it was made in. Left pending, it would
    // come back answerable the day the instance returns to agreement, about
    // rules nobody is discussing any more.
    if (mode === "open") await withdrawProposals({});
}

/** The rules a new conversation starts with. `vanishAfter` null is the
 *  starter's own default timer, which is how every chat began before an
 *  administrator could choose. */
export interface StartingRules {
    readonly receipts: rules.ChatPrivacyRule;
    readonly typing: rules.ChatPrivacyRule;
    readonly vanishAfter: number | null;
}

export async function startingRules(): Promise<StartingRules> {
    const [receipts, typing, timer] = await Promise.all([
        getSetting(START_RECEIPTS_KEY),
        getSetting(START_TYPING_KEY),
        getSetting(START_TIMER_KEY)
    ]);
    const seconds = timer === null ? null : Number(timer);
    return {
        receipts: rules.chatPrivacyRule(receipts),
        typing: rules.chatPrivacyRule(typing),
        vanishAfter: seconds !== null && rules.isVanishDuration(seconds) ? seconds : null
    };
}

/** Store the administrator's starting rules. A default value removes its row. */
export async function setStartingRules(next: Partial<StartingRules>): Promise<void> {
    if (next.receipts !== undefined) {
        await setSetting(START_RECEIPTS_KEY, next.receipts === "follow" ? null : next.receipts);
    }
    if (next.typing !== undefined) {
        await setSetting(START_TYPING_KEY, next.typing === "follow" ? null : next.typing);
    }
    if (next.vanishAfter !== undefined) {
        const seconds = next.vanishAfter;
        await setSetting(
            START_TIMER_KEY,
            seconds !== null && rules.isVanishDuration(seconds) ? String(seconds) : null
        );
    }
}

/** Close every proposal still waiting, in one conversation or everywhere. */
async function withdrawProposals(where: { channelId?: string }): Promise<void> {
    await prisma.chatRuleProposal.updateMany({
        where: { ...where, status: "pending" },
        data: { status: "withdrawn", decidedAt: new Date() }
    });
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
    readonly receipts: rules.ChatPrivacyRule;
    readonly typing: rules.ChatPrivacyRule;
    /** Whether this reader may accept or decline it. */
    readonly mayAnswer: boolean;
    /** Whether this reader proposed it, and so may withdraw it. */
    readonly mine: boolean;
}

/** What a conversation's screen needs to draw and offer the rules. */
export interface DirectRulesView {
    readonly mode: rules.DmRuleMode;
    /** "dm" or "group": a group's rules are changed by its admins only, and
     *  never proposed. */
    readonly kind: string;
    readonly vanishAfter: number;
    /** Whether "also delete for everybody" may be used here now. */
    readonly deleteForAll: boolean;
    readonly receipts: rules.ChatPrivacyRule;
    readonly typing: rules.ChatPrivacyRule;
    /** Whether the members have agreed rules (agreement mode only). */
    readonly agreed: boolean;
    /** Whether this reader may change the rules - the same question every
     *  write asks. False only in a group, for somebody who does not run it. */
    readonly mayChange: boolean;
    /** Whether a change this reader makes waits for the other person. */
    readonly proposes: boolean;
    readonly proposal: RuleProposalView | null;
}

interface DirectChannel {
    readonly id: string;
    readonly kind: string;
    readonly spaceId: string | null;
    readonly ownerId: string | null;
    readonly createdById: string | null;
    readonly vanishAfter: number;
    readonly deleteForAll: boolean;
    readonly rulesAgreedAt: Date | null;
    readonly receipts: string;
    readonly typing: string;
}

const CHANNEL_SELECT = {
    id: true,
    kind: true,
    spaceId: true,
    ownerId: true,
    createdById: true,
    vanishAfter: true,
    deleteForAll: true,
    rulesAgreedAt: true,
    receipts: true,
    typing: true
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

/** This reader's role in a group, which only a group asks for. */
async function roleIn(channel: DirectChannel, actor: ChatActor): Promise<string | null> {
    if (channel.kind !== "group") return null;
    const row = await prisma.chatChannelMember.findUnique({
        where: { channelId_userId: { channelId: channel.id, userId: actor.id } },
        select: { role: true }
    });
    return row?.role ?? null;
}

/** Refused unless this reader may change the rules here: in a group, its
 *  owner and admins only. */
async function requireMayChange(actor: ChatActor, channel: DirectChannel): Promise<void> {
    if (!rules.mayChangeRules(channel, await roleIn(channel, actor), actor.id)) {
        throw new ChatRuleError({ key: "errors.rulesGroupAdminsOnly" });
    }
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

/** A conversation's own rules for read receipts and typing. */
export interface ChatPrivacyRules {
    readonly receipts: rules.ChatPrivacyRule;
    readonly typing: rules.ChatPrivacyRule;
}

const FOLLOW: ChatPrivacyRules = { receipts: "follow", typing: "follow" };

/**
 * The receipts and typing rules in force in each of these conversations, in
 * one read whatever their number. A conversation that is not a direct one, or
 * is not found, follows each person's account setting.
 */
export async function chatPrivacyIn(
    channelIds: readonly string[]
): Promise<Map<string, ChatPrivacyRules>> {
    const wanted = [...new Set(channelIds)];
    const found = new Map<string, ChatPrivacyRules>();
    if (wanted.length === 0) return found;
    const [rows, mode] = await Promise.all([
        prisma.chatChannel.findMany({
            where: { id: { in: wanted } },
            select: {
                id: true,
                kind: true,
                spaceId: true,
                vanishAfter: true,
                deleteForAll: true,
                rulesAgreedAt: true,
                receipts: true,
                typing: true
            }
        }),
        dmRuleMode()
    ]);
    for (const row of rows) {
        if (!rules.hasDirectRules(row)) continue;
        const current = rules.effectiveRules(mode, row);
        found.set(row.id, { receipts: current.receipts, typing: current.typing });
    }
    return found;
}

/** `chatPrivacyIn` for one conversation. */
export async function chatPrivacyOf(channelId: string): Promise<ChatPrivacyRules> {
    return (await chatPrivacyIn([channelId])).get(channelId) ?? FOLLOW;
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
                    receipts: true,
                    typing: true,
                    acceptedBy: true,
                    status: true
                }
            }
        }
    });
    if (!channel || !rules.hasDirectRules(channel) || !access.member) return null;
    const mode = await dmRuleMode();
    const current = rules.effectiveRules(mode, channel);
    const proposes = rules.changeIsProposal(mode, channel.kind);
    const pending = proposes ? (channel.ruleProposals[0] ?? null) : null;
    const members = pending ? await memberIds(channelId) : [];
    return {
        mode,
        kind: channel.kind,
        vanishAfter: current.vanishAfter,
        deleteForAll: current.deleteForAll,
        receipts: current.receipts,
        typing: current.typing,
        agreed: channel.rulesAgreedAt !== null,
        mayChange: rules.mayChangeRules(channel, await roleIn(channel, actor), actor.id),
        proposes,
        proposal: pending
            ? {
                  id: pending.id,
                  proposedById: pending.proposedById,
                  vanishAfter: pending.vanishAfter,
                  deleteForAll: pending.deleteForAll,
                  receipts: rules.chatPrivacyRule(pending.receipts),
                  typing: rules.chatPrivacyRule(pending.typing),
                  mayAnswer: rules.mayAnswerProposal(pending, actor.id, members),
                  mine: pending.proposedById.toLowerCase() === actor.id.toLowerCase()
              }
            : null
    };
}

/** One change to a conversation's rules; whatever is left out stays. */
export interface RulesChange {
    readonly vanishAfter?: number;
    readonly receipts?: rules.ChatPrivacyRule;
    readonly typing?: rules.ChatPrivacyRule;
}

function checkChange(change: RulesChange): void {
    if (change.vanishAfter !== undefined && !rules.isVanishDuration(change.vanishAfter)) {
        throw new ChatRuleError({ key: "errors.vanishBadDuration" });
    }
    if (
        (change.receipts !== undefined && !rules.isChatPrivacyRule(change.receipts)) ||
        (change.typing !== undefined && !rules.isChatPrivacyRule(change.typing))
    ) {
        throw new ChatRuleError({ key: "errors.rulesBadValue" });
    }
}

/**
 * Change a conversation's rules - its timer, read receipts, typing.
 *
 * A one-to-one in the agreement mode turns it into a proposal the other person
 * accepts. Anywhere else it applies at once and a line in the chat says who
 * changed what: either person in a one-to-one, a group's owner and admins in a
 * group, whatever the screen offered.
 */
export async function changeRules(
    actor: ChatActor,
    channelId: string,
    change: RulesChange
): Promise<void> {
    checkChange(change);
    const channel = await requireDirect(actor, channelId);
    await requireMayChange(actor, channel);
    const mode = await dmRuleMode();
    const current = rules.effectiveRules(mode, channel);
    if (rules.changeIsProposal(mode, channel.kind)) {
        await proposeRules(actor, channelId, {
            vanishAfter: change.vanishAfter ?? current.vanishAfter,
            deleteForAll: current.deleteForAll,
            receipts: change.receipts ?? current.receipts,
            typing: change.typing ?? current.typing
        });
        return;
    }
    await requireNotTooFast(actor);
    const data: { vanishAfter?: number; receipts?: string; typing?: string } = {};
    if (change.vanishAfter !== undefined && change.vanishAfter !== current.vanishAfter) {
        data.vanishAfter = change.vanishAfter;
    }
    if (change.receipts !== undefined && change.receipts !== current.receipts) {
        data.receipts = change.receipts;
    }
    if (change.typing !== undefined && change.typing !== current.typing) data.typing = change.typing;
    if (Object.keys(data).length === 0) return;
    // The rules changed under anything still proposed, so nothing proposed
    // before now may be accepted later.
    await withdrawProposals({ channelId });
    await prisma.chatChannel.update({
        where: { id: channelId },
        // In a one-to-one, a change nobody agreed to is not an agreement: the
        // agreement mode, if the instance goes back to it, starts this
        // conversation over. A group's admins decide for the group, so what
        // they set is what the group has agreed in either mode.
        data: { ...data, rulesAgreedAt: channel.kind === "group" ? new Date() : null }
    });
    const who = await mentionOf(actor.id);
    for (const line of changeLines(who, data)) await postNoticeBody(channelId, line, actor.id);
}

/** The lines a change writes into the chat, one per rule that moved. */
function changeLines(
    who: string,
    data: { vanishAfter?: number; receipts?: string; typing?: string }
): string[] {
    const lines: string[] = [];
    if (data.vanishAfter !== undefined) lines.push(timerLine(who, data.vanishAfter));
    if (data.receipts !== undefined) {
        lines.push(ruleLine(who, "read receipts", rules.chatPrivacyRule(data.receipts)));
    }
    if (data.typing !== undefined) {
        lines.push(ruleLine(who, "the typing indicator", rules.chatPrivacyRule(data.typing)));
    }
    return lines;
}

function ruleLine(who: string, what: string, rule: rules.ChatPrivacyRule): string {
    return rule === "follow"
        ? `${who} set ${what} to follow each person's settings`
        : `${who} turned ${what} ${rule} for everyone in this chat`;
}

/** Change the timer. See `changeRules`. */
export async function setVanishTimer(
    actor: ChatActor,
    channelId: string,
    seconds: number
): Promise<void> {
    if (!rules.isVanishDuration(seconds)) throw new ChatRuleError({ key: "errors.vanishBadDuration" });
    await changeRules(actor, channelId, { vanishAfter: seconds });
}

function timerLine(who: string, seconds: number): string {
    return seconds === 0
        ? `${who} turned off disappearing messages`
        : `${who} set messages to disappear after ${rules.spokenVanish(seconds)}`;
}

/** A whole rule set, in words, for the lines that announce it. */
function spokenRules(proposed: {
    readonly vanishAfter: number;
    readonly deleteForAll: boolean;
    readonly receipts: rules.ChatPrivacyRule;
    readonly typing: rules.ChatPrivacyRule;
}): string {
    const timer =
        proposed.vanishAfter === 0
            ? "no disappearing messages"
            : `messages that disappear after ${rules.spokenVanish(proposed.vanishAfter)}`;
    const deletion = proposed.deleteForAll
        ? "deleting the chat for everybody allowed"
        : "deleting the chat for everybody off";
    const receipts = rules.spokenRule(proposed.receipts);
    const typing = rules.spokenRule(proposed.typing);
    return `${timer}, read receipts ${receipts}, typing indicator ${typing}, with ${deletion}`;
}

/**
 * Propose new rules, in the agreement mode. Replaces a proposal still
 * waiting; the one proposing has accepted it by proposing. A group never
 * proposes: its admins' change applies at once, with a line saying so.
 */
export async function proposeRules(
    actor: ChatActor,
    channelId: string,
    proposed: {
        readonly vanishAfter: number;
        readonly deleteForAll: boolean;
        readonly receipts?: rules.ChatPrivacyRule;
        readonly typing?: rules.ChatPrivacyRule;
    }
): Promise<void> {
    checkChange(proposed);
    const channel = await requireDirect(actor, channelId);
    await requireMayChange(actor, channel);
    const mode = await dmRuleMode();
    if (mode !== "agreement") throw new ChatRuleError({ key: "errors.vanishNoAgreement" });
    const current = rules.effectiveRules(mode, channel);
    const full = {
        vanishAfter: proposed.vanishAfter,
        deleteForAll: proposed.deleteForAll,
        receipts: proposed.receipts ?? current.receipts,
        typing: proposed.typing ?? current.typing
    };
    await requireNotTooFast(actor);
    const who = await mentionOf(actor.id);
    if (!rules.changeIsProposal(mode, channel.kind)) {
        await withdrawProposals({ channelId });
        await prisma.chatChannel.update({
            where: { id: channelId },
            data: { ...full, rulesAgreedAt: new Date() }
        });
        await postNoticeBody(channelId, `${who} set the chat rules: ${spokenRules(full)}`, actor.id);
        return;
    }
    // Proposing is accepting, so a conversation with nobody else left in it
    // agrees at once.
    const done = rules.proposalAccepted([actor.id], await memberIds(channelId));
    const now = new Date();
    await prisma.$transaction([
        prisma.chatRuleProposal.updateMany({
            where: { channelId, status: "pending" },
            data: { status: "replaced", decidedAt: now }
        }),
        prisma.chatRuleProposal.create({
            data: {
                channelId,
                proposedById: actor.id,
                ...full,
                acceptedBy: [actor.id],
                ...(done ? { status: "accepted", decidedAt: now } : {})
            }
        }),
        ...(done
            ? [
                  prisma.chatChannel.update({
                      where: { id: channelId },
                      data: { ...full, rulesAgreedAt: now }
                  })
              ]
            : [])
    ]);
    if (done) {
        await postNoticeBody(channelId, acceptedLine(who, full), actor.id);
        return;
    }
    await postNoticeBody(channelId, `${who} proposed ${spokenRules(full)}`, actor.id);
}

/** Withdraw a proposal still waiting. Only the one who made it may. */
export async function withdrawProposal(actor: ChatActor, proposalId: string): Promise<void> {
    const proposal = await prisma.chatRuleProposal.findUnique({
        where: { id: proposalId },
        select: { id: true, channelId: true, status: true, proposedById: true }
    });
    if (!proposal) throw new ChatRuleError({ key: "errors.proposalGone" });
    await requireDirect(actor, proposal.channelId);
    if (proposal.status !== "pending") throw new ChatRuleError({ key: "errors.proposalGone" });
    if (proposal.proposedById.toLowerCase() !== actor.id.toLowerCase()) {
        throw new ChatRuleError({ key: "errors.proposalNotYours" });
    }
    await requireNotTooFast(actor);
    const closed = await prisma.chatRuleProposal.updateMany({
        where: { id: proposal.id, status: "pending" },
        data: { status: "withdrawn", decidedAt: new Date() }
    });
    if (closed.count === 0) throw new ChatRuleError({ key: "errors.proposalGone" });
    await postNoticeBody(
        proposal.channelId,
        `${await mentionOf(actor.id)} withdrew the proposed chat rules`,
        actor.id
    );
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
            deleteForAll: true,
            receipts: true,
            typing: true
        }
    });
    if (!proposal) throw new ChatRuleError({ key: "errors.proposalGone" });
    const channel = await requireDirect(actor, proposal.channelId);
    // A group's proposal left from before its admins decided alone is not
    // answerable any more: nothing on the screen shows it.
    const mode = await dmRuleMode();
    if (!rules.changeIsProposal(mode, channel.kind) || proposal.status !== "pending") {
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
    const agreed = {
        vanishAfter: proposal.vanishAfter,
        deleteForAll: proposal.deleteForAll,
        receipts: rules.chatPrivacyRule(proposal.receipts),
        typing: rules.chatPrivacyRule(proposal.typing)
    };
    const now = new Date();
    // The vote is appended in SQL rather than written back as the list read
    // above, and the update holds the row until the transaction ends: two
    // people accepting at once are serialised, and whoever goes second sees
    // the first one's vote when deciding whether everybody has agreed.
    const settled = await prisma.$transaction(async (tx) => {
        const moved = await tx.chatRuleProposal.updateMany({
            where: { id: proposal.id, status: "pending", NOT: { acceptedBy: { has: actor.id } } },
            data: { acceptedBy: { push: actor.id } }
        });
        if (moved.count === 0) return null;
        const fresh = await tx.chatRuleProposal.findUnique({
            where: { id: proposal.id },
            select: { acceptedBy: true }
        });
        if (!rules.proposalAccepted(fresh?.acceptedBy ?? [], members)) return { done: false };
        // Only the one that moves it to accepted applies it.
        const closed = await tx.chatRuleProposal.updateMany({
            where: { id: proposal.id, status: "pending" },
            data: { status: "accepted", decidedAt: now }
        });
        const done = closed.count > 0;
        if (done) {
            await tx.chatChannel.update({
                where: { id: proposal.channelId },
                data: { ...agreed, rulesAgreedAt: now }
            });
        }
        return { done };
    });
    if (!settled) throw new ChatRuleError({ key: "errors.proposalGone" });
    await postNoticeBody(
        proposal.channelId,
        settled.done ? acceptedLine(who, agreed) : `${who} accepted the proposed chat rules`,
        actor.id
    );
}

function acceptedLine(
    who: string,
    agreed: {
        readonly vanishAfter: number;
        readonly receipts: rules.ChatPrivacyRule;
        readonly typing: rules.ChatPrivacyRule;
    }
): string {
    const timer =
        agreed.vanishAfter === 0
            ? "messages no longer disappear"
            : `messages disappear after ${rules.spokenVanish(agreed.vanishAfter)}`;
    const receipts = rules.spokenRule(agreed.receipts);
    const typing = rules.spokenRule(agreed.typing);
    return `${who} accepted the chat rules: ${timer}, read receipts ${receipts}, typing indicator ${typing}`;
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

/**
 * What a new direct message or group starts with: the administrator's
 * starting rules for read receipts and typing, and their timer - or, where
 * they left the timer to each person, the starter's own default, which in a
 * one-to-one under the agreement mode is proposed rather than set. Never
 * throws: the conversation stands either way, and the rules can be changed by
 * hand.
 */
export async function applyDefaultTimer(actor: ChatActor, channelId: string): Promise<void> {
    try {
        const start = await startingRules();
        if (start.receipts !== "follow" || start.typing !== "follow" || start.vanishAfter) {
            // The instance's starting values rather than anybody's change, so
            // they count as agreed from the first message and say nothing.
            await prisma.chatChannel.update({
                where: { id: channelId },
                data: {
                    receipts: start.receipts,
                    typing: start.typing,
                    ...(start.vanishAfter ? { vanishAfter: start.vanishAfter } : {}),
                    rulesAgreedAt: new Date()
                }
            });
        }
        if (start.vanishAfter !== null) return;
        const privacy = await prisma.userPrivacy.findUnique({
            where: { userId: actor.id },
            select: { chatVanishAfter: true }
        });
        const seconds = privacy?.chatVanishAfter ?? 0;
        if (seconds === 0 || !rules.isVanishDuration(seconds)) return;
        await setVanishTimer(actor, channelId, seconds);
    } catch (error) {
        // The conversation stands either way; the default can be set by hand.
        console.error("[chat] could not apply the starting chat rules:", error);
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
