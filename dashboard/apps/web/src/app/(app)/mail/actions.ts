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

import { z } from "zod";
import * as core from "@polaris/core";
import * as spam from "@/lib/mailbox/spam";
import { revalidatePath } from "next/cache";
import * as rules from "@/lib/mailbox/rules";
import * as prefs from "@/lib/mailbox/prefs";
import * as labels from "@/lib/mailbox/labels";
import * as compose from "@/lib/mailbox/compose";
import * as reading from "@/lib/mailbox/reading";
import { syncAccount } from "@/lib/mailbox/sync";
import { requirePermission } from "@/lib/session";
import * as blocking from "@/lib/mailbox/blocking";
import * as accounts from "@/lib/mailbox/accounts";
import * as mailImport from "@/lib/mailbox/import";
import * as mailExport from "@/lib/mailbox/export";
import * as folders from "@/lib/mailbox/folders";
import * as messages from "@/lib/mailbox/messages";
import { emptyEveryFolderOfRole } from "@/lib/mailbox/trash";
import * as contacts from "@/lib/mailbox/contacts";
import * as templates from "@/lib/mailbox/templates";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import * as attachFrom from "@/lib/mailbox/attach-from";
import { MailAuthError } from "@/lib/mailbox/credentials";
import { discoverMailbox } from "@/lib/mailbox/autoconfig";
import * as subscriptions from "@/lib/mailbox/subscriptions";
import { MailFolderRoleMissing } from "@/lib/mailbox/messages";
import { MailAccessError, ownedAccount, ownedAccountIds } from "@/lib/mailbox/access";

const MAIL_PATH = "/mail";

async function actorId(): Promise<string> {
    return (await requirePermission("mail.use")).id;
}

/** What a refusal looks like on the way out. Anything that is not one of the
 *  three the caller could act on is a fault rather than an answer, and is logged
 *  rather than described. */
function failure(
    caught: unknown,
    fallback: string
): { error: string; field?: string; needsFolderRole?: { role: string; accountId: string } } {
    // The one refusal a screen answers with a question rather than a sentence:
    // this mailbox has no folder for what was asked, and its owner can say which
    // of theirs it is. Carried out structured so the dialog knows what to ask.
    if (caught instanceof MailFolderRoleMissing) {
        return {
            error: caught.message,
            needsFolderRole: { role: caught.role, accountId: caught.accountId }
        };
    }
    if (caught instanceof MailAccessError) return { error: caught.message };
    if (caught instanceof accounts.MailSetupError)
        return { error: caught.message, field: caught.field };
    if (caught instanceof MailAuthError) return { error: caught.message };
    if (caught instanceof labels.MailLabelNameTaken) return { error: caught.message };
    if (caught instanceof folders.MailFolderError) return { error: caught.message };
    if (caught instanceof templates.MailTemplateNameTaken) return { error: caught.message, field: "name" };
    if (caught instanceof subscriptions.MailSubscriptionMissing) return { error: caught.message };
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
        return {
            error: issue?.message ?? "Check the details.",
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        // On whichever shelf they are working from: connecting a mailbox while
        // the header says a company is connecting it for that company's work,
        // and it appears there rather than beside their own.
        const account = await accounts.addAccount(userId, parsed.data, await scopeOrgIdFor(userId));
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That mailbox could not be added.");
    }
}

/* -------------------------------------------------------------------------- */
/* Bringing an archive in                                                       */
/* -------------------------------------------------------------------------- */

/** How many messages are in an uploaded archive, and where they would go. */
export async function openImportAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailImportSchema.safeParse(input);
    if (!parsed.success) return { error: "That file could not be read." };
    try {
        return await mailImport.openImport(userId, parsed.data);
    } catch (caught) {
        return failure(caught, "That file could not be read.");
    }
}

/**
 * Append one slice of it.
 *
 * Driven from the screen a batch at a time rather than run to completion here:
 * four thousand appends over one connection is minutes, which is far longer than
 * a request should live and exactly the shape of thing that fails near the end
 * with nothing to show for it.
 */
