/** Watch: every server, service and container, with what each is doing. */

import Link from "next/link";
import { Bell } from "lucide-react";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { Button, PageHeader } from "@polaris/ui";
import { sortByConsumption } from "@/lib/watch/card-order";
import { WatchCardGrid } from "@/app/(app)/watch/watch-cards";
import type { WatchCard } from "@/lib/watch-overview-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { WatchContainersSection } from "@/app/(app)/watch/watch-containers";
import { WATCH_FIRING, watchContainers, watchServers, watchServices } from "../fixtures/watch";

/** How many cards a group shows, as `/watch/page.tsx` stops at. */
const GROUP_LIMIT = 6;

/** One group of the overview, drawn the way the page's own `Group` draws it. */
function Group({ kind, cards }: { kind: "servers" | "services"; cards: WatchCard[] }) {
    const t = useTranslations("watch");
    const shown = sortByConsumption(cards, "cpu").slice(0, GROUP_LIMIT);
    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                    {t(`overview.${kind}`)} <span className="text-muted-foreground">({cards.length})</span>
                </h2>
                <Link href={`/watch/${kind}`} className="text-xs text-primary hover:underline">
                    {cards.length > shown.length
                        ? t("overview.viewAllCount", { count: cards.length })
                        : t("overview.viewAll")}
                </Link>
            </div>
            <WatchCardGrid
                cards={shown}
                empty={t(kind === "servers" ? "overview.noServers" : "overview.noServices")}
            />
        </section>
    );
}

/** The page `/watch` draws, with what it would have read. */
function Overview({ servers, services }: { servers: WatchCard[]; services: WatchCard[] }) {
    const t = useTranslations("watch");
    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader title={t("overview.title")} description={t("overview.description")} />
                <Button asChild variant="danger" size="sm">
                    <Link href="/watch/alarms">
                        <Bell className="size-4" />
                        {t("overview.firing", { count: WATCH_FIRING })}
                    </Link>
                </Button>
            </div>
            <Group kind="servers" cards={servers} />
            <Group kind="services" cards={services} />
            <WatchContainersSection limit={GROUP_LIMIT} />
        </div>
    );
}

export const watch = defineScene({
    id: "watch",
    path: "/watch",
    api: (ctx) => ({ "GET /api/watch/containers": () => ({ containers: watchContainers(ctx) }) }),
    render: (ctx) => (
        <Chrome>
            <Overview servers={watchServers(ctx)} services={watchServices(ctx)} />
        </Chrome>
    )
});
