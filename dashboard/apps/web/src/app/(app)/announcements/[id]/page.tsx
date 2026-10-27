/**
 * An announcement's details (/announcements/[id]): what the banner's "See
 * details" opens. The banner's own text, the long form written behind it, a
 * maintenance window with what it touches, and the updates added since, oldest
 * first.
 *
 * Read for the reader exactly as their banner was: only an announcement meant
 * for them, in their language and time zone. Anybody else gets the not-found
 * page, so the address does not say whether an announcement exists.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { Badge, PageHeader } from "@polaris/ui";
import { detailsFor } from "@/lib/announcements/service";
import { RichText } from "@/components/rich-text/rich-text";
import { getLocale, getTranslations } from "@/lib/i18n/request";
import { announcementIdSchema } from "@/lib/announcements/schema";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { AnnouncementMarkdown } from "@/components/announcements/announcement-markdown";

export const dynamic = "force-dynamic";

export default async function AnnouncementDetailsPage({
    params
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    if (!announcementIdSchema.safeParse(id).success) notFound();
    const user = await requireUser();
    const locale = await getLocale();
    const [t, prefs] = await Promise.all([
        getTranslations("announcements"),
        resolveDisplayPreferencesFor(user.id, locale)
    ]);
    const timeZone = prefs.timeZone;
    // Somebody viewing as another account reads what that account would.
    const item = await detailsFor(user.id, user.isAdmin && !user.viewingAs, id, {
        locale,
        timeZone
    });
    if (!item) notFound();

    const when = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone
    });
    const maintenancePhase = ["upcoming", "inProgress", "finished"].includes(item.phase)
        ? (item.phase as "upcoming" | "inProgress" | "finished")
        : null;

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <Link
                href="/"
                className="self-start text-sm text-muted-foreground hover:text-foreground"
            >
                {t("details.back")}
            </Link>
            <PageHeader
                title={item.title}
                description={when.format(new Date(item.startsAt))}
                actions={
                    item.kind === "maintenance" && maintenancePhase ? (
                        <Badge>{t(`banner.phase.${maintenancePhase}`)}</Badge>
                    ) : undefined
                }
            />
            {item.body ? (
                <AnnouncementMarkdown source={item.body} className="min-w-0 text-sm" />
            ) : null}
            {item.kind === "maintenance" && item.windowStart && item.windowEnd ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{t("details.window")}</dt>
                    <dd className="min-w-0 break-words">
                        {when.formatRange(new Date(item.windowStart), new Date(item.windowEnd))}
                    </dd>
                    {item.affected.length > 0 ? (
                        <>
                            <dt className="text-muted-foreground">{t("details.affected")}</dt>
                            <dd className="min-w-0 break-words">
                                {new Intl.ListFormat(locale, { type: "conjunction" }).format(
                                    item.affected
                                )}
                            </dd>
                        </>
                    ) : null}
                </dl>
            ) : null}
            {item.details ? (
                <RichText value={item.details} className="min-w-0" />
            ) : item.updates.length === 0 && item.kind !== "maintenance" ? (
                <p className="text-sm text-muted-foreground">{t("details.noDetails")}</p>
            ) : null}
            {item.updates.length > 0 ? (
                <section className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">{t("details.updates")}</h2>
                    <ol className="flex flex-col gap-4 border-l pl-4">
                        {item.updates.map((update) => (
                            <li key={update.id} className="flex min-w-0 flex-col gap-1">
                                <time
                                    dateTime={update.createdAt}
                                    className="text-xs text-muted-foreground"
                                >
                                    {t("details.posted", {
                                        when: when.format(new Date(update.createdAt))
                                    })}
                                </time>
                                <RichText value={update.body} className="min-w-0" />
                            </li>
                        ))}
                    </ol>
                </section>
            ) : null}
            {item.linkUrl ? (
                item.linkUrl.startsWith("/") ? (
                    <Link
                        href={item.linkUrl}
                        className="self-start text-sm font-medium underline underline-offset-2"
                    >
                        {item.linkLabel ?? item.linkUrl}
                    </Link>
                ) : (
                    <a
                        href={item.linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="self-start break-all text-sm font-medium underline underline-offset-2"
                    >
                        {item.linkLabel ?? item.linkUrl}
                    </a>
                )
            ) : null}
        </div>
    );
}
