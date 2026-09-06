"use server";

/**
 * Everything the Mail screens write.
 *
 * All of them do the same three things in the same order: resolve the caller and
 * the instance permission, narrow to what that person owns, then validate the
 * shape. Authorization before validation, because a schema error about a mailbox
 * somebody cannot reach would still tell them the mailbox exists.
 *
 * Refusals are returned, never thrown. A thrown server action replaces the
 * screen with an error page, and none of these is worth losing a half-written
 * message over - so the sentence comes back and the composer or the form shows
 * it where it happened.
 *
 * Nothing in this file describes an internal failure to the reader. A mail
 * server's own words name hosts, ports and paths, and the two failures somebody
 * can act on - the credential was refused, the server could not be reached -
 * already have sentences of their own.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as rules from "@/lib/mailbox/rules";
import * as labels from "@/lib/mailbox/labels";
import * as compose from "@/lib/mailbox/compose";
import * as reading from "@/lib/mailbox/reading";
import { syncAccount } from "@/lib/mailbox/sync";
import { requirePermission } from "@/lib/session";
import * as accounts from "@/lib/mailbox/accounts";
import * as messages from "@/lib/mailbox/messages";
import * as contacts from "@/lib/mailbox/contacts";
import { MailAuthError } from "@/lib/mailbox/credentials";
import { discoverMailbox } from "@/lib/mailbox/autoconfig";
import { MailAccessError, ownedAccount, ownedAccountIds } from "@/lib/mailbox/access";

const MAIL_PATH = "/mail";

async function actorId(): Promise<string> {
    return (await requirePermission("mail.use")).id;
}

/** What a refusal looks like on the way out. Anything that is not one of the
 *  three the caller could act on is a fault rather than an answer, and is logged
 *  rather than described. */
function failure(caught: unknown, fallback: string): { error: string; field?: string } {
    if (caught instanceof MailAccessError) return { error: caught.message };
    if (caught instanceof accounts.MailSetupError) return { error: caught.message, field: caught.field };
    if (caught instanceof MailAuthError) return { error: caught.message };
    if (caught instanceof labels.MailLabelNameTaken) return { error: caught.message };
    console.error("polaris: a mail action failed:", caught);
    return { error: fallback };
}

function refresh(): void {
    revalidatePath(MAIL_PATH, "layout");
}

/* -------------------------------------------------------------------------- */
/* Mailboxes                                                                   */
/* -------------------------------------------------------------------------- */

/** Ask Polaris where an address's mail lives, before any password is typed. */
export async function discoverAction(formData: FormData) {
    await actorId();
    const parsed = core.mailDiscoverySchema.safeParse({ address: formData.get("address") });
    if (!parsed.success) return { error: "That is not an email address." };
    try {
        return { discovery: await discoverMailbox(parsed.data.address) };
    } catch {
        // Discovery never being able to fail is the point: a domain that answers
        // nothing still gets a form, filled in with the conventional guesses.
        return { discovery: await discoverMailbox(parsed.data.address).catch(() => null) };
    }
}

export async function addAccountAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAccountSetupSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: issue?.message ?? "Check the details.", field: String(issue?.path[0] ?? "") };
    }
    try {
        const account = await accounts.addAccount(userId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That mailbox could not be added.");
    }
}

export async function editAccountAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAccountEditSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
    try {
        const account = await accounts.editAccount(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That could not be saved.");
    }
}

export async function setPrivacyAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailPrivacySchema.safeParse(input);
    if (!parsed.success) return { error: "Check the details." };
    try {
        const account = await accounts.setAccountPrivacy(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That could not be saved.");
    }
}

export async function setVacationAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailVacationSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: issue?.message ?? "Check the details.", field: String(issue?.path[0] ?? "") };
    }
    try {
        const account = await accounts.setVacation(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That could not be saved.");
    }
}

export async function removeAccountAction(accountId: string) {
    const userId = await actorId();
    try {
        await accounts.removeAccount(userId, accountId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That mailbox could not be removed.");
    }
}

/** Ask a mailbox for anything new, now. What the refresh button does. */
export async function syncAccountAction(accountId: string) {
    const userId = await actorId();
    try {
        await ownedAccount(userId, accountId);
        await syncAccount(accountId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That mailbox could not be checked.");
    }
}

/** Every mailbox at once, for the refresh on the unified view. */
export async function syncAllAction() {
    const userId = await actorId();
    const ids = await ownedAccountIds(userId);
    for (const id of ids) await syncAccount(id).catch(() => undefined);
    refresh();
    return {};
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export async function actOnAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailActionSchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing was selected." };
    try {
        const done = await messages.actOnMessages(userId, parsed.data.messageIds, parsed.data.action);
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "The mail server did not accept that.");
    }
}

export async function moveAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailMoveSchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing was selected." };
    try {
        const done = await messages.moveMessages(userId, parsed.data.messageIds, parsed.data.folderId);
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "The mail server did not accept that.");
    }
}

export async function snoozeAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailSnoozeSchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing was selected." };
    try {
        const done = await messages.snoozeMessages(userId, parsed.data.messageIds, parsed.data.until);
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "That could not be put off.");
    }
}

