/**
 * Filters: what happens to a message before anybody looks at it.
 *
 * A filter is an automation - WHEN a message arrives, IF these groups of
 * conditions hold, THEN these steps - and the deciding is pure and lives in
 * `@polaris/core`: given a message and a list of filters it answers with a list
 * of actions and touches nothing. This file is the half that reads the message
 * out of the database and carries the actions out, which means it is also the
 * half that can go wrong in a way somebody notices: a rule that files mail into
 * a folder is a rule that can lose mail if it runs on the wrong thing.
 *
 * So it is deliberately narrow. Rules run on arrival in the inbox and nowhere
 * else, they run once per message, and `applyRules` returns what it did rather
 * than announcing it, so the same code can drive the "test this rule" button
 * without moving anything.
 *
 * A filter saved before filters were automations has no `definition`; it is
 * read from its old columns (`mailFilterFromLegacy`) until somebody saves it,
 * and every save writes those columns as well (`mailFilterLegacy`), so a Polaris
 * rolled back to before this reads every filter safely.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { ownedAccount } from "./access";
import { listUserEmails } from "@polaris/auth";
import { addressesFrom, asJson } from "./json";
import { recordAudit } from "@/lib/audit-service";
import { timedPatternTest } from "./pattern-test";

/** Why a filter could not be saved, in the words the screen says it in. Thrown
 *  rather than returned, the way every other refusal here is. */
export class MailRuleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MailRuleError";
    }
}

/** The columns a filter is read from. */
const RULE_COLUMNS = {
    id: true,
    name: true,
    enabled: true,
    match: true,
    conditions: true,
    actions: true,
    stop: true,
    definition: true
} as const;

/** Whether a stored definition has the shape the evaluator walks. Not the full
 *  schema: a filter saved under a later, wider schema must still run here, and
 *  anything the evaluator does not know it treats as matching nothing. */
function isDefinition(value: unknown): value is core.MailFilterDefinition {
    if (!value || typeof value !== "object") return false;
    const held = value as Partial<Record<keyof core.MailFilterDefinition, unknown>>;
    const conditions = held.conditions as { groups?: unknown } | undefined;
    return (
        Array.isArray(held.triggers) &&
        Array.isArray(held.actions) &&
        typeof conditions === "object" &&
        conditions !== null &&
        Array.isArray(conditions.groups) &&
        conditions.groups.every(
            (group: unknown) =>
                typeof group === "object" &&
                group !== null &&
                Array.isArray((group as { items?: unknown }).items)
        )
    );
}

/** A filter as its row holds it: the definition, or - for one saved before
 *  there were definitions - the definition its old columns describe. */
export function definitionOf(row: {
    match: string;
    conditions: unknown;
    actions: unknown;
    stop: boolean;
    definition: unknown;
}): core.MailFilterDefinition {
    return isDefinition(row.definition) ? row.definition : core.mailFilterFromLegacy(row);
}

function toRule(row: {
    id: string;
    name: string;
    enabled: boolean;
    match: string;
    conditions: unknown;
    actions: unknown;
    stop: boolean;
    definition: unknown;
}): core.MailRule {
    return { id: row.id, name: row.name, enabled: row.enabled, definition: definitionOf(row) };
}

/** Everything a rule needs to know about a message. The body is the plain text
 *  only, and only what has already been fetched: a rule that matched on a body
 *  would otherwise download every arriving message to decide. */
const SUBJECT_COLUMNS = {
    subject: true,
    snippet: true,
    bodyText: true,
    listId: true,
    hasAttachments: true,
    size: true,
    fromJson: true,
    toJson: true,
    ccJson: true,
    headers: true
} as const;

async function subjectFor(messageId: string): Promise<core.MailRuleSubject | null> {
    const message = await prisma.mailMessage.findUnique({
        where: { id: messageId },
        select: SUBJECT_COLUMNS
    });
    if (!message) return null;
    return asSubject(message);
}

