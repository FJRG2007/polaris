"use server";

/**
 * What a delegate does in a mailbox lent to them: act on its inbox, write from
 * it, and look after their own unsent messages. Every input is parsed here and
 * every call asks the grant again in `lib/mailbox/delegate-act` - the screen
 * hiding a button is a courtesy, this is the check.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { MailAccessError } from "@/lib/mailbox/access";
import * as delegate from "@/lib/mailbox/delegate-act";

const draftRef = z.object({ accountId: z.string().uuid(), draftId: z.string().uuid() });

async function actorId(): Promise<string> {
    return (await requirePermission("mail.use")).id;
}

/** A refusal in words the delegate can act on. A grant taken back or narrowed
 *  reads the same as never having had it: nothing about the mailbox leaks. */
async function failure(caught: unknown): Promise<{ error: string }> {
    const t = await getTranslations("mail");
    if (caught instanceof MailAccessError) return { error: t("delegate.errors.notAllowed") };
    console.error("polaris: a delegated mail action failed:", caught);
    return { error: t("delegate.errors.failed") };
}

function refresh(accountId: string): void {
    revalidatePath(`/mail/shared/${accountId}`);
}

export async function delegateActAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailDelegateActionSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("mail"))("delegate.errors.input") };
    try {
        const done = await delegate.delegateAct(userId, parsed.data);
        refresh(parsed.data.accountId);
        return { done };
    } catch (caught) {
        return failure(caught);
    }
}

export async function delegateSendAction(input: unknown) {
    const userId = await actorId();
    const parsed = core.mailDelegateComposeSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            error: (await getTranslations("mail"))("delegate.errors.input"),
            field: String(issue?.path[0] ?? "")
        };
    }
    try {
        const queued = await delegate.delegateSend(userId, parsed.data);
        refresh(parsed.data.accountId);
        return { draftId: queued.draftId, sendAt: queued.sendAt.toISOString() };
    } catch (caught) {
        return failure(caught);
    }
}

export async function delegateOpenDraftAction(input: unknown) {
    const userId = await actorId();
    const parsed = draftRef.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("mail"))("delegate.errors.input") };
    try {
        return {
            draft: await delegate.delegateDraft(userId, parsed.data.accountId, parsed.data.draftId)
        };
    } catch (caught) {
        return failure(caught);
    }
}

export async function delegateCancelAction(input: unknown) {
    const userId = await actorId();
    const parsed = draftRef.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("mail"))("delegate.errors.input") };
    try {
        const undone = await delegate.delegateCancel(
            userId,
            parsed.data.accountId,
            parsed.data.draftId
        );
        refresh(parsed.data.accountId);
        return { undone };
    } catch (caught) {
        return failure(caught);
    }
}

export async function delegateRetryAction(input: unknown) {
    const userId = await actorId();
    const parsed = draftRef.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("mail"))("delegate.errors.input") };
    try {
        const queued = await delegate.delegateRetry(
            userId,
            parsed.data.accountId,
            parsed.data.draftId
        );
        refresh(parsed.data.accountId);
        return { queued };
    } catch (caught) {
        return failure(caught);
    }
}

export async function delegateDiscardAction(input: unknown) {
    const userId = await actorId();
    const parsed = draftRef.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("mail"))("delegate.errors.input") };
    try {
        await delegate.delegateDiscard(userId, parsed.data.accountId, parsed.data.draftId);
        refresh(parsed.data.accountId);
        return { discarded: true };
    } catch (caught) {
        return failure(caught);
    }
}
