/**
 * Filters: what happens to a message before anybody looks at it.
 *
 * The deciding is pure and lives in `@polaris/core` - given a message and a list
 * of rules it answers with a list of actions and touches nothing. This file is
 * the half that reads the message out of the database and carries the actions
 * out, which means it is also the half that can go wrong in a way somebody
 * notices: a rule that files mail into a folder is a rule that can lose mail if
 * it runs on the wrong thing.
 *
 * So it is deliberately narrow. Rules run on arrival in the inbox and nowhere
 * else, they run once per message, and `applyRules` returns what it did rather
 * than announcing it, so the same code can drive the "test this rule" button
 * without moving anything.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { ownedAccount } from "./access";
import { addressesFrom, asJson } from "./json";

/** The stored shape of a rule, as the JSON columns hold it. */
function toRule(row: {
    id: string;
    name: string;
    enabled: boolean;
    match: string;
    conditions: unknown;
    actions: unknown;
    stop: boolean;
}): core.MailRule {
    return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        match: row.match === "any" ? "any" : "all",
        conditions: (row.conditions as unknown as core.MailRuleCondition[]) ?? [],
        actions: (row.actions as unknown as core.MailRuleAction[]) ?? [],
        stop: row.stop
    };
}

/** Everything a rule needs to know about a message. The body is the plain text
 *  only, and only what has already been fetched: a rule that matched on a body
 *  would otherwise download every arriving message to decide. */
async function subjectFor(messageId: string): Promise<core.MailRuleSubject | null> {
    const message = await prisma.mailMessage.findUnique({
        where: { id: messageId },
        select: {
            subject: true,
            snippet: true,
            bodyText: true,
            listId: true,
            hasAttachments: true,
            size: true,
            fromJson: true,
            toJson: true,
            ccJson: true
        }
    });
    if (!message) return null;
    return {
        from: addressesFrom(message.fromJson),
        to: addressesFrom(message.toJson),
        cc: addressesFrom(message.ccJson),
        subject: message.subject,
        text: message.bodyText ?? message.snippet,
        listId: message.listId,
        hasAttachments: message.hasAttachments,
        size: message.size
    };
}

/** What a pass did, for the report on the rules screen and for the test button. */
export interface RuleOutcome {
    readonly actions: readonly core.MailRuleAction[];
    readonly applied: boolean;
}

/**
 * Run this account's rules over one message and do what they say.
 *
 * Nothing happens for an account with no rules, which is nearly every account,
 * and the check is one indexed query - this is on the path of every message that
 * arrives.
 */
export async function applyRulesToMessage(accountId: string, messageId: string): Promise<RuleOutcome> {
    const rows = await prisma.mailRule.findMany({
        where: { accountId, enabled: true },
        orderBy: { position: "asc" },
        select: { id: true, name: true, enabled: true, match: true, conditions: true, actions: true, stop: true }
    });
    if (rows.length === 0) return { actions: [], applied: false };

    const subject = await subjectFor(messageId);
    if (!subject) return { actions: [], applied: false };

    const rules = rows.map(toRule);
    const actions = core.mailActionsFor(rules, subject);
    if (actions.length === 0) return { actions: [], applied: false };

    // Which rules fired, so the screen can say a rule that matches everything
    // matches everything.
    const fired = rules.filter((rule) => core.mailRuleMatches(rule, subject)).map((rule) => rule.id);
    await prisma.mailRule.updateMany({
        where: { id: { in: fired } },
        data: { matchCount: { increment: 1 }, lastRunAt: new Date() }
    });

    await performActions(accountId, messageId, actions);
    return { actions, applied: true };
}

/**
 * Carry out one message's worth of actions.
 *
 * The moving ones go through the ordinary message service so a filter and a
 * person pressing Archive do exactly the same thing to a mailbox - there is no
 * second, quieter path that moves mail. It is imported at the call site rather
 * than at the top of the file because that service reads this one back for the
 * "what did the rules do" report, and a cycle resolved at module load is a cycle
 * that breaks on the day somebody reorders an import.
 */
