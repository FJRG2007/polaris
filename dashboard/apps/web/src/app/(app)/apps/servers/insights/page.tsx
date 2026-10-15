import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { listServerRows } from "../server-rows";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { INSIGHTS_MAX } from "@/lib/server-insights/request";
import { ServerInsightsPanel } from "./server-insights-panel";

export const dynamic = "force-dynamic";

/** Unusual activity and disk forecasts for every server the reader can see. The
 *  list of servers is a database read and paints with the page; the insights
 *  themselves arrive after it. Past one read's worth of servers the list is
 *  paged (?page=2), and a link to one server opens on the page that holds it. */
export default async function ServerInsightsPage({
    searchParams
}: {
    searchParams: Promise<{ server?: string | string[]; page?: string | string[] }>
}) {
    const user = await requirePermission("system.manage");
    const [rows, t, params] = await Promise.all([listServerRows(user.id), getTranslations("servers"), searchParams]);
    const filter = typeof params.server === "string" ? params.server : null;
    const pages = Math.max(1, Math.ceil(rows.length / INSIGHTS_MAX));
    const filtered = filter ? rows.findIndex((row) => row.id === filter) : -1;
    const asked = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
    const page =
        filtered >= 0
            ? Math.floor(filtered / INSIGHTS_MAX) + 1
            : Math.min(pages, Math.max(1, Number.isFinite(asked) ? asked : 1));
    const first = (page - 1) * INSIGHTS_MAX;
    const servers = rows.slice(first, first + INSIGHTS_MAX).map((row) => ({ id: row.id, name: row.name }));
    return (
        <>
            <PageHeader title={t("insights.heading")} description={t("insights.description")} />
            {pages > 1 ? (
                <nav className="mb-4 flex items-center gap-2" aria-label={t("insights.pages.label")}>
                    <span className="min-w-0 text-xs text-muted-foreground">
                        {t("insights.pages.range", {
                            from: first + 1,
                            to: first + servers.length,
                            total: rows.length
                        })}
                    </span>
                    <PageLink page={page - 1} pages={pages} label={t("insights.pages.previous")}>
                        <ChevronLeft className="size-4" aria-hidden />
                    </PageLink>
                    <PageLink page={page + 1} pages={pages} label={t("insights.pages.next")}>
                        <ChevronRight className="size-4" aria-hidden />
                    </PageLink>
                </nav>
            ) : null}
            <ServerInsightsPanel key={page} servers={servers} initialFilter={filter} />
        </>
    );
}

function PageLink({
    page,
    pages,
    label,
    children
}: {
    page: number;
    pages: number;
    label: string;
    children: React.ReactNode;
}) {
    if (page < 1 || page > pages) {
        return (
            <Button variant="ghost" size="icon" disabled aria-label={label} title={label}>
                {children}
            </Button>
        );
    }
    return (
        <Button asChild variant="ghost" size="icon">
            <Link href={`/apps/servers/insights?page=${page}`} aria-label={label} title={label}>
                {children}
            </Link>
        </Button>
    );
}
