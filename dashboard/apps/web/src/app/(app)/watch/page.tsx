import Link from "next/link";
import { Bell } from "lucide-react";
import { WatchCardGrid } from "./watch-cards";
import { sortByConsumption } from "@/lib/watch/card-order";
import { Button, PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { WatchContainersSection } from "./watch-containers";
import { getWatchOverview } from "@/lib/watch-overview-service";

export const dynamic = "force-dynamic";

/** How many cards a group shows before it defers to its own screen. An overview
 *  that scrolls for a minute stops being one. */
const GROUP_LIMIT = 6;

/**
 * Watch's front page: everything worth monitoring, grouped by what it is, each
 * card carrying the shape of its last hour. The point is to make the one that is
 * misbehaving obvious without opening anything.
 *
 * Servers and services come from the collected samples, so they are here with the
 * page. Containers have to be asked for machine by machine, so they arrive just
 * after it rather than holding it up.
 */
export default async function WatchPage() {
    const user = await requirePermission("deploy.read");
    const overview = await getWatchOverview(user.id);
    const t = await getTranslations("watch");

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("overview.title")}
                    description={t("overview.description")}
                />
                <Button asChild variant={overview.firing > 0 ? "danger" : "ghost"} size="sm">
                    <Link href="/watch/alarms">
                        <Bell className="size-4" />
                        {overview.firing > 0 ? t("overview.firing", { count: overview.firing }) : t("overview.alarms")}
                    </Link>
                </Button>
            </div>

            <Group
                title={t("overview.servers")}
                href="/watch/servers"
                count={overview.servers.length}
                cards={overview.servers}
                empty={t("overview.noServers")}
                viewAll={t("overview.viewAll")}
                viewAllCount={t("overview.viewAllCount", { count: overview.servers.length })}
            />
            <Group
                title={t("overview.services")}
                href="/watch/services"
                count={overview.services.length}
                cards={overview.services}
                empty={t("overview.noServices")}
                viewAll={t("overview.viewAll")}
                viewAllCount={t("overview.viewAllCount", { count: overview.services.length })}
            />
            <WatchContainersSection limit={GROUP_LIMIT} />
        </div>
    );
}

function Group({
    title,
    href,
    count,
    cards,
    empty,
    viewAll,
    viewAllCount
}: {
    title: string;
    href: string;
    count: number;
    cards: Awaited<ReturnType<typeof getWatchOverview>>["servers"];
    empty: string;
    /** The link's words, and the same with the count, in the reader's language. */
    viewAll: string;
    viewAllCount: string;
}) {
    // Busiest first, because a group that stops at six has to be the six worth
    // stopping at. The screen behind "View all" is where the whole list is, in
    // whatever order the reader asks for.
    const shown = sortByConsumption(cards, "cpu").slice(0, GROUP_LIMIT);
    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                    {title} <span className="text-muted-foreground">({count})</span>
                </h2>
                <Link href={href} className="text-xs text-primary hover:underline">
                    {count > shown.length ? viewAllCount : viewAll}
                </Link>
            </div>
            <WatchCardGrid cards={shown} empty={empty} />
        </section>
    );
}
