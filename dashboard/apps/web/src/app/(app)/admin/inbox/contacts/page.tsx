/**
 * Contacts: the messaging CRM. One entry per person with every platform handle
 * they can be reached on, so an operator picks a person (not a raw number) when
 * starting a chat and sees them unified across WhatsApp, Telegram and Discord.
 */

import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { ContactsLoader, tableSkeleton } from "../loaders";
import { ViewHeadingSkeleton } from "@/app/(app)/admin/region-skeletons";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
    await requirePermission("inbox.read");
    const t = await getTranslations("admin");

    return (
        <ContactsLoader
            revision={Date.now()}
            skeleton={
                <ViewHeadingSkeleton title={t("inboxContacts.title")} intro={t("inboxContacts.intro")}>
                    {tableSkeleton}
                </ViewHeadingSkeleton>
            }
        />
    );
}
