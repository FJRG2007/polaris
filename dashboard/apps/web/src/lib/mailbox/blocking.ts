/**
 * Blocking a sender.
 *
 * **There is no such thing at the protocol level, and it is worth being straight
 * about that.** IMAP and SMTP have no notion of a sender somebody refuses: a
 * message is delivered to the mailbox by the sending server long before any
 * client sees it, and nothing a client says afterwards can stop the next one
 * arriving. Only the mail provider can refuse mail, and only some of them offer
 * a way to ask - none of it over IMAP.
 *
 * So what a block means here is the nearest honest thing: every message from
 * that address goes straight to the trash as it arrives, and never appears in
 * the inbox. Mail still reaches the mailbox and still counts against its quota;
 * it is simply never shown, and it is thrown away where a mistake can be
 * recovered rather than deleted where it cannot.
 *
 * Built on the rules that already exist rather than on a table of its own,
 * because a block IS a rule - and one somebody can then open, read, loosen or
 * turn off like any other. A block is recognised by its shape rather than by a
 * name or a flag: one condition, on the sender, matching exactly, and one
 * action that takes the message out of the inbox. Somebody who builds that rule
 * by hand has blocked a sender, and the screen should say so.
 */

import * as core from "@polaris/core";
import { saveRule, deleteRule, listRules, type MailRuleView } from "./rules";

/** Somebody whose mail never reaches the inbox. */
export interface BlockedSender {
    readonly address: string;
    /** The rule behind it, so the screen can unblock by removing it and so
     *  anybody who wants to change what happens can go and edit it. */
    readonly ruleId: string;
    /** Whether it goes to the trash or to spam. Spam teaches the provider as
     *  well, which is either what somebody wanted or more than they asked for. */
    readonly as: "trash" | "junk";
    readonly enabled: boolean;
    /** How many messages it has caught, so a block that is doing nothing is
     *  visible as one. */
    readonly caught: number;
}

/** Whether a rule is a block, read off its shape. */
export function blockedBy(rule: MailRuleView): BlockedSender | null {
    if (rule.conditions.length !== 1 || rule.actions.length !== 1) return null;
    const [condition] = rule.conditions;
    const [action] = rule.actions;
    if (!condition || !action) return null;
    if (condition.field !== "from" || condition.operator !== "is") return null;
    if (action.kind !== "trash" && action.kind !== "junk") return null;
    return {
        address: condition.value,
        ruleId: rule.id,
        as: action.kind,
        enabled: rule.enabled,
        caught: rule.matchCount
    };
}

/** Everybody this mailbox is refusing. */
export async function listBlockedSenders(userId: string, accountId: string): Promise<BlockedSender[]> {
    const rules = await listRules(userId, accountId);
    return rules.map(blockedBy).filter((one): one is BlockedSender => one !== null);
}

/**
 * Refuse a sender from now on, and clear out what they have already sent.
 *
 * `applyToExisting` is the half people actually mean by "block": somebody
 * blocking a sender is looking at mail from them right now, and a block that
 * only applies to the next message leaves the pile that prompted it sitting
 * there.
 */
export async function blockSender(
    userId: string,
    accountId: string,
    address: string,
    as: "trash" | "junk" = "trash"
): Promise<void> {
    const wanted = address.trim().toLowerCase();
    if (!wanted) return;

    // Already refused: leave the rule that is doing it alone rather than adding
    // a second one that says the same thing.
    const already = await listBlockedSenders(userId, accountId);
    if (already.some((one) => core.sameAddress(one.address, wanted))) return;

    await saveRule(userId, accountId, null, {
        name: `Block ${wanted}`,
        enabled: true,
        match: "all",
        conditions: [{ field: "from", operator: "is", value: wanted }],
        actions: [{ kind: as }],
        // Nothing after this needs to run: the message is leaving the inbox.
        stop: true,
        applyToExisting: true
    });
}

/** Take the block off. What was already thrown away stays thrown away - it is in
 *  the trash, where it can be fetched back by hand. */
export async function unblockSender(userId: string, accountId: string, ruleId: string): Promise<void> {
    await deleteRule(userId, accountId, ruleId);
}
