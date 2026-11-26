/**
 * A device plugin's page: the way back, its mark, name, publisher and summary,
 * how it is installed (from the desktop app on the computer the device is
 * plugged into, never from a server), then what it runs on, the devices it
 * drives, what installing it allows, what changed and its facts. Read at build
 * time from the manifest CI signs into the plugin catalog.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge, Button } from "@polaris/ui";
import { href, siteData, words } from "@/lib/site";
import { PluginKindBadge, PluginMark } from "@/views/marketplace-grid";
import { fill, type SitePlugin, type SiteLocale } from "@/data/builders";

/** The plugin `id` in `locale`, or undefined. */
export function findPlugin(locale: SiteLocale, id: string): SitePlugin | undefined {
    return siteData().locales[locale].plugins.find((plugin) => plugin.id === id);
}

/** Every plugin with a page, for `generateStaticParams`. */
export function pluginIds(locale: SiteLocale): string[] {
    return siteData().locales[locale].plugins.map((plugin) => plugin.id);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <h2 className="text-sm font-medium">{title}</h2>
            {children}
        </section>
    );
}

function Lines({ lines }: { lines: readonly string[] }) {
    return (
        <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-muted-foreground">
            {lines.map((line) => (
                <li key={line} className="break-words">
                    {line}
                </li>
            ))}
        </ul>
    );
}

export function PluginPageView({ locale, plugin }: { locale: SiteLocale; plugin: SitePlugin }) {
    const data = siteData().locales[locale];
    const t = data.pluginWords;
    const own = words(locale).market.plugin;
    const facts = [
        { label: own.version, value: plugin.version },
        { label: own.minApp, value: fill(own.minAppValue, { version: plugin.minAppVersion }) },
        { label: t.publisher, value: plugin.publisher },
        { label: own.category, value: plugin.categoryLabel }
    ];
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <Link
                href={href(locale, "marketplace/")}
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {data.builtInWords.back}
            </Link>

            <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
                <PluginMark plugin={plugin} size={72} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 className="break-words text-2xl font-semibold">{plugin.name}</h1>
                    <p className="break-words text-sm text-muted-foreground">{plugin.byline}</p>
                    <p className="break-words text-sm">{plugin.summary}</p>
                    <div className="flex flex-wrap gap-1 pt-1">
                        <PluginKindBadge label={t.kindPlugin} />
                        <Badge>{plugin.categoryLabel}</Badge>
                    </div>
                </div>
            </header>

            <section id="install" className="flex min-w-0 scroll-mt-20 flex-col gap-3">
                <h2 className="text-sm font-medium">{own.installTitle}</h2>
                <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm">
                    {own.installSteps.map((step) => (
                        <li key={step} className="break-words">
                            {fill(step, { name: plugin.name })}
                        </li>
                    ))}
                </ol>
                <div className="flex flex-wrap items-center gap-2">
                    <Button asChild>
                        <Link href={href(locale, "downloads/")}>{own.getDesktop}</Link>
                    </Button>
                </div>
                <p className="text-sm text-muted-foreground">{own.installHint}</p>
            </section>

            <Section title={own.platforms}>
                <div className="flex flex-wrap gap-1">
                    {plugin.platforms.map((platform) => (
                        <Badge key={platform}>{platform}</Badge>
                    ))}
                </div>
            </Section>

            {plugin.devices.length > 0 ? (
                <Section title={own.devices}>
                    <Lines lines={plugin.devices} />
                </Section>
            ) : null}

            <Section title={t.permissions}>
                <Lines lines={plugin.permissions.length > 0 ? plugin.permissions : [t.noPermissions]} />
            </Section>

            {plugin.changelog ? (
                <Section title={t.changelog}>
                    <p className="whitespace-pre-line break-words text-sm text-muted-foreground">
                        {plugin.changelog}
                    </p>
                </Section>
            ) : null}

            <Section title={data.store.information}>
                <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                    {facts.map((fact) => (
                        <div key={fact.label} className="contents">
                            <dt className="text-muted-foreground">{fact.label}</dt>
                            <dd className="min-w-0 break-words">{fact.value}</dd>
                        </div>
                    ))}
                </dl>
            </Section>
        </div>
    );
}
