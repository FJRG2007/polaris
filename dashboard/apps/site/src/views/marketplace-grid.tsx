"use client";

/**
 * The dashboard's Polaris apps screen, drawn from the same components: the
 * search, sort and category bar, the Featured row, then the shelves by who is
 * behind each app, with the apps every Polaris comes with as cards on the
 * Polaris shelf. What needs a signed-in server becomes a link: Install leads to
 * installing Polaris, Open and Details to the app's page on this site. The
 * device plugins of the published catalog follow on a shelf of their own, each
 * card marked as a plugin, and a kind switch above the search keeps the two
 * apart. The whole list is in the page, so filtering it needs no server.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import * as store from "@polaris/ui/store-card";
import { Package } from "lucide-react";
import { AppLogo, Badge, Button, SegmentedControl } from "@polaris/ui";
import { OverflowMenu, StoreFilters, StoreNoMatch, StoreSection } from "@polaris/ui/store-layout";
import {
    pluginCategories,
    fill,
    filterSitePlugins,
    filterSiteApps,
    kindShows,
    PLUGIN_CATEGORY_PREFIX,
    MARKET_KINDS,
    siteCategories,
    siteShelves,
    STORE_SORTS,
    type PluginWords,
    type BuiltInSiteApp,
    type MarketKind,
    type SitePlugin,
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
    kindApp,
    featured = false
}: {
    app: SiteApp;
    page: string;
    install: string;
    words: StoreWords;
    /** The "App" badge, set against the plugins' own. */
    kindApp: string;
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
                    <Badge>{kindApp}</Badge>
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
    builtInWords,
    kindApp
}: {
    app: BuiltInSiteApp;
    page: string;
    words: StoreWords;
    builtInWords: BuiltInWords;
    kindApp: string;
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
            badges={
                <>
                    <Badge>{kindApp}</Badge>
                    <Badge>{app.categoryLabel}</Badge>
                </>
            }
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

/** A device plugin's mark: its published icon, or the package the dashboard's store draws. */
export function PluginMark({ plugin, size }: { plugin: SitePlugin; size: 40 | 56 | 72 }) {
    if (plugin.icon)
        return (
            <img
                src={`${base()}/plugin-icons/${plugin.icon}`}
                width={size}
                height={size}
                alt=""
                aria-hidden="true"
                className="shrink-0 rounded-md"
            />
        );
    return (
        <span
            className="grid shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
            style={{ width: size, height: size }}
            aria-hidden="true"
        >
            <Package style={{ width: size * 0.5, height: size * 0.5 }} />
        </span>
    );
}

/** The "Plugin" badge, tinted so it never reads as one of the apps' category badges. */
export function PluginKindBadge({ label }: { label: string }) {
    return <Badge className="border-primary/40 text-primary">{label}</Badge>;
}

/** A device plugin, on the store's card; Install leads to its page, which says where it installs. */
function PluginCard({
    plugin,
    page,
    words,
    pluginWords
}: {
    plugin: SitePlugin;
    page: string;
    words: StoreWords;
    pluginWords: PluginWords;
}) {
    return (
        <store.StoreCard
            preview={
                <PreviewLink page={page}>
                    <div className="grid aspect-[16/10] place-items-center bg-muted">
                        <PluginMark plugin={plugin} size={56} />
                    </div>
                </PreviewLink>
            }
            mark={<PluginMark plugin={plugin} size={40} />}
            title={<CardTitle page={page} name={plugin.name} />}
            byline={plugin.byline}
            summary={plugin.summary}
            badges={
                <>
                    <PluginKindBadge label={pluginWords.kindPlugin} />
                    <Badge>{plugin.categoryLabel}</Badge>
                </>
            }
            actions={
                <>
                    <Button asChild size="sm">
                        <Link href={`${page}#install`}>{words.install}</Link>
                    </Button>
                    <DetailsMenu page={page} name={plugin.name} words={words} />
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
    words,
    plugins,
    pluginWords
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
    /** The device plugins of the published catalog; their pages sit under `plugins/`. */
    plugins: readonly SitePlugin[];
    pluginWords: PluginWords;
}) {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<MarketKind>("all");
    const [category, setCategory] = useState("");
    const [sort, setSort] = useState<StoreSort>("featured");
    const showsApps = kindShows(kind, category, "apps");
    const showsPlugins = kindShows(kind, category, "plugins");
    const shown = useMemo(
        () => (showsApps ? filterSiteApps(apps, { query, category, sort, locale }) : []),
        [apps, showsApps, query, category, sort, locale]
    );
    const shownPlugins = useMemo(
        () => (showsPlugins ? filterSitePlugins(plugins, { query, category, sort, locale }) : []),
        [plugins, showsPlugins, query, category, sort, locale]
    );
    const browsing = !query.trim() && !category && kind !== "plugins";
    const featured = browsing ? apps.filter((app) => app.featured) : [];
    const pageOf = (id: string) => `${pages}${id}/`;
    const pluginPageOf = (id: string) => `${pages}plugins/${id}/`;
    // The categories of what the kind lists: the apps' first, then the plugins'.
    const categories = [
        ...(kind === "plugins" ? [] : siteCategories(apps)),
        ...(kind === "apps" ? [] : pluginCategories(plugins))
    ];
    // A category the new kind does not list is let go, so the list never empties silently.
    const pickKind = (next: MarketKind) => {
        setKind(next);
        const of = category.startsWith(PLUGIN_CATEGORY_PREFIX) ? "plugins" : "apps";
        if (category && !kindShows(next, category, of)) setCategory("");
    };
    // As the dashboard: found by the same search, gone while a category is picked.
    const builtIns = useMemo(() => {
        if (category || !showsApps) return [];
        const needle = query.trim().toLocaleLowerCase(locale);
        const listed = builtIn.filter(
            (app) =>
                !needle ||
                `${app.name} ${app.description}`.toLocaleLowerCase(locale).includes(needle)
        );
        return sort === "name"
            ? [...listed].sort((a, b) => a.name.localeCompare(b.name, locale))
            : listed;
    }, [builtIn, category, showsApps, query, sort, locale]);
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <SegmentedControl
                value={kind}
                onValueChange={pickKind}
                aria-label={pluginWords.kinds.label}
                className="w-fit max-w-full"
                options={MARKET_KINDS.map((value) => ({
                    value,
                    label: pluginWords.kinds[value]
                }))}
            />
            <StoreFilters
                query={query}
                onQueryChange={setQuery}
                sort={sort}
                onSortChange={setSort}
                sorts={STORE_SORTS.map((value) => ({ value, label: words.sorts[value] }))}
                category={category}
                onCategoryChange={setCategory}
                categories={[{ id: "", label: words.allCategories }, ...categories].map(
                    (entry) => ({ value: entry.id, label: entry.label })
                )}
                words={kind === "plugins" ? { ...words, search: pluginWords.search } : words}
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
                            kindApp={pluginWords.kindApp}
                            featured
                        />
                    ))}
                </StoreSection>
            ) : null}

            {shown.length === 0 && builtIns.length === 0 && shownPlugins.length === 0 ? (
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
                                kindApp={pluginWords.kindApp}
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
                                        kindApp={pluginWords.kindApp}
                                    />
                                </div>
                            ))}
                    </StoreSection>
                ))
            )}

            {shownPlugins.length > 0 ? (
                <StoreSection label={pluginWords.shelf}>
                    {shownPlugins.map((plugin) => (
                        <PluginCard
                            key={plugin.id}
                            plugin={plugin}
                            page={pluginPageOf(plugin.id)}
                            words={words}
                            pluginWords={pluginWords}
                        />
                    ))}
                </StoreSection>
            ) : null}
        </div>
    );
}