async function performActions(
    accountId: string,
    messageId: string,
    actions: readonly core.MailRuleAction[]
): Promise<void> {
    const { actOnMessages, moveMessages } = await import("./messages");
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true }
    });
    if (!account) return;

    for (const action of actions) {
        switch (action.kind) {
            case "read":
                await actOnMessages(account.userId, [messageId], "read");
                break;
            case "star":
                await actOnMessages(account.userId, [messageId], "star");
                break;
            case "archive":
                await actOnMessages(account.userId, [messageId], "archive");
                break;
            case "trash":
                await actOnMessages(account.userId, [messageId], "trash");
                break;
            case "junk":
                await actOnMessages(account.userId, [messageId], "junk");
                break;
            case "move":
                await moveMessages(account.userId, [messageId], action.folder);
                break;
            case "label":
                await prisma.mailMessageLabel
                    .create({
                        data: {
                            labelId: action.label,
                            messageId,
                            headerId: await headerIdOf(messageId)
                        }
                    })
                    // Already labelled is not a failure: a rule re-run over a
                    // mailbox must be able to do nothing.
                    .catch(() => undefined);
                break;
            case "pin":
                await prisma.mailMessage.update({ where: { id: messageId }, data: { pinned: true } });
                break;
            case "mute":
                await prisma.mailMessage
                    .findUnique({ where: { id: messageId }, select: { threadId: true } })
                    .then((message) =>
                        message
                            ? prisma.mailThread.update({ where: { id: message.threadId }, data: { muted: true } })
                            : undefined
                    );
                break;
        }
    }
}

async function headerIdOf(messageId: string): Promise<string> {
    const message = await prisma.mailMessage.findUnique({
        where: { id: messageId },
        select: { messageId: true }
    });
    return message?.messageId ?? "";
}

/* -------------------------------------------------------------------------- */
/* Managing them                                                               */
/* -------------------------------------------------------------------------- */

export interface MailRuleView {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly match: "all" | "any";
    readonly conditions: readonly core.MailRuleCondition[];
    readonly actions: readonly core.MailRuleAction[];
    readonly stop: boolean;
    readonly position: number;
    readonly matchCount: number;
}

export async function listRules(userId: string, accountId: string): Promise<MailRuleView[]> {
    await ownedAccount(userId, accountId);
    const rows = await prisma.mailRule.findMany({
        where: { accountId },
        orderBy: { position: "asc" }
    });
    return rows.map((row) => ({ ...toRule(row), position: row.position, matchCount: row.matchCount }));
}

export async function saveRule(
    userId: string,
    accountId: string,
    ruleId: string | null,
    rule: {
        name: string;
        enabled: boolean;
        match: "all" | "any";
        conditions: readonly core.MailRuleCondition[];
        actions: readonly core.MailRuleAction[];
        stop: boolean;
        applyToExisting: boolean;
    }
): Promise<string> {
    await ownedAccount(userId, accountId);
    const data = {
        name: rule.name,
        enabled: rule.enabled,
        match: rule.match,
        conditions: asJson(rule.conditions),
        actions: asJson(rule.actions),
        stop: rule.stop
    };

    let id = ruleId;
    if (id) {
        const held = await prisma.mailRule.findFirst({ where: { id, accountId }, select: { id: true } });
        if (!held) throw new Error("That rule is not on this mailbox.");
        await prisma.mailRule.update({ where: { id }, data });
    } else {
        const last = await prisma.mailRule.findFirst({
            where: { accountId },
            orderBy: { position: "desc" },
            select: { position: true }
        });
        const created = await prisma.mailRule.create({
            data: { accountId, ...data, position: (last?.position ?? -1) + 1 },
            select: { id: true }
        });
        id = created.id;
    }

    // Running a new rule over what is already there is what somebody expects
    // from "and do this to the ones I already have", and it is the reason the
    // checkbox exists. Behind the response, because it can move thousands of
    // messages and nobody should watch a spinner for it.
    if (rule.applyToExisting) void applyToInbox(accountId).catch(() => undefined);
    return id;
}

/** Run every rule over what is already in the inbox. Bounded, because it moves
 *  mail and a runaway pass is worse than an unfinished one. */
export async function applyToInbox(accountId: string, limit = 1000): Promise<number> {
    const messages = await prisma.mailMessage.findMany({
        where: { accountId, folder: { role: "inbox" } },
        select: { id: true },
        orderBy: { sentAt: "desc" },
        take: limit
    });
    let moved = 0;
    for (const message of messages) {
        const outcome = await applyRulesToMessage(accountId, message.id).catch(() => null);
        if (outcome?.applied) moved += 1;
    }
    return moved;
}

export async function deleteRule(userId: string, accountId: string, ruleId: string): Promise<void> {
    await ownedAccount(userId, accountId);
    await prisma.mailRule.deleteMany({ where: { id: ruleId, accountId } });
}

/** Reorder them. Rules are read top to bottom and one can stop the rest, so the
 *  order is the rule. */
export async function reorderRules(
    userId: string,
    accountId: string,
    orderedIds: readonly string[]
): Promise<void> {
    await ownedAccount(userId, accountId);
    const mine = new Set(
        (await prisma.mailRule.findMany({ where: { accountId }, select: { id: true } })).map((row) => row.id)
    );
    await prisma.$transaction(
        orderedIds
            .filter((id) => mine.has(id))
            .map((id, index) => prisma.mailRule.update({ where: { id }, data: { position: index } }))
    );
}
