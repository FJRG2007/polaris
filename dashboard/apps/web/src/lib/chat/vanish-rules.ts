/**
 * The rules of a direct conversation - how long its messages last and whether
 * one person may delete it for everybody - as pure functions, so the server and
 * the screen ask the same question and a test can ask it without a database.
 *
 * Prior art: WhatsApp, Telegram and Signal all keep a timer per conversation
 * that either person may change, counted from when a message is sent and only
 * for messages sent while it is on. Each message here carries its own expiry
 * for the same reason: changing the timer never moves what is already written.
 *
 * The instance decides how the rules are made. "open" is the messengers' way.
 * "agreement" makes every change a proposal the other members accept, and a
 * conversation nobody has agreed anything in has no timer and no delete for
 * everybody.
 */

import * as core from "@polaris/core";
import { groupOwnerId } from "./ownership";

/** How long a message may last, in seconds: off, 24 h, 7 d, 30 d, 90 d. */
export const VANISH_DURATIONS = [0, 86_400, 604_800, 2_592_000, 7_776_000] as const;
export type VanishDuration = (typeof VANISH_DURATIONS)[number];

export function isVanishDuration(value: unknown): value is VanishDuration {
    return (VANISH_DURATIONS as readonly unknown[]).includes(value);
}

/** How the instance decides a direct conversation's rules. */
export const DM_RULE_MODES = ["open", "agreement"] as const;
export type DmRuleMode = (typeof DM_RULE_MODES)[number];

export function isDmRuleMode(value: unknown): value is DmRuleMode {
    return (DM_RULE_MODES as readonly unknown[]).includes(value);
}

/** Whether a conversation has these rules at all: a direct message or a
 *  group outside any space. A space's channels are run by the space. */
export function hasDirectRules(channel: {
    readonly kind: string;
    readonly spaceId: string | null;
}): boolean {
    return !channel.spaceId && (channel.kind === "dm" || channel.kind === "group");
}

/** A conversation's own rule for read receipts or typing: "follow" leaves it
 *  to each person's account setting, "on" and "off" decide it for everybody in
 *  the conversation. */
export const CHAT_PRIVACY_RULES = core.CHAT_PRIVACY_RULES;
export type ChatPrivacyRule = core.ChatPrivacyRule;

export function isChatPrivacyRule(value: unknown): value is ChatPrivacyRule {
    return core.chatPrivacyRuleSchema.safeParse(value).success;
}

/** A stored rule read back, anything unknown being "follow". */
export function chatPrivacyRule(value: unknown): ChatPrivacyRule {
    return isChatPrivacyRule(value) ? value : "follow";
}

/** What a channel stores about its rules. */
export interface StoredDirectRules {
    readonly vanishAfter: number;
    readonly deleteForAll: boolean;
    readonly rulesAgreedAt: Date | null;
    readonly receipts?: string;
    readonly typing?: string;
}

/** The rules in force, under the instance's mode. */
export interface DirectRules {
    readonly vanishAfter: number;
    readonly deleteForAll: boolean;
    readonly receipts: ChatPrivacyRule;
    readonly typing: ChatPrivacyRule;
}

export function effectiveRules(mode: DmRuleMode, stored: StoredDirectRules): DirectRules {
    const vanishAfter = isVanishDuration(stored.vanishAfter) ? stored.vanishAfter : 0;
    const receipts = chatPrivacyRule(stored.receipts);
    const typing = chatPrivacyRule(stored.typing);
    if (mode === "open") return { vanishAfter, deleteForAll: true, receipts, typing };
    if (!stored.rulesAgreedAt) {
        return { vanishAfter: 0, deleteForAll: false, receipts: "follow", typing: "follow" };
    }
    return { vanishAfter, deleteForAll: stored.deleteForAll, receipts, typing };
}

/**
 * Whether this person may change a conversation's rules. In a one-to-one,
 * either of the two - how, the instance's mode decides. In a group, only its
 * owner and the members made its admins, and the change is announced rather
 * than proposed: a group of thirty that has to agree unanimously never changes
 * anything.
 */
export function mayChangeRules(
    channel: { readonly kind: string; readonly ownerId?: string | null; readonly createdById?: string | null },
    role: string | null,
    actorId: string
): boolean {
    if (channel.kind !== "group") return true;
    if (role === "admin") return true;
    const owner = groupOwnerId({ ownerId: channel.ownerId ?? null, createdById: channel.createdById });
    return owner !== null && owner.toLowerCase() === actorId.toLowerCase();
}

/** Whether a change in this conversation waits for the others to accept it:
 *  only a one-to-one, and only in the agreement mode. */
export function changeIsProposal(mode: DmRuleMode, kind: string): boolean {
    return mode === "agreement" && kind === "dm";
}

/** Whether a chat's rule lets this be shown, given what the two account
 *  settings answered: the chat's "on" and "off" win inside the chat. */
export function underChatRule(rule: ChatPrivacyRule, accountAllows: boolean): boolean {
    if (rule === "on") return true;
    if (rule === "off") return false;
    return accountAllows;
}

/** The rule as English words, for the system line written into the chat. */
export function spokenRule(rule: ChatPrivacyRule): string {
    return rule === "on" ? "on" : rule === "off" ? "off" : "following each person's settings";
}

/** When a message sent at `sentAt` under this timer disappears, or null. */
export function expiryFor(sentAt: Date, vanishAfter: number): Date | null {
    if (!isVanishDuration(vanishAfter) || vanishAfter === 0) return null;
    return new Date(sentAt.getTime() + vanishAfter * 1000);
}

/** Whether a message is past its expiry at `now`. */
export function isExpired(expiresAt: Date | string | null | undefined, now: number): boolean {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() <= now;
}

/** A proposal is accepted once every member has accepted it. */
export function proposalAccepted(
    acceptedBy: readonly string[],
    memberIds: readonly string[]
): boolean {
    if (memberIds.length === 0) return false;
    const yes = new Set(acceptedBy.map((id) => id.toLowerCase()));
    return memberIds.every((id) => yes.has(id.toLowerCase()));
}

/** Whether this person may answer a proposal: a member who has not said yes
 *  to it already. The one who proposed it accepted it by proposing. */
export function mayAnswerProposal(
    proposal: { readonly status: string; readonly acceptedBy: readonly string[] },
    userId: string,
    memberIds: readonly string[]
): boolean {
    if (proposal.status !== "pending") return false;
    const id = userId.toLowerCase();
    if (!memberIds.some((member) => member.toLowerCase() === id)) return false;
    return !proposal.acceptedBy.some((member) => member.toLowerCase() === id);
}

/** The duration as English words, for the system line written into the chat. */
export function spokenVanish(seconds: number): string {
    switch (seconds) {
        case 86_400:
            return "24 hours";
        case 604_800:
            return "7 days";
        case 2_592_000:
            return "30 days";
        case 7_776_000:
            return "90 days";
        default:
            return "never";
    }
}
