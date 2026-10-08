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
import * as shortcuts from "@/lib/shortcuts-service";
import * as labels from "@/lib/mailbox/labels";
import * as compose from "@/lib/mailbox/compose";
import * as reading from "@/lib/mailbox/reading";
import { syncAccount } from "@/lib/mailbox/sync";
import * as folders from "@/lib/mailbox/folders";
import { isUuid } from "@/lib/uuid";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import { mailRefusalText } from "@/lib/mailbox/refusal-text";
import * as blocking from "@/lib/mailbox/blocking";
import * as accounts from "@/lib/mailbox/accounts";
import * as mailImport from "@/lib/mailbox/import";
import * as mailExport from "@/lib/mailbox/export";
import * as messages from "@/lib/mailbox/messages";
import * as contacts from "@/lib/mailbox/contacts";
import { mailShelfFor } from "@/lib/mailbox/shelf";
import * as templates from "@/lib/mailbox/templates";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import * as attachFrom from "@/lib/mailbox/attach-from";
import { MailAuthError } from "@/lib/mailbox/credentials";
import { discoverMailbox } from "@/lib/mailbox/autoconfig";
import { emptyEveryFolderOfRole } from "@/lib/mailbox/trash";
import * as subscriptions from "@/lib/mailbox/subscriptions";
import { MailFolderRoleMissing } from "@/lib/mailbox/messages";
import { MailAccessError, ownedAccount, ownedAccountIds } from "@/lib/mailbox/access";

const MAIL_PATH = "/mail";

type MailErrorKey = Extract<NamespaceKey<"mail">, `errors.${string}`>;

async function actorId(): Promise<string> {
    return (await requirePermission("mail.use")).id;
}

/** What a refusal looks like on the way out. Anything that is not one of the
 *  three the caller could act on is a fault rather than an answer, and is logged
 *  rather than described. */
async function failure(
    caught: unknown,
    fallback: MailErrorKey
): Promise<{
    error: string;
    field?: string;
    needsFolderRole?: { role: string; accountId: string };
}> {
    const t = await getTranslations("mail");
    const said = (error: Error) => mailRefusalText(t, error.message);
    // The one refusal a screen answers with a question rather than a sentence:
    // this mailbox has no folder for what was asked, and its owner can say which
    // of theirs it is. Carried out structured so the dialog knows what to ask.
    if (caught instanceof MailFolderRoleMissing) {
        return {
            error: said(caught),
            needsFolderRole: { role: caught.role, accountId: caught.accountId }
        };
    }
    if (caught instanceof MailAccessError) return { error: said(caught) };
    if (caught instanceof accounts.MailSetupError)
        return { error: said(caught), field: caught.field };
    if (caught instanceof MailAuthError) return { error: said(caught) };
    if (caught instanceof labels.MailLabelNameTaken) return { error: said(caught) };
    if (caught instanceof folders.MailFolderError) return { error: said(caught) };
    if (caught instanceof rules.MailRuleError) return { error: said(caught) };
    if (caught instanceof templates.MailTemplateNameTaken)
        return { error: said(caught), field: "name" };
    if (caught instanceof subscriptions.MailSubscriptionMissing) return { error: said(caught) };
    console.error("polaris: a mail action failed:", caught);
    return { error: t(fallback) };
}

/** A reply in the reader's language. */
async function errorText(key: MailErrorKey): Promise<string> {
    return (await getTranslations("mail"))(key);
}

/** What a schema refused, in the reader's language, or `fallback` when it said
 *  nothing. */
async function inputError(message: string | undefined, fallback: MailErrorKey): Promise<string> {
    const t = await getTranslations("mail");
    return message ? mailRefusalText(t, message) : t(fallback);
}

