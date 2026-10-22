"use client";

/**
 * The catalogue as cards, with a search and a category filter that work in the
 * browser: the whole list is in the page, so filtering it needs no server.
 */

import { useState } from "react";
import { Badge, Input, SegmentedControl } from "@polaris/ui";
import { fill, matchesApp, siteCategories, type SiteApp } from "@/data/builders";

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
    const options = [{ value: "", label: t.all }, ...siteCategories(apps).map((entry) => ({ value: entry.id, label: entry.label }))];
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
                    <SegmentedControl value={category} onValueChange={setCategory} options={options} aria-label={t.all} />
                </div>
                <span className="text-xs text-muted-foreground">{fill(t.count, { n: shown.length })}</span>
            </div>
            {shown.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t.empty}</p>
            ) : (
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {shown.map((app) => (
                        <li key={app.id} id={app.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4">
                            <div className="flex min-w-0 items-center gap-3">
                                <span
                                    className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface text-foreground"
                                    // Rendered by the build from the catalogue's own icon; no input reaches it.
                                    dangerouslySetInnerHTML={{ __html: app.icon }}
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate font-semibold" title={app.name}>{app.name}</p>
                                    <p className="truncate text-xs text-muted-foreground">{app.categoryLabel}</p>
                                </div>
                            </div>
                            <p className="text-sm text-muted-foreground">{app.summary}</p>
                            <div className="mt-auto flex flex-wrap gap-1.5">
                                <Badge variant="neutral">{app.builtin ? t.builtin : t.optional}</Badge>
                                {app.comingSoon ? <Badge variant="neutral">{t.soon}</Badge> : null}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
