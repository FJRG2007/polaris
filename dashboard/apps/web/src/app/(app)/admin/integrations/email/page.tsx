/**
 * Email & SMS (/admin/integrations/email): the senders Polaris sends mail and
 * texts through, and - for an administrator - which of them carries account mail.
 *
 * A sender belongs to whoever added it, so the lists are this account's own, and
 * the page is held by `inbox.read` rather than the administrator alone: that is
 * the permission every role that could add a sender already holds, and moving it
 * here from Management > Communication must not take a sender away from anybody.
 * The account mail choice is deployment-wide and picks from every email sender.
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