/**
 * Draw Mail's own frame again: the mailboxes, their folders, the labels and the
 * counts, which the layout resolves.
 *
 * **For a change to the shape of a mailbox, never for a message moving.** Filing,
 * reading, labelling, snoozing and sending change rows and counts, and nothing
 * here draws either of those: the list routes render no conversations at all (see
 * `list-page`), and the rail's three things come from `/api/mail/rail`, which the
 * screen pulls for itself the moment an action answers. So a message action that
 * called this bought one thing - invalidating every cached route payload the
 * browser was holding, which is what made the app switcher need a second press
 * after deleting an email.
 *
 * The two-sided rule is pinned in `test/mail/mail-does-not-hold-the-router.test.ts`
 * rather than left to this comment, because the cost of getting it wrong is
 * invisible on the screen that causes it.
 */
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
    if (!parsed.success) return { error: await errorText("errors.notEmail") };
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
            error: await inputError(issue?.message, "errors.checkDetails"),
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
        return failure(caught, "errors.mailboxAdd");
    }
}

/* -------------------------------------------------------------------------- */
/* Bringing an archive in                                                       */
/* -------------------------------------------------------------------------- */

/** How many messages are in an uploaded archive, and where they would go. */
export async function openImportAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailImportSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.fileRead") };
    try {
        return await mailImport.openImport(userId, parsed.data);
    } catch (caught) {
        return failure(caught, "errors.fileRead");
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
    if (!parsed.success || !at.success) return { error: await errorText("errors.batchImport") };
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
        return failure(caught, "errors.batchImport");
    }
}

/** How many messages an export would carry, so the screen can say so before
 *  somebody starts a download of a mailbox that takes a while. */
export async function exportSizeAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailExportScopeSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.mailboxCount") };
    try {
        return { count: await mailExport.exportSize(userId, parsed.data) };
    } catch (caught) {
        return failure(caught, "errors.mailboxCount");
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
        return failure(caught, "errors.colourSave");
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
    if (!id.success) return { error: await errorText("errors.folderNotHere") };
    if (!wanted.success) return { error: await errorText("errors.folderNeedsName") };
    try {
        await folders.renameFolder(userId, id.data, wanted.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.folderRename");
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
    if (!id.success) return { error: await errorText("errors.folderNotHere") };
    try {
        await folders.deleteFolder(userId, id.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.folderDelete");
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
        return failure(caught, "errors.changeFailed");
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
        return failure(caught, "errors.forgetFailed");
    }
}

export async function editAccountAction(accountId: string, input: unknown) {
    const userId = await actorId();
    // A patch: only what the screen sent is written, so one switch never puts
    // every other setting back to its default.
    const parsed = core.mailAccountPatchSchema.safeParse(input);
    if (!parsed.success)
        return { error: await inputError(parsed.error.issues[0]?.message, "errors.checkDetails") };
    try {
        const account = await accounts.editAccount(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "errors.saveFailed");
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
            error: await inputError(issue?.message, "errors.checkDetails"),
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const account = await accounts.updateAccount(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "errors.mailboxSave");
    }
}

export async function setPrivacyAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailPrivacySchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.checkDetails") };
    try {
        const account = await accounts.setAccountPrivacy(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "errors.saveFailed");
    }
}

export async function setVacationAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailVacationSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: await inputError(issue?.message, "errors.checkDetails"),
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const account = await accounts.setVacation(userId, accountId, parsed.data);
        refresh();
        return { account };
    } catch (caught) {
        return failure(caught, "errors.saveFailed");
    }
}

export async function removeAccountAction(accountId: string) {
    const userId = await actorId();
    try {
        await accounts.removeAccount(userId, accountId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.mailboxRemove");
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
        return failure(caught, "errors.mailboxCheck");
    }
}

/** Every mailbox at once, for the refresh on the unified view. */
export async function syncAllAction() {
    const userId = await actorId();
    // The shelf being looked at, because this is the refresh button on a rail:
    // it syncs what is in front of somebody, not every mailbox they have.
    const ids = await ownedAccountIds(userId, await mailShelfFor(userId));
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
    if (!parsed.success) return { error: await errorText("errors.nothingSelected") };
    try {
        const done = await messages.actOnMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.action,
            { scope: parsed.data.scope }
        );
        return { done };
    } catch (caught) {
        return failure(caught, "errors.serverRefused");
    }
}

/** Pin a conversation to the top of every list, or mute it - or undo either.
 *  Polaris' own: nothing is sent to the mail server. */
export async function setConversationStateAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailConversationStateSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.nothingSelected") };
    try {
        const done = await messages.setConversationState(userId, parsed.data.messageIds, {
            pinned: parsed.data.pinned,
            muted: parsed.data.muted
        });
        return { done };
    } catch (caught) {
        return failure(caught, "errors.changeFailed");
    }
}

