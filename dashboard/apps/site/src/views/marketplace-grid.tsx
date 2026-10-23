"use client";

/**
 * The dashboard's Marketplace, laid out the way the dashboard lays it out: a
 * search and a sort, the category buttons, the apps every Polaris comes with,
 * the Featured row, then the shelves by who is behind each app - with the same
 * store cards, each leading to the app's own page on this site. The whole list
 * is in the page, so filtering it needs no server.
 */

import Link from "next/link";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import * as store from "@polaris/ui/store-card";
import { BuiltInAppsSection } from "@polaris/ui/built-in-apps";
import { Badge, Button, Input, Select } from "@polaris/ui";
import {
    fill,
    filterSiteApps,
    siteCategories,
    siteShelves,
    STORE_SORTS,
    type BuiltInSiteApp,
    type BuiltInWords,
    type SiteApp,
    type SiteLocale,
    type StoreShot,
    type StoreSort,
    type StoreWords
} from "@/data/builders";

const base = () => process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** The mark the build rendered from the dashboard's own component; no input reaches it. */
function Markup({ html }: { html: string }) {
    return <span className="contents" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * An app's mark at `size` pixels: a Polaris app's own logo file, the same one
 * the dashboard draws, or the mark the build rendered for any other app.
 */
export function StoreAppMark({ app, size }: { app: SiteApp; size: 40 | 44 | 72 }) {
    if (!app.logo) return <Markup html={size === 72 ? app.markLarge : app.mark} />;
    const logo = Math.round(size * 0.9);
    return (
        <span className="grid shrink-0 place-items-center" style={{ width: size, height: size }}>
            <img
                src={`${base()}/app-logos/${app.logo}.svg`}
                width={logo}
                height={logo}
                alt=""
                aria-hidden="true"
            />
        </span>
    );
}

/** The capture's paths under the base path Pages serves the site from. */
function withBase(shot: StoreShot | null): StoreShot | null {
    if (!shot) return null;
    const theme = (entry: StoreShot["dark"]) => ({
        desktop: base() + entry.desktop,
        mobile: base() + entry.mobile
    });
    return { dark: theme(shot.dark), light: theme(shot.light) };
}

/** The "Installing accepts the <link>terms</link>" line, with its link. */
export function ConsentNote({ text, consent }: { text: string; consent: SiteApp["consent"] }) {
    if (!consent) return null;
    const [before, rest = ""] = fill(text, { label: consent.label }).split("<link>");
    const [inside, after = ""] = rest.split("</link>");
    return (
        <p className="text-xs text-muted-foreground">
            {before}
            <a
                href={consent.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
            >
                {inside}
            </a>
            {after}
        </p>
    );
}

/** The dashboard's store card, where the action is the way to the app's page. */
function StoreCard({
    app,
    page,
    words,
    featured = false
}: {
    app: SiteApp;
    page: string;
    words: StoreWords;
    featured?: boolean;
}) {
    return (
        <store.StoreCard
            muted={app.comingSoon}
            featured={featured}
            preview={
                // The name below is the link a keyboard reaches; the picture is
                // the same destination for a pointer.
                <Link href={page} tabIndex={-1} aria-hidden className="block border-b border-border">
                    <store.StorePreview
                        name={app.name}
                        summary={app.summary}
                        mark={<StoreAppMark app={app} size={44} />}
                        tint={app.tint}
                        ink={app.ink}
                        shot={withBase(app.shot)}
                        alt={app.alt}
                        eager={featured}
                    />
                </Link>
            }
            mark={<StoreAppMark app={app} size={40} />}
            title={
                <Link
                    href={page}
                    className="block truncate text-sm font-medium hover:underline"
                    title={app.name}
                >
                    {app.name}
                </Link>
            }
            byline={app.byline}
            summary={app.summary}
            badges={
                <>
                    <Badge>{app.categoryLabel}</Badge>
                    {app.capabilities.map((capability) => (
                        <Badge key={capability} className="text-muted-foreground">
                            {capability}
                        </Badge>
                    ))}
                </>
            }
            note={<ConsentNote text={words.consent} consent={app.consent} />}
            actions={
                app.comingSoon ? (
                    <Badge className="text-muted-foreground">{words.comingSoon}</Badge>
                ) : (
                    <Button asChild size="sm" variant="secondary">
                        <Link href={page}>{words.details}</Link>
                    </Button>
                )
            }
        />
    );
}

export function MarketplaceGrid({
    apps,
    builtIn,
    builtInWords,
    pages,
    locale,
    words
}: {
    apps: readonly SiteApp[];
    builtIn: readonly BuiltInSiteApp[];
    builtInWords: BuiltInWords;
    /** The marketplace's own path, which every app's page sits under. */
    pages: string;
    locale: SiteLocale;
    words: StoreWords;
}) {
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("");
    const [sort, setSort] = useState<StoreSort>("featured");
    const shown = useMemo(
        () => filterSiteApps(apps, { query, category, sort, locale }),
        [apps, query, category, sort, locale]
    );
    const browsing = !query.trim() && !category;
    const featured = browsing ? apps.filter((app) => app.featured) : [];
    const needle = query.trim().toLowerCase();
    const pageOf = (id: string) => `${pages}${id}/`;
    const builtInShown = builtIn.filter(
        (app) => !needle || app.name.toLowerCase().includes(needle)
    );
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <div className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="relative min-w-0 flex-1 basis-60 sm:max-w-md">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={words.search}
                            aria-label={words.search}
                            className="pl-8"
                        />
                    </div>
                    <Select
                        value={sort}
                        onValueChange={(value) => setSort(value as StoreSort)}
                        aria-label={words.sortLabel}
                        className="w-44"
                        options={STORE_SORTS.map((value) => ({ value, label: words.sorts[value] }))}
                    />
                </div>
                <div
                    role="group"
                    aria-label={words.categories}
                    className="flex min-w-0 flex-wrap gap-1.5"
                >
                    {[{ id: "", label: words.allCategories }, ...siteCategories(apps)].map(
                        (entry) => (
                            <Button
                                key={entry.id || "all"}
                                size="sm"
                                variant={category === entry.id ? "primary" : "secondary"}
                                aria-pressed={category === entry.id}
                                onClick={() => setCategory(entry.id)}
                            >
                                {entry.label}
                            </Button>
                        )
                    )}
                </div>
            </div>

            <BuiltInAppsSection
                    apps={builtInShown.map((app) => ({
                        id: app.id,
                        label: app.name,
                        href: pageOf(app.id),
                        replaces: app.replaces.map((item) => ({
                            name: item.name,
                            src: `${base()}/logos/${item.logo}.svg`
                        }))
                    }))}
                    words={builtInWords}
                    link={Link}
                />

            {featured.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-3" aria-label={words.featured}>
                    <h2 className="text-sm font-medium text-muted-foreground">{words.featured}</h2>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {featured.map((app) => (
                            <StoreCard
                                key={app.id}
                                app={app}
                                page={pageOf(app.id)}
                                words={words}
                                featured
                            />
                        ))}
                    </div>
                </section>
            ) : null}

            {shown.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{words.noMatch}</p>
            ) : (
                siteShelves(shown).map((group) => (
                    <section
                        key={group.shelf}
                        className="flex min-w-0 flex-col gap-3"
                        aria-label={words.shelves[group.shelf]}
                    >
                        <h2 className="text-sm font-medium text-muted-foreground">
                            {words.shelves[group.shelf]}
                        </h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {group.apps.map((app) => (
                                <StoreCard
                                    key={app.id}
                                    app={app}
                                    page={pageOf(app.id)}
                                    words={words}
                                />
                            ))}
                        </div>
                    </section>
                ))
            )}
        </div>
    );
}
