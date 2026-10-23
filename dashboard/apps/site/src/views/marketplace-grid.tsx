"use client";

/**
 * The catalogue as cards, with a search and a category filter that work in the
 * browser: the whole list is in the page, so filtering it needs no server.
 */

import { useState } from "react";
import * as store from "@polaris/ui/store-card";
import { Badge, Input, SegmentedControl } from "@polaris/ui";
import { fill, matchesApp, siteCategories, type SiteApp } from "@/data/builders";

/** The mark the build rendered from the dashboard's own component; no input reaches it. */
function Markup({ html }: { html: string }) {
    return <span className="contents" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * An app's mark at `size` pixels: a Polaris app's own logo file, the same one
 * the dashboard draws, or the mark the build rendered for any other app.
 */
function AppMark({ app, size }: { app: SiteApp; size: number }) {
    if (!app.logo) return <Markup html={size > 40 ? app.markLarge : app.mark} />;
    const logo = Math.round(size * 0.9);
    return (
        <span className="grid shrink-0 place-items-center" style={{ width: size, height: size }}>
            <img
                src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/app-logos/${app.logo}.svg`}
                width={logo}
                height={logo}
                alt=""
                aria-hidden="true"
            />
        </span>
    );
}

/** The capture's paths under the base path Pages serves the site from. */
function withBase(shot: store.StoreShot | null): store.StoreShot | null {
    if (!shot) return null;
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const theme = (entry: store.StoreShot["dark"]) => ({
        desktop: base + entry.desktop,
        mobile: base + entry.mobile
    });
    return { dark: theme(shot.dark), light: theme(shot.light) };
}

export interface MarketWords {
    readonly search: string;
    readonly all: string;
    readonly builtin: string;
    readonly optional: string;
    readonly soon: string;
    readonly empty: string;
    readonly count: string;
}

export function MarketplaceGrid({ apps, t }: { apps: readonly SiteApp[]; t: MarketWords }) {
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("");
    const shown = apps.filter((app) => matchesApp(app, query, category));
    const options = [
        { value: "", label: t.all },
        ...siteCategories(apps).map((entry) => ({ value: entry.id, label: entry.label }))
    ];
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t.search}
                    aria-label={t.search}
                    className="w-full sm:w-72"
                />
                <div className="max-w-full overflow-x-auto">
                    <SegmentedControl
                        value={category}
                        onValueChange={setCategory}
                        options={options}
                        aria-label={t.all}
                    />
                </div>
                <span className="text-xs text-muted-foreground">
                    {fill(t.count, { n: shown.length })}
                </span>
            </div>
            {shown.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    {t.empty}
                </p>
            ) : (
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {shown.map((app) => (
                        <li key={app.id} id={app.id} className="min-w-0">
                            <store.StoreCard
                                muted={app.comingSoon}
                                preview={
                                    <store.StorePreview
                                        className="border-b border-border"
                                        name={app.name}
                                        summary={app.summary}
                                        mark={<AppMark app={app} size={44} />}
                                        tint={app.tint}
                                        ink={app.ink}
                                        shot={withBase(app.shot)}
                                        alt={app.alt}
                                    />
                                }
                                mark={<AppMark app={app} size={40} />}
                                title={
                                    <p className="truncate text-sm font-medium" title={app.name}>
                                        {app.name}
                                    </p>
                                }
                                byline={app.byline}
                                summary={app.summary}
                                badges={<Badge>{app.categoryLabel}</Badge>}
                                status={<Badge>{app.builtin ? t.builtin : t.optional}</Badge>}
                                actions={
                                    app.comingSoon ? (
                                        <Badge className="text-muted-foreground">{t.soon}</Badge>
                                    ) : null
                                }
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