export async function moveAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailMoveSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.nothingSelected") };
    try {
        const done = await messages.moveMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.folderId
        );
        return { done };
    } catch (caught) {
        return failure(caught, "errors.serverRefused");
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
    if (!parsed.success) return { error: await errorText("errors.sayWhichFolder") };
    try {
        const done = await emptyEveryFolderOfRole(userId, parsed.data.role, parsed.data.accountIds);
        return { done };
    } catch (caught) {
        return failure(caught, "errors.serverRefused");
    }
}

export async function snoozeAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailSnoozeSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.nothingSelected") };
    try {
        const done = await messages.snoozeMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.until
        );
        return { done };
    } catch (caught) {
        return failure(caught, "errors.snoozeFailed");
    }
}

/** Let one sender's pictures through from now on, or take that back. */
export async function trustSenderAction(accountId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailTrustSenderSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.notEmail") };
    try {
        await ownedAccount(userId, accountId);
        await reading.trustSender(accountId, parsed.data.address, parsed.data.trusted);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.saveFailed");
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
    if (!wanted) return { error: await errorText("errors.notFolderRole") };
    try {
        await messages.setFolderRole(userId, folderId, wanted);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.saveFailed");
    }
}

/** Make the folder, on the mail server, because its owner asked for one. The
 *  only path in the app that writes a folder into somebody else's mailbox. */
export async function createFolderForRoleAction(accountId: string, role: string) {
    const userId = await actorId();
    const wanted = core.MAIL_FOLDER_ROLES.find((one) => one === role);
    if (!wanted) return { error: await errorText("errors.notFolderRole") };
    try {
        const id = await messages.createFolderForRole(userId, accountId, wanted);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "errors.folderCreate");
    }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Writing a draft, sending, Undo and Send now are routes under `/api/mail/drafts`
 * and `/api/mail/outbox`, not actions here: the composer awaited them while every
 * link in Polaris waited behind it, and an action is the router's to delay or
 * drop. See `lib/mailbox/outbox-answer`.
 */

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

/** Who to offer as somebody types a recipient. */
export async function suggestContactsAction(query: string) {
    const userId = await actorId();
    // The people this shelf writes to. A company address suggesting a personal
    // contact is the wrong recipient offered on the wrong letterhead.
    const accountIds = await ownedAccountIds(userId, await mailShelfFor(userId));
    return { suggestions: await contacts.suggestContacts(accountIds, query) };
}

/* -------------------------------------------------------------------------- */
/* Labels, identities and filters                                              */
/* -------------------------------------------------------------------------- */

export async function createLabelAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailLabelSchema.safeParse(input);
    if (!parsed.success)
        return { error: await inputError(parsed.error.issues[0]?.message, "errors.checkName") };
    try {
        const id = await labels.createLabel(userId, parsed.data.name, parsed.data.color);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "errors.labelCreate");
    }
}

export async function renameLabelAction(labelId: string, input: unknown) {
    const userId = await actorId();
    const parsed = core.mailLabelSchema.safeParse(input);
    if (!parsed.success)
        return { error: await inputError(parsed.error.issues[0]?.message, "errors.checkName") };
    try {
        await labels.renameLabel(userId, labelId, parsed.data.name, parsed.data.color);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.labelChange");
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
    if (!parsed.success) return { error: await errorText("errors.nothingSelected") };
    try {
        const done = await labels.applyLabel(
            userId,
            parsed.data.labelId,
            parsed.data.messageIds,
            parsed.data.applied
        );
        return { done };
    } catch (caught) {
        return failure(caught, "errors.labelApply");
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
            error: await inputError(issue?.message, "errors.checkDetails"),
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
        return failure(caught, "errors.saveFailed");
    }
}

/**
 * Move Mail's shortcuts.
 *
 * The whole keyboard at once, and refused whole when two commands would share a
 * key - the message names both, so the screen can say which binding is in the
 * way rather than storing one that would archive when somebody meant to mute.
 *
 * Kept for a tab loaded before every app shared one table of shortcuts: Mail's
 * keys live in that table now (`shortcuts-service`), so this writes them there,
 * leaving every other app's keys as they are.
 */
export async function setMailKeysAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailKeymapSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: await inputError(issue?.message, "errors.shortcutsSave"),
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const current = await shortcuts.getShortcutOverrides(userId);
        const others = Object.fromEntries(
            Object.entries(current).filter(([id]) => !id.startsWith("mail."))
        );
        const next = { ...others, ...core.overridesFromMailKeymap(parsed.data) };
        // Saving cleans a set whose keys collide down to none at all, which
        // would put back every app's keys and still answer that it saved.
        if (core.shortcutConflicts(core.resolveShortcuts(next)).length > 0)
            return { error: await errorText("errors.shortcutsSave") };
        await shortcuts.saveShortcutOverrides(userId, next);
        refresh();
        return { keys: parsed.data };
    } catch (caught) {
        return failure(caught, "errors.shortcutsSave");
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
            error: await inputError(issue?.message, "errors.checkTemplate"),
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const id = await templates.saveTemplate(userId, templateId, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "errors.templateSave");
    }
}

