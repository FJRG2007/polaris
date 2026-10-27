/**
 * Announcements (/admin/announcements): tell the people on this instance about
 * maintenance, an update, an incident or anything else, on the bell, as a
 * banner, or both - and see what was sent.
 *
 * The roles, groups and organizations to pick from are short lists and read
 * here; the history is the view's to ask for after the first paint.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { TEMPLATES } from "@/lib/announcements/schema";
import { AnnouncementsView } from "./announcements-view";
import { templateText } from "@/lib/announcements/templates";
import { getLocale, getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

const PICK_LIMIT = 200;

export default async function AnnouncementsPage() {
    await requireAdmin();
    const [locale, t, roles, groups, orgs] = await Promise.all([
        getLocale(),
        getTranslations("announcements"),
        prisma.role.findMany({
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: PICK_LIMIT
        }),
        prisma.group.findMany({
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: PICK_LIMIT
        }),
        prisma.organization.findMany({
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: PICK_LIMIT
        })
    ]);
    const templates = Object.fromEntries(TEMPLATES.map((id) => [id, templateText(locale, id)]));

    return (
        <Messages namespaces={["announcements"]}>
            <div className="mx-auto flex w-full max-w-4xl flex-col">
                <PageHeader title={t("admin.title")} description={t("admin.description")} />
                <AnnouncementsView
                    locale={locale}
                    templates={templates}
                    roles={roles}
                    groups={groups}
                    orgs={orgs}
                />
            </div>
        </Messages>
    );
}
