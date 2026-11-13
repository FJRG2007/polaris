"use client";

/**
 * The dashboard's Polaris apps screen, drawn from the same components: the
 * search, sort and category bar, the Featured row, then the shelves by who is
 * behind each app, with the apps every Polaris comes with as cards on the
 * Polaris shelf. What needs a signed-in server becomes a link: Install leads to
 * installing Polaris, Open and Details to the app's page on this site. The
 * whole list is in the page, so filtering it needs no server.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import * as store from "@polaris/ui/store-card";
import { AppLogo, Badge, Button } from "@polaris/ui";
import { OverflowMenu, StoreFilters, StoreNoMatch, StoreSection } from "@polaris/ui/store-layout";
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
    type StoreShelf,
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

/** A built-in app's mark, as the dashboard's `BuiltInMark` draws it: its logo, or its icon tile. */
function BuiltInAppMark({ app, size }: { app: BuiltInSiteApp; size: 40 | 44 }) {
    return (
        <AppLogo
            appId={app.id}
            size={size}
            fallback={<Markup html={size === 44 ? app.markPreview : app.mark} />}
        />
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

/** The card's picture: the name below is the link a keyboard reaches, this is a pointer's. */
function PreviewLink({ page, children }: { page: string; children: ReactNode }) {
    return (
        <Link href={page} tabIndex={-1} aria-hidden className="block border-b border-border">
            {children}
        </Link>
    );
}

function CardTitle({ page, name }: { page: string; name: string }) {
    return (
        <Link
            href={page}
            className="block truncate text-sm font-medium hover:underline"
            title={name}
        >
            {name}
        </Link>
    );
}

/** The card's overflow menu, holding Details as the dashboard's does. */
function DetailsMenu({ page, name, words }: { page: string; name: string; words: StoreWords }) {
    const router = useRouter();
    return (
        <OverflowMenu
            label={fill(words.more, { name })}
            entries={[{ key: "details", label: words.details, onSelect: () => router.push(page) }]}
        />
    );
}

/**
 * The dashboard's store card. Install leads to installing Polaris, since an
 * app is installed from a Polaris of one's own; Details is in the menu.
 */
function StoreCard({
    app,
    page,
    install,
    words,
    featured = false
}: {
    app: SiteApp;
    page: string;
    install: string;
    words: StoreWords;
    featured?: boolean;
}) {
    return (
        <store.StoreCard
            muted={app.comingSoon}
            featured={featured}
            preview={
                <PreviewLink page={page}>
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
                </PreviewLink>
            }
            mark={<StoreAppMark app={app} size={40} />}
            title={<CardTitle page={page} name={app.name} />}
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
                <>
                    {app.comingSoon ? (
                        <Badge className="text-muted-foreground">{words.comingSoon}</Badge>
                    ) : (
                        <Button asChild size="sm">
                            <Link href={install}>{words.install}</Link>
                        </Button>
                    )}
                    <DetailsMenu page={page} name={app.name} words={words} />
                </>
            }
        />
    );
}

/** An app every Polaris comes with, on the dashboard's built-in card. */
function BuiltInCard({
    app,
    page,
    words,
    builtInWords
}: {
    app: BuiltInSiteApp;
    page: string;
    words: StoreWords;
    builtInWords: BuiltInWords;
}) {
    return (
        <store.StoreCard
            preview={
                <PreviewLink page={page}>
                    <store.StorePreview
                        name={app.name}
                        summary={app.description}
                        mark={<BuiltInAppMark app={app} size={44} />}
                        tint={app.tint}
                        ink={app.ink}
                        shot={withBase(app.shot)}
                        alt={app.alt}
                    />
                </PreviewLink>
            }
            mark={<BuiltInAppMark app={app} size={40} />}
            title={<CardTitle page={page} name={app.name} />}
            byline={builtInWords.builtInBy}
            summary={app.description}
            badges={<Badge>{app.categoryLabel}</Badge>}
            status={<Badge>{builtInWords.badge}</Badge>}
            actions={
                <>
                    <Button asChild size="sm">
                        <Link href={page}>{builtInWords.open}</Link>
                    </Button>
                    <DetailsMenu page={page} name={app.name} words={words} />
                </>
            }
        />
    );
}

/** The shelves, with the Polaris one kept when only built-in apps match. */
function shelvesWith(
    shelves: Array<{ shelf: StoreShelf; apps: SiteApp[] }>,
    builtIns: boolean
): Array<{ shelf: StoreShelf; apps: SiteApp[] }> {
    if (!builtIns || shelves.some((group) => group.shelf === "polaris")) return shelves;
    return [{ shelf: "polaris", apps: [] }, ...shelves];
}

export function MarketplaceGrid({
    apps,
    builtIn,
    builtInWords,
    pages,
    install,
    locale,
    words
}: {
    apps: readonly SiteApp[];
    builtIn: readonly BuiltInSiteApp[];
    builtInWords: BuiltInWords;
    /** The marketplace's own path, which every app's page sits under. */
    pages: string;
    /** Where installing Polaris is explained, which every Install leads to. */
    install: string;
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
    const pageOf = (id: string) => `${pages}${id}/`;
    // As the dashboard: found by the same search, gone while a category is picked.
    const builtIns = useMemo(() => {
        if (category) return [];
        const needle = query.trim().toLocaleLowerCase(locale);
        const listed = builtIn.filter(
            (app) =>
                !needle ||
                `${app.name} ${app.description}`.toLocaleLowerCase(locale).includes(needle)
        );
        return sort === "name"
            ? [...listed].sort((a, b) => a.name.localeCompare(b.name, locale))
            : listed;
    }, [builtIn, category, query, sort, locale]);
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <StoreFilters
                query={query}
                onQueryChange={setQuery}
                sort={sort}
                onSortChange={setSort}
                sorts={STORE_SORTS.map((value) => ({ value, label: words.sorts[value] }))}
                category={category}
                onCategoryChange={setCategory}
                categories={[{ id: "", label: words.allCategories }, ...siteCategories(apps)].map(
                    (entry) => ({ value: entry.id, label: entry.label })
                )}
                words={words}
            />

            {featured.length > 0 ? (
                <StoreSection label={words.featured} featured>
                    {featured.map((app) => (
                        <StoreCard
                            key={app.id}
                            app={app}
                            page={pageOf(app.id)}
                            install={install}
                            words={words}
                            featured
                        />
                    ))}
                </StoreSection>
            ) : null}

            {shown.length === 0 && builtIns.length === 0 ? (
                <StoreNoMatch>{words.noMatch}</StoreNoMatch>
            ) : (
                shelvesWith(siteShelves(shown), builtIns.length > 0).map((group) => (
                    <StoreSection key={group.shelf} label={words.shelves[group.shelf]}>
                        {group.apps.map((app) => (
                            <StoreCard
                                key={app.id}
                                app={app}
                                page={pageOf(app.id)}
                                install={install}
                                words={words}
                            />
                        ))}
                        {group.shelf === "polaris" &&
                            builtIns.map((app) => (
                                <div key={`built-in:${app.id}`} className="min-w-0">
                                    <BuiltInCard
                                        app={app}
                                        page={pageOf(app.id)}
                                        words={words}
                                        builtInWords={builtInWords}
                                    />
                                </div>
                            ))}
                    </StoreSection>
                ))
            )}
        </div>
    );
}