export async function deleteTemplateAction(templateId: string) {
    const userId = await actorId();
    try {
        await templates.deleteTemplate(userId, templateId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.templateRemove");
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
            error: await inputError(issue?.message, "errors.checkDetails"),
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const id = await labels.saveIdentity(userId, accountId, identityId, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "errors.addressSave");
    }
}

export async function deleteIdentityAction(accountId: string, identityId: string) {
    const userId = await actorId();
    try {
        await labels.deleteIdentity(userId, accountId, identityId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.addressRemove");
    }
}

/**
 * Save a filter, new or in place.
 *
 * Takes the editor's shape (`mailFilterSchema`: a definition with groups and
 * steps) and, from anything still sending it, the flat shape filters had before
 * they were automations - converted, never refused for its age. A refusal comes
 * back with every complaint at the path it is about, so the editor can put each
 * one under its own field.
 */
export async function saveRuleAction(accountId: string, ruleId: string | null, input: unknown) {
    const userId = await actorId();
    if (!isUuid(accountId) || (ruleId !== null && !isUuid(ruleId)))
        return { error: await errorText("errors.ruleSave") };
    const flat = typeof input === "object" && input !== null && !("definition" in input);
    const parsed = flat
        ? core.mailRuleSchema
              .transform((rule) => ({
                  name: rule.name,
                  enabled: rule.enabled,
                  applyToExisting: rule.applyToExisting,
                  definition: core.mailFilterFromLegacy(rule)
              }))
              .pipe(core.mailFilterSchema)
              .safeParse(input)
        : core.mailFilterSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const t = await getTranslations("mail");
        return {
            error: await inputError(issue?.message, "errors.checkRule"),
            field: String(issue?.path[0] ?? ""),
            issues: parsed.error.issues.map((one) => ({
                path: one.path,
                message: mailRefusalText(t, one.message)
            }))
        };
    }
    try {
        const { id, applied } = await rules.saveFilter(userId, accountId, ruleId, parsed.data);
        refresh();
        return { id, applied };
    } catch (caught) {
        return failure(caught, "errors.ruleSave");
    }
}

/** Switch a filter on or off from the list. */
export async function setRuleEnabledAction(accountId: string, ruleId: string, enabled: boolean) {
    const userId = await actorId();
    if (!isUuid(accountId) || !isUuid(ruleId)) return { error: await errorText("errors.ruleSave") };
    if (typeof enabled !== "boolean") return { error: await errorText("errors.checkRule") };
    try {
        await rules.setRuleEnabled(userId, accountId, ruleId, enabled);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.ruleSave");
    }
}

/** A copy of a filter, below it and switched off, under the name the screen
 *  gave it in the reader's language. */
export async function duplicateRuleAction(accountId: string, ruleId: string, name: unknown) {
    const userId = await actorId();
    if (!isUuid(accountId) || !isUuid(ruleId)) return { error: await errorText("errors.ruleSave") };
    const parsed = core.mailFilterSchema.shape.name.safeParse(name);
    if (!parsed.success)
        return { error: await inputError(parsed.error.issues[0]?.message, "errors.checkRule") };
    try {
        const id = await rules.duplicateRule(userId, accountId, ruleId, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "errors.ruleSave");
    }
}

/** Run a saved filter over the mail already in the inbox. */
export async function runRuleOverInboxAction(accountId: string, ruleId: string) {
    const userId = await actorId();
    if (!isUuid(accountId) || !isUuid(ruleId)) return { error: await errorText("errors.ruleSave") };
    try {
        await rules.runRuleOverInbox(userId, accountId, ruleId);
        return {};
    } catch (caught) {
        return failure(caught, "errors.ruleSave");
    }
}

export async function deleteRuleAction(accountId: string, ruleId: string) {
    const userId = await actorId();
    if (!isUuid(accountId) || !isUuid(ruleId))
        return { error: await errorText("errors.ruleRemove") };
    try {
        await rules.deleteRule(userId, accountId, ruleId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.ruleRemove");
    }
}

export async function reorderRulesAction(accountId: string, orderedIds: string[]) {
    const userId = await actorId();
    if (!isUuid(accountId) || !Array.isArray(orderedIds) || !orderedIds.every(isUuid))
        return { error: await errorText("errors.orderSave") };
    try {
        await rules.reorderRules(userId, accountId, orderedIds);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.orderSave");
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
    if (!parsed.success) return { error: await errorText("errors.fileAttach") };
    try {
        const upload = await attachFrom.attachFromDrive(
            userId,
            parsed.data.connectionId,
            parsed.data.path
        );
        return { upload };
    } catch (caught) {
        if (caught instanceof attachFrom.AttachRefused) return { error: caught.message };
        return failure(caught, "errors.fileAttach");
    }
}

/** Attach a file at an address somebody pasted. Fetched by Polaris, through the
 *  same guard every person-supplied address goes through. */
export async function attachFromAddressAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAttachFromAddressSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.notFetchable") };
    try {
        const upload = await attachFrom.attachFromAddress(userId, parsed.data.url);
        return { upload };
    } catch (caught) {
        if (caught instanceof attachFrom.AttachRefused) return { error: caught.message };
        return failure(caught, "errors.fileAttach");
    }
}

/** Carry the files of the message being forwarded onto the forward. Answers the
 *  ones it carried and names the ones it could not. */
export async function attachFromMessageAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailAttachFromMessageSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.filesCarry") };
    try {
        return await attachFrom.attachFromMessage(userId, parsed.data.messageId);
    } catch (caught) {
        return failure(caught, "errors.filesCarry");
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
    if (!parsed.success) return { error: await errorText("errors.notEmail") };
    try {
        await ownedAccount(userId, accountId);
        await blocking.blockSender(userId, accountId, parsed.data.address, parsed.data.as);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "errors.senderBlock");
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
        return failure(caught, "errors.blockRemove");
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
        return failure(caught, "errors.unsubscribeSend");
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
        return failure(caught, "errors.unsubscribeSend");
    }
}

/** Throw a half-written message away. Nothing was sent, so there is nothing to
 *  take back. */
export async function discardDraftAction(draftId: string) {
    const userId = await actorId();
    try {
        await compose.discardDraft(userId, draftId);
        return {};
    } catch (caught) {
        return failure(caught, "errors.draftRemove");
    }
}

/**
 * Try a refused message again.
 *
 * Answers with whether anything moved. `false` is a message that is no longer
 * refused - already back in the queue, or already gone - and the screen says so
 * rather than queueing a second copy: the claim that decides it is a conditional
 * update on the row, so two presses cannot both win it.
 */
export async function retrySendAction(draftId: string) {
    const userId = await actorId();
    try {
        return { queued: await compose.retrySend(userId, draftId) };
    } catch (caught) {
        return failure(caught, "errors.resendFailed");
    }
}

/** Put messages in a folder, for the drag onto the rail and the Move to menu. */
export async function moveToFolderAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailMoveSchema.safeParse(input);
    if (!parsed.success) return { error: await errorText("errors.nothingMoved") };
    try {
        const done = await messages.moveMessages(
            userId,
            parsed.data.messageIds,
            parsed.data.folderId
        );
        return { done };
    } catch (caught) {
        return failure(caught, "errors.moveFailed");
    }
}