export async function importBatchAction(input: unknown, from: unknown) {
    const userId = await actorId();
    const parsed = core.mailImportSchema.safeParse(input);
    // Where the slice starts is as much a request as the ids beside it: a batch
    // that started at `NaN` appended nothing and answered that the import had
    // finished, which is the one failure an import must not have.
    const at = core.mailImportFromSchema.safeParse(from);
    if (!parsed.success || !at.success) return { error: "That batch could not be imported." };
    try {
        const answer = await mailImport.importBatch(userId, parsed.data, at.data);
        // The folder is only re-read when the last batch lands: a sync between
        // every twenty-five messages would cost more than the import.
        if (answer.next >= answer.total) {
            await syncAccount(parsed.data.accountId).catch(() => undefined);
            refresh();
        }
        return answer;
    } catch (caught) {
        return failure(caught, "That batch could not be imported.");
    }
}

/** How many messages an export would carry, so the screen can say so before
 *  somebody starts a download of a mailbox that takes a while. */
export async function exportSizeAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailExportScopeSchema.safeParse(input);
    if (!parsed.success) return { error: "That mailbox could not be counted." };
    try {
        return { count: await mailExport.exportSize(userId, parsed.data) };
    } catch (caught) {
        return failure(caught, "That mailbox could not be counted.");
    }
}

/** Give a folder a colour, or take one off. Polaris' own: a mail server has no
 *  notion of it, so nothing is told about this but us. */
export async function setFolderColorAction(folderId: string, color: string) {
    const userId = await actorId();
    try {
        await messages.setFolderColor(userId, folderId, color);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That colour could not be saved.");
    }
}

/**
 * Rename a folder, on the mail server as well as here.
 *
 * Everything under it comes with it, which is what IMAP does and what the rows
 * are rewritten to match - see `folders.ts`.
 */
export async function renameFolderAction(folderId: unknown, name: unknown) {
    const userId = await actorId();
    const id = z.string().uuid().safeParse(folderId);
    const wanted = z.string().min(1).max(100).safeParse(name);
    if (!id.success) return { error: "That folder is not here." };
    if (!wanted.success) return { error: "A folder needs a name." };
    try {
        await folders.renameFolder(userId, id.data, wanted.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That folder could not be renamed.");
    }
}

/**
 * Delete a folder and the mail in it.
 *
 * The one thing in Mail that destroys something Polaris does not hold a copy of,
 * which is why the screen that asks says so in those words.
 */
export async function deleteFolderAction(folderId: unknown) {
    const userId = await actorId();
    const id = z.string().uuid().safeParse(folderId);
    if (!id.success) return { error: "That folder is not here." };
    try {
        await folders.deleteFolder(userId, id.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That folder could not be deleted.");
    }
}

/** Turn Polaris' own junk filter on or off for one mailbox. */
export async function setSpamFilterAction(accountId: string, on: boolean) {
    const userId = await actorId();
    try {
        const account = await accounts.setSpamFilter(userId, accountId, on);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That could not be changed.");
    }
}

/** Throw away everything one mailbox's filter has been taught. */
export async function forgetSpamAction(accountId: string) {
    const userId = await actorId();
    try {
        await ownedAccount(userId, accountId);
        await spam.forgetSpamLearning(accountId);
        refresh();
        return { learning: await spam.spamLearning(accountId) };
    } catch (caught) {
        return failure(caught, "That could not be forgotten.");
    }
}

export async function editAccountAction(accountId: string, input: unknown) {
    const userId = await actorId();
    // A patch: only what the screen sent is written, so one switch never puts
    // every other setting back to its default.
    const parsed = core.mailAccountPatchSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
    try {
        const account = await accounts.editAccount(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That could not be saved.");
    }
}

/**
 * Change how a mailbox connects - servers, login, password, authorization - and
 * what it is called. Both servers are tried before anything is stored, so the
 * refusal comes back on the form with the field it is about.
 */
export async function updateAccountAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAccountUpdateSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: issue?.message ?? "Check the details.",
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const account = await accounts.updateAccount(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "That mailbox could not be saved.");
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
        return {
            error: issue?.message ?? "Check the details.",
            field: String(issue?.path[0] ?? "")
        };
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

/** Ask a mailbox for anything new, now. What the refresh button does - and the
 *  one try a refused mailbox gets before its backoff is up, because a person
 *  pressed it rather than a timer. */
export async function syncAccountAction(accountId: string) {
    const userId = await actorId();
    try {
        await ownedAccount(userId, accountId);
        await syncAccount(accountId, { force: true });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That mailbox could not be checked.");
    }
}

/** Every mailbox at once, for the refresh on the unified view. */
export async function syncAllAction() {
    const userId = await actorId();
    // The shelf being looked at, because this is the refresh button on a rail:
    // it syncs what is in front of somebody, not every mailbox they have.
    const ids = await ownedAccountIds(userId, await scopeOrgIdFor(userId));
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
        const done = await messages.actOnMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.action,
            { scope: parsed.data.scope }
        );
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "The mail server did not accept that.");
    }
}

