/**
 * Email & SMS (/admin/email): the senders Polaris sends mail and texts through,
 * and - for an administrator - which of them carries account mail.
 *
 * A sender belongs to whoever added it, the same as before it moved here from
 * the Inbox's channels page, so the lists are this account's own. The account
 * mail choice is deployment-wide and picks from every email sender there is.
 */

import { PageHeader } from "@polaris/ui";
import { EmailAdminLoader } from "./loader";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function EmailPage() {
    await requirePermission("inbox.read");
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <PageHeader title={t("email.title")} description={t("email.description")} />
            <EmailAdminLoader revision={Date.now()} />
        </div>
    );
}
