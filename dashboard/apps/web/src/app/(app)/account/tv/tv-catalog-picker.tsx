"use client";

/**
 * Themes and add-ons for one TV, picked from the newest release's catalog with
 * the same gallery the site shows. A pick is shown at once and goes back if it is
 * refused; the TV applies it on its next check-in and says how it went, so the
 * line under the button tells "sent" apart from "done".
 */

import { useState } from "react";
import { Button, Skeleton } from "@polaris/ui";
import type { TvRow } from "@/lib/tv/update-requests";
import { tvTakesCatalog } from "@/lib/tv/version-order";
import type { TvCatalogEntry } from "@/lib/tv/catalog-picks";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { TvGallery, type TvGalleryItem } from "@polaris/ui/tv-gallery";

export type TvCatalogStatus =
    | "updateFirst"
    | "nextUpdate"
    | "notAsked"
    | "waiting"
    | "applied"
    | "installed"
    | "asked"
    | "failed"
    | "unavailable";

/**
 * Where the latest pick stands. A problem with either pick is what is shown; else
 * one still waiting; else what the TV last confirmed. A launcher too old to take
 * a pick is sent to its update, or, when no newer release is published for it
 * (`newestRelease`), told the picks come with the next one.
 */
export function catalogStatus(row: TvRow, newestRelease = false): TvCatalogStatus {
    if (!tvTakesCatalog(row.versionCode)) return newestRelease ? "nextUpdate" : "updateFirst";
    const { theme, addons } = row.catalog;
    const reports = [theme, addons].flatMap((pick) => (pick ? [pick.applied] : []));
    if (reports.length === 0) return "notAsked";
    for (const problem of ["failed", "unavailable", "asked"] as const) {
        if (reports.includes(problem)) return problem;
    }
    if (reports.includes(null)) return "waiting";
    return theme ? "applied" : "installed";
}

/** Whether the TV still has to act on a pick; the list refreshes until it has. */
export function catalogWaiting(row: TvRow): boolean {
    return catalogStatus(row) === "waiting";
}

/** The add-ons asked after toggling one. */
export function toggledAddons(current: readonly string[], id: string): string[] {
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    return next.sort();
}

function shotSrc(item: TvGalleryItem): string {
    return `/api/account/tv/catalog-shot?name=${encodeURIComponent(item.screenshot)}`;
}

export function TvCatalogPicker({
    row,
    newestRelease = false,
    load,
    onTheme,
    onAddons
}: {
    row: TvRow;
    /** The TV runs the newest release there is (or none is published), so no update is on offer. */
    newestRelease?: boolean;
    /** The catalog, asked once when the picker first opens (again after it could not be fetched). */
    load: () => Promise<TvCatalogEntry[] | null | "unreachable">;
    onTheme: (id: string) => void;
    onAddons: (ids: string[]) => void;
}) {
    const t = useTranslations("account");
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<TvCatalogEntry[] | null | "unreachable" | undefined>(
        undefined
    );
    const status = catalogStatus(row, newestRelease);
    const statusId = `tv-catalog-${row.id}`;
    const problem = status === "failed" || status === "unavailable" || status === "asked";
    const addons = row.catalog.addons?.ids ?? [];

    function fetchItems() {
        setItems(undefined);
        void load()
            .then(setItems)
            .catch(() => setItems("unreachable"));
    }

    function toggle() {
        const next = !open;
        setOpen(next);
        if (next && (items === undefined || items === "unreachable")) fetchItems();
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{t("tv.catalog.title")}</span>
                    <span
                        id={statusId}
                        className={
                            problem
                                ? "text-xs text-warning-ink"
                                : "truncate text-xs text-muted-foreground"
                        }
                    >
                        {t(`tv.catalog.status.${status}`)}
                    </span>
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={status === "updateFirst" || status === "nextUpdate"}
                    aria-expanded={open}
                    aria-describedby={statusId}
                    onClick={toggle}
                >
                    {open ? t("tv.catalog.close") : t("tv.catalog.open")}
                </Button>
            </div>
            {open ? (
                items === undefined ? (
                    <div
                        className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2"
                        aria-label={t("tv.catalog.loading")}
                        aria-busy
                    >
                        <Skeleton className="aspect-video w-full" />
                        <Skeleton className="aspect-video w-full" />
                    </div>
                ) : items === "unreachable" ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                        <p role="alert" className="min-w-0 text-sm text-warning-ink">
                            {t("tv.catalog.errors.unreachable")}
                        </p>
                        <Button size="sm" variant="outline" onClick={fetchItems}>
                            {t("tv.catalog.retry")}
                        </Button>
                    </div>
                ) : !items || items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("tv.catalog.none")}</p>
                ) : (
                    <TvGallery
                        items={items}
                        heading={false}
                        screenshotSrc={shotSrc}
                        action={(item) =>
                            item.kind === "theme" ? (
                                <Button
                                    size="sm"
                                    variant={
                                        row.catalog.theme?.id === item.id ? "primary" : "outline"
                                    }
                                    aria-pressed={row.catalog.theme?.id === item.id}
                                    onClick={() => {
                                        if (row.catalog.theme?.id !== item.id) onTheme(item.id);
                                    }}
                                >
                                    {row.catalog.theme?.id === item.id
                                        ? t("tv.catalog.themeInUse")
                                        : t("tv.catalog.useTheme")}
                                </Button>
                            ) : (
                                <Button
                                    size="sm"
                                    variant={addons.includes(item.id) ? "primary" : "outline"}
                                    aria-pressed={addons.includes(item.id)}
                                    onClick={() => onAddons(toggledAddons(addons, item.id))}
                                >
                                    {addons.includes(item.id)
                                        ? t("tv.catalog.removeAddon")
                                        : t("tv.catalog.addAddon")}
                                </Button>
                            )
                        }
                    />
                )
            ) : null}
        </div>
    );
}
