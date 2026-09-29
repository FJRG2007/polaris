"use server";

/**
 * Handing out the organization's mailboxes, and taking them back.
 *
 * Its own file rather than a section of the organization's actions, because
 * everything here has a second gate the rest does not: the payload is a mailbox
 * setup carrying a credential, and it must be validated by the same schema the
 * personal path uses before it goes anywhere near a mail server.
 *
 * Nothing here can read mail. The service it calls will not return a message, a
 * folder or a stored secret to anybody but the mailbox's own holder - see
 * `lib/mailbox/access.ts`, whose rule this feature was built not to bend.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import * as register from "@/lib/mailbox/org-mailboxes";
import { MailSetupError } from "@/lib/mailbox/accounts";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import { validationMessage } from "@/components/i18n/validation-message";

async function failure(
    caught: unknown,
    fallback: NamespaceKey<"accountOrgs">
): Promise<{ error: string; field?: string }> {
    if (caught instanceof register.OrgMailboxError) return { error: caught.message };
    if (caught instanceof MailSetupError) return { error: caught.message, field: caught.field };
    console.error(caught);
    return { error: (await getTranslations("accountOrgs"))(fallback) };
}

function refresh(slug: string): void {
    revalidatePath(`/account/organizations/${slug}/mailboxes`);
}

export async function handOutMailboxAction(
    orgId: string,
    slug: string,
    holderId: string,
    input: unknown
) {
    const user = await requireUser();
    const parsed = core.mailAccountSetupSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const [t, tv] = await Promise.all([getTranslations("accountOrgs"), getTranslations("validation")]);
        return {
            error: issue ? validationMessage(tv, issue.message) : t("errors.checkDetailsShort"),
            field: String(issue?.path[0] ?? "")
        };
    }
    if (!holderId) return { error: (await getTranslations("accountOrgs"))("errors.chooseHolder"), field: "holderId" };
    try {
        const mailboxes = await register.handOutMailbox({ id: user.id, isAdmin: user.isAdmin }, orgId, holderId, parsed.data);
        refresh(slug);
        return { mailboxes };
    } catch (caught) {
        return failure(caught, "errors.handOut");
    }
}

export async function takeBackMailboxAction(orgId: string, slug: string, accountId: string) {
    const user = await requireUser();
    try {
        const mailboxes = await register.takeBackMailbox({ id: user.id, isAdmin: user.isAdmin }, orgId, accountId);
        refresh(slug);
        return { mailboxes };
    } catch (caught) {
        return failure(caught, "errors.takeBack");
    }
}
