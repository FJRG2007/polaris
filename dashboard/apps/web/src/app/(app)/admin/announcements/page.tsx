/**
 * Announcements (/admin/announcements): tell the people on this instance about
 * maintenance, an update, an incident or anything else, on the bell, as a
 * banner, or both - and see what was sent.
 *
 * The roles, groups and organizations to pick from, and the history, are the
 * browser's to ask for after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { AnnouncementsLoader } from "./loader";
import { Messages } from "@/components/i18n/messages";
import { TEMPLATES } from "@/lib/announcements/schema";
import { templateText } from "@/lib/announcements/templates";
import { getLocale, getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
    await requireAdmin();
    const [locale, t] = await Promise.all([getLocale(), getTranslations("announcements")]);
    const templates = Object.fromEntries(TEMPLATES.map((id) => [id, templateText(locale, id)]));

    return (
        <Messages namespaces={["announcements"]}>
            <div className="mx-auto flex w-full max-w-4xl flex-col">
                <PageHeader title={t("admin.title")} description={t("admin.description")} />
                <AnnouncementsLoader locale={locale} templates={templates} revision={Date.now()} />
            </div>
        </Messages>
    );
}
