/**
 * A built-in app's page: the dashboard's store page for an app, drawn from what
 * the build read off the dashboard - its logo, name and description, the README
 * captures that show it, and what it replaces. An app nobody has captured yet
 * has no pictures section rather than a placeholder picture.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppLogo } from "@polaris/ui";
import { ReplacedLogos } from "@polaris/ui/built-in-apps";
import { ShotGallery, type Shot } from "@/components/shot-gallery";
import { asset, href, siteData, words, type Words } from "@/lib/site";
import { fill, type BuiltInSiteApp, type ShowcaseItem, type SiteLocale } from "@/data/builders";

function shot(item: ShowcaseItem): Shot {
    return {
        name: item.name,
        caption: item.caption,
        alt: item.alt,
        dark: asset(`media/${item.dark}`),
        light: item.light ? asset(`media/${item.light}`) : null
    };
}

/** Built-in app `id` in `locale`, or undefined for an id that is not one. */
export function findBuiltIn(locale: SiteLocale, id: string): BuiltInSiteApp | undefined {
    return siteData().locales[locale].builtIn.find((app) => app.id === id);
}

export function BuiltInAppView({ locale, app }: { locale: SiteLocale; app: BuiltInSiteApp }) {
    const t = siteData().locales[locale].builtInWords;
    const viewer: Words["viewer"] = words(locale).viewer;
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <Link
                href={href(locale, "marketplace/")}
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {t.back}
            </Link>

            <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
                <AppLogo appId={app.id} size={72} className="shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 className="break-words text-2xl font-semibold">{app.name}</h1>
                    <p className="break-words text-sm text-muted-foreground">
                        {fill(t.by, { developer: "Polaris" })}
                    </p>
                    <p className="break-words text-sm">{app.description}</p>
                    <p className="break-words text-sm text-muted-foreground">{t.needsNothing}</p>
                </div>
            </header>

            {app.shots.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-3" aria-label={t.screenshots}>
                    <h2 className="text-sm font-medium">{t.screenshots}</h2>
                    <ShotGallery shots={app.shots.map(shot)} words={viewer} />
                </section>
            ) : null}

            {app.replaces.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-2">
                    <h2 className="text-sm font-medium">{t.replaces}</h2>
                    <ReplacedLogos
                        items={app.replaces.map((item) => ({
                            name: item.name,
                            src: asset(`logos/${item.logo}.svg`)
                        }))}
                        label={t.replaces}
                    />
                </section>
            ) : null}
        </div>
    );
}