/** A message row, as a rule reads it. */
function asSubject(message: {
    subject: string;
    snippet: string;
    bodyText: string | null;
    listId: string;
    hasAttachments: boolean;
    size: number;
    fromJson: unknown;
    toJson: unknown;
    ccJson: unknown;
    headers?: unknown;
}): core.MailRuleSubject {
    const headers =
        message.headers && typeof message.headers === "object" && !Array.isArray(message.headers)
            ? (message.headers as Record<string, unknown>)
            : {};
    return {
        from: addressesFrom(message.fromJson),
        to: addressesFrom(message.toJson),
        cc: addressesFrom(message.ccJson),
        subject: message.subject,
        text: message.bodyText ?? message.snippet,
        listId: message.listId,
        hasAttachments: message.hasAttachments,
        size: message.size,
        headers
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
 * arrives. Patterns run under a time limit (`timedPatternTest`), so one filter
 * cannot hold up a sync.
 */
export async function applyRulesToMessage(
    accountId: string,
    messageId: string
): Promise<RuleOutcome> {
    const rows = await prisma.mailRule.findMany({
        where: { accountId, enabled: true },
        orderBy: { position: "asc" },
        select: RULE_COLUMNS
    });
    if (rows.length === 0) return { actions: [], applied: false };

    const subject = await subjectFor(messageId);
    if (!subject) return { actions: [], applied: false };

    const outcome = core.mailFiltersFor(rows.map(toRule), subject, timedPatternTest);
    if (outcome.matched.length === 0) return { actions: [], applied: false };

    // Which rules fired - only those the walk reached, so a filter below one that
    // stops is not counted for mail it never saw.
    await prisma.mailRule.updateMany({
        where: { id: { in: [...outcome.matched] } },
        data: { matchCount: { increment: 1 }, lastRunAt: new Date() }
    });

    if (outcome.actions.length > 0) await performActions(accountId, messageId, outcome.actions);
    return { actions: outcome.actions, applied: outcome.actions.length > 0 };
}

/**
 * The header names this mailbox's filters look at, for the sync to fetch.
 *
 * A message keeps only a handful of its headers; a filter on any other one would
 * read a header nothing stored and never match. So the inbox sync asks the
 * server for these as well. Bounded, because each one is fetched for every
 * message that arrives.
 */
export async function filterHeaderNames(accountId: string, limit = 16): Promise<string[]> {
    const rows = await prisma.mailRule.findMany({
        where: { accountId, enabled: true },
        select: RULE_COLUMNS
    });
    const names = new Set<string>();
    for (const row of rows) {
        for (const group of definitionOf(row).conditions.groups) {
            for (const item of group.items) {
                const name = (item.header ?? "").trim().toLowerCase();
                if (item.kind === "header" && core.MAIL_HEADER_NAME.test(name)) names.add(name);
            }
        }
    }
    return [...names].slice(0, limit);
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
 *
 * Each action is tried on its own. One that fails - the mail server refused the
 * move, the mailbox has no folder recognised as its Trash - is logged and the
 * rest still run. It used to throw out of the sync that delivered the message:
 * the pass stopped there, the mailbox was marked unreachable, and because the
 * message was already stored the next pass saw it as old and never judged it
 * again, so a filter that matched left its mail where it was with nothing said.
 */
async function performActions(
    accountId: string,
    messageId: string,
    actions: readonly core.MailRuleAction[]
): Promise<void> {
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true }
    });
    if (!account) return;
    for (const action of actions) {
        try {
            await performAction(account.userId, accountId, messageId, action);
        } catch (caught) {
            // Which filter step and why, never what the message says.
            console.error(
                `polaris: a mail filter could not ${action.kind} a message in mailbox ${accountId}:`,
                caught instanceof Error ? caught.message : caught
            );
        }
    }
}

async function performAction(
    userId: string,
    accountId: string,
    messageId: string,
    action: core.MailRuleAction
): Promise<void> {
    const { actOnMessages, moveMessages } = await import("./messages");
    switch (action.kind) {
        case "read":
            await actOnMessages(userId, [messageId], "read");
            break;
        case "star":
            await actOnMessages(userId, [messageId], "star");
            break;
        case "archive":
            await actOnMessages(userId, [messageId], "archive");
            break;
        case "trash":
            await actOnMessages(userId, [messageId], "trash");
            break;
        case "junk":
            await actOnMessages(userId, [messageId], "junk");
            break;
        case "move":
            await moveMessages(userId, [messageId], action.folder);
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
            // The conversation, not only the message: the list orders by the
            // conversation's pin, so a pin written on the message alone was a
            // rule that did nothing anybody could see.
            await prisma.mailMessage
                .update({
                    where: { id: messageId },
                    data: { pinned: true },
                    select: { threadId: true }
                })
                .then((message) =>
                    prisma.mailThread.update({
                        where: { id: message.threadId },
                        data: { pinned: true }
                    })
                );
            break;
        case "forward":
            await forwardMessage(accountId, messageId, action.to);
            break;
        case "mute":
            await prisma.mailMessage
                .findUnique({ where: { id: messageId }, select: { threadId: true } })
                .then((message) =>
                    message
                        ? prisma.mailThread.update({
                              where: { id: message.threadId },
                              data: { muted: true }
                          })
                        : undefined
                );
            break;
    }
}