/** Pin a conversation to the top of every list, or mute it - or undo either.
 *  Polaris' own: nothing is sent to the mail server. */
export async function setConversationStateAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailConversationStateSchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing was selected." };
    try {
        const done = await messages.setConversationState(userId, parsed.data.messageIds, {
            pinned: parsed.data.pinned,
            muted: parsed.data.muted
        });
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "That could not be changed.");
    }
}

export async function moveAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailMoveSchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing was selected." };
    try {
        const done = await messages.moveMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.folderId
        );
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "The mail server did not accept that.");
    }
}

/**
 * Throw away everything in the trash - or in the spam folder.
 *
 * The whole folder on the server rather than the page of it Polaris holds, so
 * the screen can honestly say the mailbox is empty afterwards. Named by mailbox
 * so the merged view empties every mailbox it is showing and a single mailbox
 * empties only its own.
 */
export async function emptyFolderAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailEmptyFolderSchema.safeParse(input);
    if (!parsed.success) return { error: "Say which folder to empty." };
    try {
        const done = await emptyEveryFolderOfRole(
            userId,
            parsed.data.role,
            parsed.data.accountIds
        );
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
        const done = await messages.snoozeMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.until
        );
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
        const readable = await reading.readableMessage(
            message.accountId,
            messageId,
            userId,
            message.policy,
            {
                ...message.row,
                bodyHtml: body.html || message.row.bodyHtml,
                bodyText: body.text || message.row.bodyText
            }
        );
        return { readable, envelope: message.envelope };
    } catch (caught) {
        return failure(caught, "That message could not be opened.");
    }
}

/**
 * Fetch a message's body and keep it, without reading it.
 *
 * Opening a message that has never been opened is a round trip to somebody
 * else's IMAP server: a connection, a mailbox lock, the body structure, then the
 * parts. That is why Polaris felt slower to open mail than a webmail that holds
 * everything itself - and it is all avoidable, because by the time somebody
 * clicks a row they have usually been pointing at it for a moment first.
 *
 * So the pointer resting on a conversation is enough to go and get it. Nothing
 * comes back: the body lands in the row it belongs to, and the open that follows
 * finds it already there. Cheap to call on a message that is already held - it is
 * one indexed read and returns - and silent when it fails, because a prefetch
 * that raised an error would be an error about something nobody asked for.
 */
