/**
 * Every Polaris TV theme and add-on with its screenshot, filterable by kind: the
 * same list the launcher's Themes & add-ons screen reads from catalog.json
 * (tv/tools/catalog.py). The caller hands the items and where a screenshot is
 * served from, so the site and the dashboard can each point at their own copy.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "../i18n";
import { Badge } from "../components/badge";
import { Button } from "../components/button";

export type TvGalleryKind = "theme" | "addon";

/** One catalog.json entry, as far as the gallery needs it. */
export interface TvGalleryItem {
    readonly id: string;
    readonly kind: TvGalleryKind;
    readonly name: string;
    readonly description: string;
    readonly network: boolean;
    readonly minSdk: number | null;
    readonly screenshot: string;
}

const FILTERS = ["all", "theme", "addon"] as const;
type Filter = (typeof FILTERS)[number];

/** Android's API level as the version people know (API 26 is Android 8). */
const ANDROID_VERSION: Readonly<Record<number, string>> = {
    21: "5",
    22: "5.1",
    23: "6",
    24: "7",
    25: "7.1",
    26: "8",
    27: "8.1",
    28: "9",
    29: "10",
    30: "11",
    31: "12",
    32: "12L",
    33: "13",
    34: "14",
    35: "15",
    36: "16"
};

export function TvGallery({
    items,
    screenshotSrc
}: {
    items: readonly TvGalleryItem[];
    screenshotSrc: (item: TvGalleryItem) => string;
}) {
    const t = useTranslations("tvCompat");
    const [filter, setFilter] = useState<Filter>("all");
    const counts = useMemo(
        () => ({
            all: items.length,
            theme: items.filter((item) => item.kind === "theme").length,
            addon: items.filter((item) => item.kind === "addon").length
        }),
        [items]
    );
    const shown = filter === "all" ? items : items.filter((item) => item.kind === filter);
    return (
        <section className="flex min-w-0 flex-col gap-4" aria-labelledby="tv-gallery-title">
            <div className="flex min-w-0 flex-col gap-1">
                <h2 id="tv-gallery-title" className="text-xl font-semibold">
                    {t("gallery.title")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("gallery.intro")}</p>
            </div>
            <div
                role="group"
                aria-label={t("gallery.filter.label")}
                className="flex flex-wrap gap-2"
            >
                {FILTERS.map((key) => (
                    <Button
                        key={key}
                        variant={filter === key ? "primary" : "outline"}
                        aria-pressed={filter === key}
                        onClick={() => setFilter(key)}
                    >
                        {t(`gallery.filter.${key}`, { count: counts[key] })}
                    </Button>
                ))}
            </div>
            {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("gallery.empty")}</p>
            ) : (
                <ul className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {shown.map((item) => (
                        <li
                            key={`${item.kind}/${item.id}`}
                            className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border"
                        >
                            <img
                                src={screenshotSrc(item)}
                                alt={t("gallery.screenshot", { name: item.name })}
                                loading="lazy"
                                className="aspect-video w-full bg-muted object-cover"
                            />
                            <div className="flex min-w-0 flex-col gap-2 p-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    <h3 className="min-w-0 truncate font-medium" title={item.name}>
                                        {item.name}
                                    </h3>
                                    <Badge variant={item.kind === "theme" ? "primary" : "neutral"}>
                                        {t(`gallery.kind.${item.kind}`)}
                                    </Badge>
                                </div>
                                <p
                                    className="line-clamp-3 text-sm text-muted-foreground"
                                    title={item.description}
                                >
                                    {item.description}
                                </p>
                                <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                                    <span>
                                        {t(item.network ? "gallery.network" : "gallery.offline")}
                                    </span>
                                    {item.minSdk && ANDROID_VERSION[item.minSdk] ? (
                                        <span>
                                            {t("gallery.minSdk", {
                                                version: ANDROID_VERSION[item.minSdk]
                                            })}
                                        </span>
                                    ) : null}
                                </p>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
