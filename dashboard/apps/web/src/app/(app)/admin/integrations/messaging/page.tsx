/**
 * Messaging (/admin/integrations/messaging): the WhatsApp, Telegram, Discord and
 * Slack channels Polaris sends through, and which of them carry verification
 * codes. Administrators only.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { MessagingAdminLoader } from "./loader";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function MessagingPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <PageHeader title={t("messaging.title")} description={t("messaging.description")} />
            <MessagingAdminLoader revision={Date.now()} />
        </div>
    );
}