export async function warmMessageAction(messageId: string): Promise<void> {
    try {
        const userId = await actorId();
        await messages.loadBody(userId, messageId);
    } catch {
        // Never surfaced. Whatever went wrong will go wrong again, visibly, if
        // they actually open it.
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

/**
 * Say which of this mailbox's folders is its Trash, Archive or Junk.
 *
 * Asked once, when an action finds the mailbox has none under a name Polaris
 * recognises. The answer sticks through every later sync.
 */
export async function setFolderRoleAction(folderId: string, role: string) {
    const userId = await actorId();
    const wanted = core.MAIL_FOLDER_ROLES.find((one) => one === role);
    if (!wanted) return { error: "That is not a folder role." };
    try {
        await messages.setFolderRole(userId, folderId, wanted);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That could not be saved.");
    }
}

/** Make the folder, on the mail server, because its owner asked for one. The
 *  only path in the app that writes a folder into somebody else's mailbox. */
export async function createFolderForRoleAction(accountId: string, role: string) {
    const userId = await actorId();
    const wanted = core.MAIL_FOLDER_ROLES.find((one) => one === role);
    if (!wanted) return { error: "That is not a folder role." };
    try {
        const id = await messages.createFolderForRole(userId, accountId, wanted);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That folder could not be made on the mail server.");
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
        return {
            error: issue?.message ?? "Check the message.",
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const queued = await compose.queueSend(userId, composeInput(parsed.data));
        refresh();
        return { draftId: queued.draftId, sendAt: queued.sendAt.toISOString() };
    } catch (caught) {
        return failure(caught, "That message could not be sent.");
    }
}

/**
 * Leave a copy of an unsent draft in the mail server's Drafts folder, so it can
 * be finished in another client. Called when the composer closes. Never refuses
 * anybody: the draft is safe here whether or not the copy could be written.
 */
export async function fileDraftOnServerAction(draftId: string) {
    const userId = await actorId();
    const parsed = core.mailDraftIdSchema.safeParse(draftId);
    if (!parsed.success) return {};
    await compose.fileDraftOnServer(userId, parsed.data);
    return {};
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
    // The people this shelf writes to. A company address suggesting a personal
    // contact is the wrong recipient offered on the wrong letterhead.
    const accountIds = await ownedAccountIds(userId, await scopeOrgIdFor(userId));
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

/**
 * How this person wants Mail to behave.
 *
 * The whole shape at once rather than a field at a time: it is one form with a
 * Save under it, and a screen that wrote each control as it was touched would
 * leave somebody who changed their mind halfway with half of it applied.
 */
export async function setMailPreferencesAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailPreferencesSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: issue?.message ?? "Check the details.",
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        // The reading form does not carry the keyboard, and saving it must not
        // quietly put every moved shortcut back where it started.
        const current = await prefs.readMailPreferences(userId);
        await prefs.saveMailPreferences(userId, {
            ...parsed.data,
            keys: parsed.data.keys ?? current.keys
        });
        refresh();
        return { saved: true };
    } catch (caught) {
        return failure(caught, "That could not be saved.");
    }
}

/**
 * Move Mail's shortcuts.
 *
 * The whole keyboard at once, and refused whole when two commands would share a
 * key - the message names both, so the screen can say which binding is in the
 * way rather than storing one that would archive when somebody meant to mute.
 */
export async function setMailKeysAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailKeymapSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: issue?.message ?? "Those shortcuts could not be saved.",
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const current = await prefs.readMailPreferences(userId);
        await prefs.saveMailPreferences(userId, { ...current, keys: parsed.data });
        refresh();
        return { keys: parsed.data };
    } catch (caught) {
        return failure(caught, "Those shortcuts could not be saved.");
    }
}

/** Every template this person has, for the composer's menu and the settings
 *  screen. Read when the menu opens rather than with the page, because most
 *  messages are written without one. */
export async function listTemplatesAction() {
    const userId = await actorId();
    return { templates: await templates.listTemplates(userId) };
}

export async function saveTemplateAction(templateId: string | null, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailTemplateSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: issue?.message ?? "Check the template.",
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const id = await templates.saveTemplate(userId, templateId, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That template could not be saved.");
    }
}