/** The body of one message, fetched from the server the first time. */
export async function openMessageAction(messageId: string) {
    const userId = await actorId();
    try {
        const body = await messages.loadBody(userId, messageId);
        const message = await messages.messageForReading(userId, messageId);
        if (!message) return { error: "That message is no longer here." };
        const readable = await reading.readableMessage(message.accountId, message.policy, {
            ...message.row,
            bodyHtml: body.html || message.row.bodyHtml,
            bodyText: body.text || message.row.bodyText
        });
        return { readable };
    } catch (caught) {
        return failure(caught, "That message could not be opened.");
    }
}

/** Let one sender's pictures through from now on, or take that back. */
export async function trustSenderAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailTrustSenderSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not an email address." };
    try {
        await ownedAccount(userId, accountId);
        await reading.trustSender(accountId, parsed.data.address, parsed.data.trusted);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That could not be saved.");
    }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

function composeInput(parsed: core.MailCompose): compose.ComposeInput {
    return {
        accountId: parsed.accountId,
        identityId: parsed.identityId,
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.replyTo,
        subject: parsed.subject,
        body: parsed.body,
        attachmentIds: parsed.attachmentIds,
        inReplyToId: parsed.inReplyToId,
        forward: parsed.forward,
        sendAt: parsed.sendAt,
        requestReceipt: parsed.requestReceipt,
        draftId: parsed.draftId
    };
}

export async function saveDraftAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailDraftSchema.safeParse(input);
    if (!parsed.success) return { error: "That draft could not be saved." };
    try {
        const draftId = await compose.saveDraft(userId, {
            accountId: parsed.data.accountId,
            identityId: parsed.data.identityId,
            to: parsed.data.to,
            cc: parsed.data.cc,
            bcc: parsed.data.bcc,
            replyTo: parsed.data.replyTo,
            subject: parsed.data.subject,
            body: parsed.data.body,
            attachmentIds: parsed.data.attachmentIds,
            inReplyToId: parsed.data.inReplyToId,
            forward: parsed.data.forward,
            sendAt: parsed.data.sendAt,
            requestReceipt: parsed.data.requestReceipt,
            draftId: parsed.data.id
        });
        return { draftId };
    } catch (caught) {
        return failure(caught, "That draft could not be saved.");
    }
}

export async function sendAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailComposeSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: issue?.message ?? "Check the message.", field: String(issue?.path[0] ?? "") };
    }
    try {
        const queued = await compose.queueSend(userId, composeInput(parsed.data));
        refresh();
        return { draftId: queued.draftId, sendAt: queued.sendAt.toISOString() };
    } catch (caught) {
        return failure(caught, "That message could not be sent.");
    }
}

/** Take a message back out of the queue. Only works while it is still in it. */
export async function undoSendAction(draftId: string) {
    const userId = await actorId();
    try {
        const undone = await compose.cancelSend(userId, draftId);
        refresh();
        return { undone };
    } catch (caught) {
        return failure(caught, "That message has already gone.");
    }
}

/** Who to offer as somebody types a recipient. */
export async function suggestContactsAction(query: string) {
    const userId = await actorId();
    const accountIds = await ownedAccountIds(userId);
    return { suggestions: await contacts.suggestContacts(accountIds, query) };
}

/* -------------------------------------------------------------------------- */
/* Labels, identities and filters                                              */
/* -------------------------------------------------------------------------- */

export async function createLabelAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailLabelSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the name." };
    try {
        const id = await labels.createLabel(userId, parsed.data.name, parsed.data.color);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That label could not be made.");
    }
}

export async function renameLabelAction(labelId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailLabelSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the name." };
    try {
        await labels.renameLabel(userId, labelId, parsed.data.name, parsed.data.color);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That label could not be changed.");
    }
}

export async function deleteLabelAction(labelId: string) {
    const userId = await actorId();
    await labels.deleteLabel(userId, labelId);
    refresh();
    return {};
}

export async function applyLabelAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailLabelApplySchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing was selected." };
    try {
        const done = await labels.applyLabel(
            userId,
            parsed.data.labelId,
            parsed.data.messageIds,
            parsed.data.applied
        );
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "That label could not be applied.");
    }
}

export async function saveIdentityAction(accountId: string, identityId: string | null, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailIdentitySchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: issue?.message ?? "Check the details.", field: String(issue?.path[0] ?? "") };
    }
    try {
        const id = await labels.saveIdentity(userId, accountId, identityId, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That address could not be saved.");
    }
}

export async function deleteIdentityAction(accountId: string, identityId: string) {
    const userId = await actorId();
    try {
        await labels.deleteIdentity(userId, accountId, identityId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That address could not be removed.");
    }
}

export async function saveRuleAction(accountId: string, ruleId: string | null, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailRuleSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: issue?.message ?? "Check the rule.", field: String(issue?.path[0] ?? "") };
    }
    try {
        const id = await rules.saveRule(userId, accountId, ruleId, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That rule could not be saved.");
    }
}

export async function deleteRuleAction(accountId: string, ruleId: string) {
    const userId = await actorId();
    try {
        await rules.deleteRule(userId, accountId, ruleId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That rule could not be removed.");
    }
}

export async function reorderRulesAction(accountId: string, orderedIds: string[]) {
    const userId = await actorId();
    try {
        await rules.reorderRules(userId, accountId, orderedIds);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That order could not be saved.");
    }
}