/**
 * Send a message on, because a filter said to.
 *
 * The only thing in the rules engine that leaves this machine, so it is the only
 * one with refusals of its own:
 *
 * - **Only to an address its owner has verified** on their Polaris account,
 *   the way every mail service asks for a forwarding address to be confirmed
 *   before it sends anything there.
 * - **Never to an address on this account.** Forwarding a mailbox to itself is a
 *   loop with one participant, and it is the shape somebody produces by accident
 *   within a minute of finding the feature.
 * - **Never a message that has already been forwarded.** The copy carries
 *   `X-Polaris-Forwarded`, and a message arriving with it is one that has been
 *   round at least once. Two mailboxes forwarding to each other otherwise fill
 *   both servers overnight, and the person who set it up finds out from their
 *   provider rather than from us.
 * - **Never an automatic message.** Bounces and out-of-office replies are how a
 *   loop restarts after the header is lost, which happens whenever the far end
 *   is not Polaris.
 *
 * Failures are swallowed. A rule that could not reach its destination must not
 * be the reason a sync stops - the message is already delivered, and the next
 * one will try again.
 */
async function forwardMessage(accountId: string, messageId: string, to: string): Promise<void> {
    try {
        const [{ composeMime, sendMime }, { ACCOUNT_COLUMNS }] = await Promise.all([
            import("./send"),
            import("./access")
        ]);
        const account = await prisma.mailAccount.findUnique({
            where: { id: accountId },
            select: { ...ACCOUNT_COLUMNS, user: { select: { name: true } } }
        });
        if (!account) return;

        const wanted = to.trim().toLowerCase();
        if (!wanted) return;
        // Its own address, or any other mailbox this person has here. Both are
        // loops; the second is the one nobody sees coming.
        const mine = await prisma.mailAccount.findMany({
            where: { userId: account.userId },
            select: { address: true }
        });
        if (mine.some((one) => core.sameAddress(one.address, wanted))) return;
        // Only to an address its owner has proved they read - checked here as
        // well as on save, because the address can be removed from the account
        // after the filter was written.
        const verified = await forwardTargets(account.userId);
        if (!verified.some((one) => core.sameAddress(one, wanted))) return;

        const message = await prisma.mailMessage.findUnique({
            where: { id: messageId },
            select: {
                subject: true,
                snippet: true,
                bodyText: true,
                fromJson: true,
                headers: true,
                listId: true
            }
        });
        if (!message) return;

        const headers = (message.headers ?? {}) as Record<string, unknown>;
        // Been round once already.
        if (typeof headers["x-polaris-forwarded"] === "string") return;
        // Automatic mail. A bounce forwarded to a mailbox that bounces is the
        // same loop with the header stripped off by whatever is in between.
        const auto = String(headers["auto-submitted"] ?? "").toLowerCase();
        if (auto && auto !== "no") return;
        if (String(headers["precedence"] ?? "").toLowerCase() === "bulk") return;

        const from = addressesFrom(message.fromJson)[0];
        const self: core.MailAddress = {
            name: account.displayName || account.user.name || "",
            address: account.address
        };
        const body = [
            `Forwarded from ${from ? core.addressLabel(from) : "an unnamed sender"}.`,
            "",
            message.bodyText || message.snippet || ""
        ].join("\n");

        const forwarded = await composeMime({
            from: self,
            to: [{ name: "", address: wanted }],
            cc: [],
            bcc: [],
            // Replies go to whoever wrote it, not to the mailbox that passed it
            // on: a forward is a delivery, not a conversation.
            replyTo: from?.address ?? "",
            subject: message.subject.toLowerCase().startsWith("fwd:")
                ? message.subject
                : `Fwd: ${message.subject}`,
            body,
            attachments: [],
            inReplyTo: "",
            references: [],
            requestReceipt: false
        });
        // Stamped after composing, because this is the header the next hop reads
        // to know the message has been round once.
        const stamped = Buffer.concat([
            Buffer.from("X-Polaris-Forwarded: 1\r\n", "utf8"),
            forwarded.mime
        ]);
        await sendMime(
            account,
            {
                from: self,
                to: [{ name: "", address: wanted }],
                cc: [],
                bcc: [],
                replyTo: from?.address ?? "",
                subject: message.subject,
                body,
                attachments: [],
                inReplyTo: "",
                references: [],
                requestReceipt: false
            },
            stamped
        );
    } catch (caught) {
        // The message is already delivered. A forward that could not be sent is
        // not a reason for a sync to stop.
        console.error(caught);
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
    readonly definition: core.MailFilterDefinition;
    readonly position: number;
    readonly matchCount: number;
    /** When it last matched a message, as an ISO string. */
    readonly lastRunAt: string | null;
}

const VIEW_COLUMNS = {
    ...RULE_COLUMNS,
    accountId: true,
    position: true,
    matchCount: true,
    lastRunAt: true
} as const;

function toView(row: {
    id: string;
    name: string;
    enabled: boolean;
    match: string;
    conditions: unknown;
    actions: unknown;
    stop: boolean;
    definition: unknown;
    position: number;
    matchCount: number;
    lastRunAt: Date | null;
}): MailRuleView {
    return {
        ...toRule(row),
        position: row.position,
        matchCount: row.matchCount,
        lastRunAt: row.lastRunAt?.toISOString() ?? null
    };
}

/**
 * The rules of several mailboxes, in one query, by mailbox.
 *
 * For a screen that lists every mailbox's rules: one read rather than one per
 * mailbox. `accountIds` must already be mailboxes this person may read - they
 * come from the same listing that decides which mailboxes the screen shows.
 */
export async function listRulesFor(
    accountIds: readonly string[]
): Promise<Record<string, MailRuleView[]>> {
    const out: Record<string, MailRuleView[]> = Object.fromEntries(
        accountIds.map((id) => [id, []])
    );
    if (accountIds.length === 0) return out;
    const rows = await prisma.mailRule.findMany({
        where: { accountId: { in: [...accountIds] } },
        orderBy: [{ accountId: "asc" }, { position: "asc" }],
        select: VIEW_COLUMNS
    });
    for (const row of rows) out[row.accountId]?.push(toView(row));
    return out;
}

export async function listRules(userId: string, accountId: string): Promise<MailRuleView[]> {
    await ownedAccount(userId, accountId);
    const rows = await prisma.mailRule.findMany({
        where: { accountId },
        orderBy: { position: "asc" },
        select: VIEW_COLUMNS
    });
    return rows.map(toView);
}

/**
 * The addresses a filter may forward to: the ones this person has proved they
 * read. Shown on the form as the choices, and checked again on save and before
 * every forward, because an address can be removed after a filter names it.
 */
export async function forwardTargets(userId: string): Promise<string[]> {
    return (await listUserEmails(userId))
        .filter((entry) => entry.verified)
        .map((entry) => entry.email.toLowerCase());
}

/**
 * Whether everything a filter points at is this person's to point at: a folder
 * on this mailbox, a label of theirs, and a forward to an address they have
 * proved is theirs and that is not a mailbox here (a loop).
 */
async function checkTargets(
    userId: string,
    accountId: string,
    definition: core.MailFilterDefinition
): Promise<void> {
    const steps = definition.actions;
    const folderIds = steps.flatMap((step) => (step.kind === "move" ? [step.folder] : []));
    const labelIds = steps.flatMap((step) => (step.kind === "label" ? [step.label] : []));
    const forwards = steps.flatMap((step) => (step.kind === "forward" ? [step.to] : []));
    if (folderIds.length > 0) {
        const held = await prisma.mailFolder.count({
            where: { id: { in: folderIds }, accountId }
        });
        if (held !== new Set(folderIds).size)
            throw new MailRuleError("That folder is not in that mailbox.");
    }
    if (labelIds.length > 0) {
        const held = await prisma.mailLabel.count({ where: { id: { in: labelIds }, userId } });
        if (held !== new Set(labelIds).size)
            throw new MailRuleError("That label is not one of yours.");
    }
    if (forwards.length > 0) {
        const [verified, mailboxes] = await Promise.all([
            forwardTargets(userId),
            prisma.mailAccount.findMany({ where: { userId }, select: { address: true } })
        ]);
        for (const to of forwards) {
            if (mailboxes.some((one) => core.sameAddress(one.address, to)))
                throw new MailRuleError(
                    "That address is a mailbox here. Forwarding to it would loop."
                );
            if (!verified.some((one) => core.sameAddress(one, to)))
                throw new MailRuleError(
                    "Forward only to an address you have verified on your account."
                );
        }
    }
}

/** What a filter is written as, in both the new column and the old ones. */
function rowData(name: string, enabled: boolean, definition: core.MailFilterDefinition) {
    const legacy = core.mailFilterLegacy(definition);
    return {
        name,
        enabled,
        definition: asJson(definition),
        match: legacy.match,
        conditions: asJson(legacy.conditions),
        actions: asJson(legacy.actions),
        stop: legacy.stop
    };
}

export async function saveRule(
    userId: string,
    accountId: string,
    ruleId: string | null,
    rule: {
        readonly name: string;
        readonly enabled: boolean;
        readonly definition: core.MailFilterDefinition;
        /** Whether it also runs over what is already in the inbox, once. */
        readonly applyToExisting: boolean;
    }
): Promise<string> {
    await ownedAccount(userId, accountId);
    await checkTargets(userId, accountId, rule.definition);
    const data = rowData(rule.name, rule.enabled, rule.definition);

    let id = ruleId;
    if (id) {
        const held = await prisma.mailRule.findFirst({
            where: { id, accountId },
            select: { id: true }
        });
        if (!held) throw new MailRuleError("That rule is not on this mailbox.");
        await prisma.mailRule.update({ where: { id }, data });
    } else {
        const [count, last] = await Promise.all([
            prisma.mailRule.count({ where: { accountId } }),
            prisma.mailRule.findFirst({
                where: { accountId },
                orderBy: { position: "desc" },
                select: { position: true }
            })
        ]);
        if (count >= core.MAIL_FILTER_LIMITS.filters)
            throw new MailRuleError("This mailbox has as many filters as it can hold.");
        const created = await prisma.mailRule.create({
            data: { accountId, ...data, position: (last?.position ?? -1) + 1 },
            select: { id: true }
        });
        id = created.id;
    }
    await recordAudit({
        actorId: userId,
        action: ruleId ? "mail.filter.update" : "mail.filter.create",
        targetType: "mail-filter",
        targetId: id,
        // The switch only: the name can be a subject or an address, and what it
        // matches on can quote somebody's correspondence, so both stay out.
        metadata: { accountId, enabled: rule.enabled }
    });

    // Running a new rule over what is already there is what somebody expects
    // from "and do this to the ones I already have", and it is the reason the
    // checkbox exists. Behind the response, because it can move thousands of
    // messages and nobody should watch a spinner for it. Only this rule: running
    // every rule again would do again what the others already did. Its forward
    // steps are left out of that run (see `applyRuleToInbox`).
    if (rule.applyToExisting) runOverInbox(accountId, id);
    return id;
}

/** The filters being run over an inbox right now, so a second click waits for
 *  the first run instead of doing everything again alongside it. */
const inboxRuns = new Set<string>();

/** Start a run of one filter over the inbox, behind the caller. */
function runOverInbox(accountId: string, ruleId: string): void {
    if (inboxRuns.has(ruleId)) return;
    inboxRuns.add(ruleId);
    void applyRuleToInbox(accountId, ruleId)
        .catch((caught) => console.error(caught))
        .finally(() => inboxRuns.delete(ruleId));
}

/** Run a saved filter over the mail already in the inbox, from the list's own
 *  button rather than a save. */
export async function runRuleOverInbox(
    userId: string,
    accountId: string,
    ruleId: string
): Promise<void> {
    await ownedAccount(userId, accountId);
    const held = await prisma.mailRule.findFirst({
        where: { id: ruleId, accountId },
        select: { id: true }
    });
    if (!held) throw new MailRuleError("That rule is not on this mailbox.");
    runOverInbox(accountId, ruleId);
}

/** Switch a filter on or off without opening it. */
export async function setRuleEnabled(
    userId: string,
    accountId: string,
    ruleId: string,
    enabled: boolean
): Promise<void> {
    await ownedAccount(userId, accountId);
    const changed = await prisma.mailRule.updateMany({
        where: { id: ruleId, accountId },
        data: { enabled }
    });
    if (changed.count === 0) throw new MailRuleError("That rule is not on this mailbox.");
    await recordAudit({
        actorId: userId,
        action: enabled ? "mail.filter.enable" : "mail.filter.disable",
        targetType: "mail-filter",
        targetId: ruleId,
        metadata: { accountId }
    });
}

/**
 * A copy of a filter, placed right below it and switched off, so a copy made to
 * try a variation never runs twice over the same mail before it is changed.
 */
export async function duplicateRule(
    userId: string,
    accountId: string,
    ruleId: string,
    name: string
): Promise<string> {
    await ownedAccount(userId, accountId);
    const row = await prisma.mailRule.findFirst({
        where: { id: ruleId, accountId },
        select: { ...RULE_COLUMNS, position: true }
    });
    if (!row) throw new MailRuleError("That rule is not on this mailbox.");
    const count = await prisma.mailRule.count({ where: { accountId } });
    if (count >= core.MAIL_FILTER_LIMITS.filters)
        throw new MailRuleError("This mailbox has as many filters as it can hold.");
    const id = await prisma.$transaction(async (tx) => {
        await tx.mailRule.updateMany({
            where: { accountId, position: { gt: row.position } },
            data: { position: { increment: 1 } }
        });
        const created = await tx.mailRule.create({
            data: {
                accountId,
                ...rowData(name, false, definitionOf(row)),
                position: row.position + 1
            },
            select: { id: true }
        });
        return created.id;
    });
    await recordAudit({
        actorId: userId,
        action: "mail.filter.create",
        targetType: "mail-filter",
        targetId: id,
        metadata: { accountId, copyOf: ruleId }
    });
    return id;
}

/** How many inbox messages a rule is run over when it is saved with "and the
 *  ones already here", and how many are read at a time. */
const EXISTING_LIMIT = 5000;
const EXISTING_PAGE = 250;

/**
 * Run one rule over what is already in the inbox, newest first, without its
 * forward steps.
 *
 * Read a page at a time with only the columns a rule looks at, matched in
 * memory, and acted on only where it matched - so a rule that matches ten
 * messages out of five thousand costs twenty reads, not five thousand. Bounded,
 * because it moves mail and a runaway pass is worse than an unfinished one.
 */
export async function applyRuleToInbox(
    accountId: string,
    ruleId: string,
    limit = EXISTING_LIMIT
): Promise<number> {
    const row = await prisma.mailRule.findFirst({
        where: { id: ruleId, accountId },
        select: RULE_COLUMNS
    });
    if (!row) return 0;
    const rule = toRule(row);
    // Never forwarded: mail already here has had its chance to be sent on when it
    // arrived, and a run that can be started again would send it again each time.
    const actions = core
        .mailFilterActions(rule.definition)
        .filter((action) => action.kind !== "forward");
    if (actions.length === 0) return 0;
    // The inbox by id, so the pages below walk the folder's own sent-date index.
    const inbox = (
        await prisma.mailFolder.findMany({
            where: { accountId, role: "inbox" },
            select: { id: true }
        })
    ).map((folder) => folder.id);
    if (inbox.length === 0) return 0;
    let matched = 0;
    let cursor: string | undefined;
    for (let read = 0; read < limit; read += EXISTING_PAGE) {
        const page = await prisma.mailMessage.findMany({
            where: { folderId: { in: inbox } },
            select: { id: true, ...SUBJECT_COLUMNS },
            orderBy: [{ sentAt: "desc" }, { id: "desc" }],
            take: Math.min(EXISTING_PAGE, limit - read),
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        if (page.length === 0) break;
        cursor = page.at(-1)!.id;
        for (const message of page) {
            // Whether it is switched on is not asked: this run was asked for.
            if (!core.mailFilterMatches(rule.definition, asSubject(message), timedPatternTest))
                continue;
            await performActions(accountId, message.id, actions).catch((caught) =>
                console.error(caught)
            );
            matched += 1;
        }
        if (page.length < EXISTING_PAGE) break;
    }
    if (matched > 0) {
        await prisma.mailRule.update({
            where: { id: rule.id },
            data: { matchCount: { increment: matched }, lastRunAt: new Date() }
        });
    }
    return matched;
}

export async function deleteRule(userId: string, accountId: string, ruleId: string): Promise<void> {
    await ownedAccount(userId, accountId);
    const removed = await prisma.mailRule.deleteMany({ where: { id: ruleId, accountId } });
    if (removed.count === 0) return;
    await recordAudit({
        actorId: userId,
        action: "mail.filter.delete",
        targetType: "mail-filter",
        targetId: ruleId,
        metadata: { accountId }
    });
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
        (await prisma.mailRule.findMany({ where: { accountId }, select: { id: true } })).map(
            (row) => row.id
        )
    );
    await prisma.$transaction(
        orderedIds
            .filter((id) => mine.has(id))
            .map((id, index) =>
                prisma.mailRule.update({ where: { id }, data: { position: index } })
            )
    );
    await recordAudit({
        actorId: userId,
        action: "mail.filter.reorder",
        targetType: "mail-account",
        targetId: accountId
    });
}