export async function deleteTemplateAction(templateId: string) {
    const userId = await actorId();
    try {
        await templates.deleteTemplate(userId, templateId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That template could not be removed.");
    }
}

export async function saveIdentityAction(
    accountId: string,
    identityId: string | null,
    input: unknown
) {
    const userId = await actorId();
    const parsed = core.mailIdentitySchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: issue?.message ?? "Check the details.",
            field: String(issue?.path[0] ?? "")
        };
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

/**
 * Attach a file that is already on a storage Polaris can reach.
 *
 * The bytes never leave the server: the alternative is somebody downloading
 * their own file out of their own Drive so they can upload it again.
 */
export async function attachFromDriveAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAttachFromDriveSchema.safeParse(input);
    if (!parsed.success) return { error: "That file could not be attached." };
    try {
        const upload = await attachFrom.attachFromDrive(
            userId,
            parsed.data.connectionId,
            parsed.data.path
        );
        return { upload };
    } catch (caught) {
        if (caught instanceof attachFrom.AttachRefused) return { error: caught.message };
        return failure(caught, "That file could not be attached.");
    }
}

/** Attach a file at an address somebody pasted. Fetched by Polaris, through the
 *  same guard every person-supplied address goes through. */
export async function attachFromAddressAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAttachFromAddressSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not an address Polaris can fetch." };
    try {
        const upload = await attachFrom.attachFromAddress(userId, parsed.data.url);
        return { upload };
    } catch (caught) {
        if (caught instanceof attachFrom.AttachRefused) return { error: caught.message };
        return failure(caught, "That file could not be attached.");
    }
}

/** Carry the files of the message being forwarded onto the forward. Answers the
 *  ones it carried and names the ones it could not. */
export async function attachFromMessageAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAttachFromMessageSchema.safeParse(input);
    if (!parsed.success) return { error: "Those files could not be carried over." };
    try {
        return await attachFrom.attachFromMessage(userId, parsed.data.messageId);
    } catch (caught) {
        return failure(caught, "Those files could not be carried over.");
    }
}

/**
 * Refuse a sender.
 *
 * There is no such thing at the protocol level - a message is delivered to the
 * mailbox long before any client sees it - so this is the nearest honest thing:
 * a rule that sends everything from that address straight to the trash, and
 * clears out what they have already sent.
 */
export async function blockSenderAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailBlockSenderSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not an email address." };
    try {
        await ownedAccount(userId, accountId);
        await blocking.blockSender(userId, accountId, parsed.data.address, parsed.data.as);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That sender could not be blocked.");
    }
}

/** Take a block off. What was already thrown away stays in the trash, where it
 *  can be fetched back by hand. */
export async function unblockSenderAction(accountId: string, ruleId: string) {
    const userId = await actorId();
    try {
        await ownedAccount(userId, accountId);
        await blocking.unblockSender(userId, accountId, ruleId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That block could not be removed.");
    }
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Get off a list, from the screen that lists them.
 *
 * The outcome is returned rather than swallowed because the three ways out end
 * differently: a one-click POST and a sent message are done, and a plain link is
 * a page the browser has to open - so the caller is told which happened and,
 * where there is one, the address to open.
 */
export async function unsubscribeAction(subscriptionId: string) {
    const userId = await actorId();
    try {
        const outcome = await subscriptions.unsubscribeFromSender(userId, subscriptionId);
        refresh();
        return { outcome };
    } catch (caught) {
        return failure(caught, "That unsubscribe could not be sent.");
    }
}

/** The same, from the message somebody is reading. Works on mail that arrived
 *  before any of this existed: the offer is read off the message rather than
 *  looked up, and the sender joins the subscriptions screen on the way through. */
export async function unsubscribeFromMessageAction(messageId: string) {
    const userId = await actorId();
    try {
        const outcome = await subscriptions.unsubscribeFromMessage(userId, messageId);
        refresh();
        return { outcome };
    } catch (caught) {
        return failure(caught, "That unsubscribe could not be sent.");
    }
}

/** Throw a half-written message away. Nothing was sent, so there is nothing to
 *  take back. */
export async function discardDraftAction(draftId: string) {
    const userId = await actorId();
    try {
        await compose.discardDraft(userId, draftId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That draft could not be removed.");
    }
}

/** Put messages in a folder, for the drag onto the rail and the Move to menu. */
export async function moveToFolderAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailMoveSchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing was moved." };
    try {
        const done = await messages.moveMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.folderId
        );
        refresh();
        return { done };
    } catch (caught) {
        return failure(caught, "Those could not be moved.");
    }
}
