"use client";

/**
 * Every site this account can open, searched and scrolled a page at a time, with
 * the button that adds another. A row opens the site; its context menu jumps
 * straight to a section, copies the name, or removes a site added from elsewhere.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Copy, Globe, Plus, Radio, Server, Settings, ShieldCheck, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Input,
    Skeleton
} from "@polaris/ui";
import * as polls from "../analytics-polls";
import { deleteExternalSiteAction } from "../actions";
import { useConfirm } from "@/components/confirm-dialog";
import type { SiteListRow } from "@/lib/analytics-lists";
import { useTranslations } from "@/components/i18n/i18n-provider";

const ROW_HEIGHT = 52;

/** Last first page per search, drawn at once on the way back and refreshed behind. */
const firstPages = new Map<string, { rows: SiteListRow[]; next: string | null }>();

function siteHref(site: SiteListRow, path = "/analytics"): string {
    return site.scope === "polaris" ? `${path}?scope=polaris` : `${path}?scope=${site.scope}&id=${encodeURIComponent(site.id)}`;
}

export function SitesView({ canAdd }: { canAdd: boolean }) {
    const t = useTranslations("analytics");
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");
    const cached = firstPages.get(search);
    const [rows, setRows] = useState<SiteListRow[] | null>(cached?.rows ?? null);
    const [next, setNext] = useState<string | null>(cached?.next ?? null);
    const [loading, setLoading] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [confirm, confirmElement] = useConfirm();
    const inflight = useRef<AbortController | null>(null);
    const parent = useRef<HTMLDivElement | null>(null);

    // Typing settles before it asks.
    useEffect(() => {
        const timer = setTimeout(() => setSearch(query.trim()), 250);
        return () => clearTimeout(timer);
    }, [query]);

    const fetchPage = useCallback(
        (cursor: string | null) => {
            inflight.current?.abort();
            const controller = new AbortController();
            inflight.current = controller;
            setLoading(true);
            polls
                .analyticsSiteList({ ...(cursor ? { cursor } : {}), ...(search ? { query: search } : {}) }, controller.signal)
                .then((result) => {
                    if (controller.signal.aborted) return;
                    if ("error" in result) {
                        setFailure(result.error);
                        return;
                    }
                    setFailure(null);
                    setNext(result.next);
                    if (cursor) setRows((current) => [...(current ?? []), ...result.rows]);
                    else {
                        firstPages.set(search, result);
                        setRows(result.rows);
                    }
                })
                .catch(() => {
                    if (!controller.signal.aborted) setRows((current) => current ?? []);
                })
                .finally(() => {
                    if (!controller.signal.aborted) setLoading(false);
                });
        },
        [search]
    );

    useEffect(() => {
        const hit = firstPages.get(search);
        setRows(hit?.rows ?? null);
        setNext(hit?.next ?? null);
        fetchPage(null);
        return () => inflight.current?.abort();
    }, [search, fetchPage]);

    const count = rows?.length ?? 0;
    const virtualizer = useVirtualizer({
        count,
        getScrollElement: () => parent.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 8
    });
    const items = virtualizer.getVirtualItems();
    const last = items[items.length - 1]?.index ?? -1;
    useEffect(() => {
        if (next && !loading && last >= count - 8) fetchPage(next);
    }, [last, count, next, loading, fetchPage]);

    async function remove(site: SiteListRow) {
        const sure = await confirm({
            title: t("sites.removeTitle", { name: site.label }),
            description: t("sites.removeBody"),
            confirmLabel: t("sites.remove"),
            danger: true
        });
        if (!sure) return;
        const previous = rows;
        setRows((current) => (current ?? []).filter((one) => one.id !== site.id));
        const result = await deleteExternalSiteAction({ scopeType: "external", scopeId: site.id });
        if (result.error) {
            setFailure(result.error);
            setRows(previous);
        } else firstPages.clear();
    }

    const kindIcon = (site: SiteListRow) =>
        site.scope === "polaris" ? ShieldCheck : site.scope === "external" ? Globe : Server;

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-[1.0625rem] font-semibold tracking-tight">
                    {t("sections.sites")}
                </h1>
                {canAdd ? (
                    <Button asChild size="sm">
                        <Link href="/analytics/sites/new">
                            <Plus aria-hidden="true" />
                            {t("sites.add")}
                        </Link>
                    </Button>
                ) : null}
            </div>
            <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("sites.search")}
                aria-label={t("sites.search")}
                maxLength={120}
                className="w-full sm:max-w-sm"
            />
            {failure ? (
                <p className="rounded-md border border-danger-edge bg-danger-soft px-4 py-3 text-sm text-danger-ink">{failure}</p>
            ) : null}
            <Card className="min-w-0">
                <CardBody className="p-0">
                    {rows === null ? (
                        <div className="flex flex-col gap-2 p-3">
                            {Array.from({ length: 6 }, (_, index) => (
                                <Skeleton key={index} className="h-10 w-full" />
                            ))}
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground">
                            <span>{search ? t("sites.noMatch") : t("sites.none")}</span>
                            {canAdd && !search ? (
                                <Button asChild size="sm" variant="outline">
                                    <Link href="/analytics/sites/new">{t("sites.add")}</Link>
                                </Button>
                            ) : null}
                        </div>
                    ) : (
                        <div ref={parent} className="max-h-[calc(100dvh-14rem)] min-h-[12rem] overflow-y-auto overscroll-contain" role="list">
                            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                                {items.map((item) => {
                                    const site = rows[item.index]!;
                                    const Icon = kindIcon(site);
                                    return (
                                        <ContextMenu key={`${site.scope}:${site.id}`}>
                                            <ContextMenuTrigger asChild>
                                                <div
                                                    role="listitem"
                                                    className="absolute left-0 top-0 w-full border-b border-border"
                                                    style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                                                >
                                                    <Link
                                                        href={siteHref(site)}
                                                        className="flex h-full min-w-0 items-center gap-3 px-4 text-sm hover:bg-muted/40"
                                                    >
                                                        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                                        <span className="min-w-0 flex-1 truncate font-medium" title={site.label}>
                                                            {site.label}
                                                        </span>
                                                        <Badge variant="neutral" className="shrink-0">
                                                            {t(`scopes.${site.scope}`)}
                                                        </Badge>
                                                    </Link>
                                                </div>
                                            </ContextMenuTrigger>
                                            <ContextMenuContent className="min-w-[11rem]">
                                                <ContextMenuItem onSelect={() => router.push(siteHref(site))}>
                                                    <Activity className="size-3.5" />
                                                    {t("sections.overview")}
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => router.push(siteHref(site, "/analytics/realtime"))}>
                                                    <Radio className="size-3.5" />
                                                    {t("sections.realtime")}
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => router.push(siteHref(site, "/analytics/settings"))}>
                                                    <Settings className="size-3.5" />
                                                    {t("sections.site")}
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(site.label)}>
                                                    <Copy className="size-3.5" />
                                                    {t("lists.copy")}
                                                </ContextMenuItem>
                                                {site.scope === "external" ? (
                                                    <>
                                                        <ContextMenuSeparator />
                                                        <ContextMenuItem variant="danger" onSelect={() => void remove(site)}>
                                                            <Trash2 className="size-3.5" />
                                                            {t("sites.remove")}
                                                        </ContextMenuItem>
                                                    </>
                                                ) : null}
                                            </ContextMenuContent>
                                        </ContextMenu>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {loading && rows && rows.length > 0 ? <Skeleton className="m-3 h-6" /> : null}
                </CardBody>
            </Card>
            {confirmElement}
        </div>
    );
}
