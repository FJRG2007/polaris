/**
 * An app's page, laid out like the dashboard's Marketplace page for it
 * (`apps/marketplace/[appId]/app-detail.tsx`): the way back, the mark, name,
 * byline and summary, the action, the captures, the games, About, what it
 * replaces, what it does, what it needs and its Information list - every word
 * read from the dashboard at build time.
 *
 * The site cannot install anything, so the action is the way to install
 * Polaris, where the app installs in one click. A built-in app comes with
 * every Polaris and has the dashboard's built-in facts instead.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { AppLogo, Badge, Button } from "@polaris/ui";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { ReplacedLogos } from "@polaris/ui/built-in-apps";
import { asset, href, siteData, words } from "@/lib/site";
import { ShotCarousel, type Shot } from "@/components/shot-gallery";
import { ConsentNote, StoreAppMark } from "@/views/marketplace-grid";
import {
    fill,
    type BuiltInSiteApp,
    type ShowcaseItem,
    type SiteApp,
    type SiteLocale
} from "@/data/builders";

function shot(item: ShowcaseItem): Shot {
    return {
        name: item.name,
        caption: item.caption,
        alt: item.alt,
        dark: asset(`media/${item.dark}`),
        light: item.light ? asset(`media/${item.light}`) : null,
        darkMobile: item.darkMobile ? asset(`media/${item.darkMobile}`) : null,
        lightMobile: item.lightMobile ? asset(`media/${item.lightMobile}`) : null
    };
}

/** The app `id` in `locale` - a Marketplace app or a built-in one - or undefined. */
export function findApp(
    locale: SiteLocale,
    id: string
): { store: SiteApp } | { builtIn: BuiltInSiteApp } | undefined {
    const data = siteData().locales[locale];
    const store = data.apps.find((app) => app.id === id);
    if (store) return { store };
    const builtIn = data.builtIn.find((app) => app.id === id);
    return builtIn ? { builtIn } : undefined;
}

/** Every app with a page, for `generateStaticParams`. */
export function appIds(locale: SiteLocale): string[] {
    const data = siteData().locales[locale];
    return [...data.builtIn, ...data.apps].map((app) => app.id);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <h2 className="text-sm font-medium">{title}</h2>
            {children}
        </section>
    );
}

export function AppPageView({
    locale,
    app
}: {
    locale: SiteLocale;
    app: { store: SiteApp } | { builtIn: BuiltInSiteApp };
}) {
    const data = siteData().locales[locale];
    const t = data.store;
    const builtInWords = data.builtInWords;
    const market = words(locale).market;
    const store = "store" in app ? app.store : null;
    const builtIn = "builtIn" in app ? app.builtIn : null;
    const name = store?.name ?? builtIn!.name;
    const shots = (store?.shots ?? builtIn!.shots).map(shot);
    const replaces = store ? store.replaces : builtIn!.replaces;
    const needs = store?.needs ?? [builtInWords.needsNothing];
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <Link
                href={href(locale, "marketplace/")}
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {builtInWords.back}
            </Link>

            <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
                {store ? (
                    <StoreAppMark app={store} size={72} />
                ) : (
                    <AppLogo appId={builtIn!.id} size={72} className="shrink-0" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 className="break-words text-2xl font-semibold">{name}</h1>
                    <p className="break-words text-sm text-muted-foreground">
                        {store?.byline ?? fill(builtInWords.by, { developer: "Polaris" })}
                    </p>
                    <p className="break-words text-sm">{store?.summary ?? builtIn!.description}</p>
                </div>
            </header>

            <section className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    {store?.comingSoon ? (
                        <Badge className="text-muted-foreground">{t.comingSoon}</Badge>
                    ) : (
                        <Button asChild>
                            <Link href={`${href(locale)}#start`}>{market.installPolaris}</Link>
                        </Button>
                    )}
                </div>
                <p className="text-sm text-muted-foreground">
                    {store ? market.installHint : builtInWords.needsNothing}
                </p>
                {store ? <ConsentNote text={t.consent} consent={store.consent} /> : null}
            </section>

            {shots.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-3" aria-label={builtInWords.screenshots}>
                    <ShotCarousel title={builtInWords.screenshots} shots={shots} words={words(locale).viewer} />
                </section>
            ) : null}

            {store && store.games.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-3" aria-label={t.games}>
                    <h2 className="text-sm font-medium">{t.games}</h2>
                    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {store.games.map((game) => (
                            <li
                                key={game.id}
                                className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-3"
                            >
                                <img
                                    src={asset(game.logo)}
                                    alt=""
                                    aria-hidden="true"
                                    className="size-10 shrink-0 object-contain"
                                />
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <span className="truncate text-sm font-medium" title={game.name}>
                                        {game.name}
                                    </span>
                                    <span className="text-xs text-muted-foreground">{game.summary}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {store ? (
                <Section title={t.about}>
                    <p className="whitespace-pre-line break-words text-sm text-muted-foreground">
                        {store.description}
                    </p>
                </Section>
            ) : null}

            {replaces.length > 0 ? (
                <Section title={builtInWords.replaces}>
                    <ReplacedLogos
                        items={replaces.map((item) => ({
                            name: item.name,
                            src: asset(`logos/${item.logo}.svg`)
                        }))}
                        label={builtInWords.replaces}
                    />
                </Section>
            ) : null}

            {store && store.capabilities.length > 0 ? (
                <Section title={t.features}>
                    <div className="flex flex-wrap gap-1">
                        {store.capabilities.map((capability) => (
                            <Badge key={capability}>{capability}</Badge>
                        ))}
                    </div>
                </Section>
            ) : null}

            {store ? (
                <Section title={t.needs}>
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                        {needs.map((line) => (
                            <li key={line} className="break-words">
                                {line}
                            </li>
                        ))}
                    </ul>
                </Section>
            ) : null}

            {store ? (
                <Section title={t.information}>
                    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                        {store.facts.map((fact) => (
                            <div key={fact.label} className="contents">
                                <dt className="text-muted-foreground">{fact.label}</dt>
                                <dd className="min-w-0 break-words">
                                    {fact.href ? (
                                        <a
                                            href={fact.href}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex min-w-0 items-center gap-1 break-all underline underline-offset-2"
                                        >
                                            {fact.value}
                                            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                                        </a>
                                    ) : fact.code ? (
                                        <code className="break-all text-xs">{fact.value}</code>
                                    ) : (
                                        fact.value
                                    )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </Section>
            ) : null}
        </div>
    );
}
