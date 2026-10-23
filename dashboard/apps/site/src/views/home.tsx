/**
 * The landing page: one promise, the one line that installs it, the product
 * as it really looks, what it replaces, how it goes from there, and the same
 * line again at the end for whoever scrolled to decide.
 */

import Link from "next/link";
import { buttonVariants, cn } from "@polaris/ui";
import { asset, href, siteData, words } from "@/lib/site";
import { InstallCommand } from "@/components/install-command";
import type { ShowcaseItem, SiteLocale } from "@/data/builders";
import { ShotGallery, type Shot } from "@/components/shot-gallery";
import { FeatureTabs, type Feature } from "@/components/feature-tabs";
import { ArrowRight, Globe, MousePointerClick, TerminalSquare } from "lucide-react";

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

function SectionHead({ id, title, intro }: { id: string; title: string; intro: string }) {
    return (
        <div className="flex max-w-2xl flex-col gap-2">
            <h2 id={id} className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                {title}
            </h2>
            <p className="text-pretty text-muted-foreground">{intro}</p>
        </div>
    );
}

/**
 * The tour's tabs: the features the README leads with first, then every other
 * app that has a capture. Each plays its first capture, captioned with the
 * dashboard's own line for it, and leads to its marketplace page.
 */
const MAIN_FEATURES = ["apps", "drive", "chat", "tasks", "mail", "game-servers"];
const MORE_FEATURES = [
    "polar",
    "office",
    "vault",
    "notes",
    "automations",
    "watch",
    "calendar",
    "home"
];

function tourFeatures(locale: SiteLocale): { main: Feature[]; more: Feature[] } {
    const { apps, builtIn } = siteData().locales[locale];
    const feature = (id: string): Feature[] => {
        const own = builtIn.find((app) => app.id === id);
        const store = apps.find((app) => app.id === id);
        const name = own?.name ?? store?.name;
        const lead = (own?.shots ?? store?.shots ?? [])[0];
        if (!name || !lead) return [];
        return [
            {
                id,
                label: name,
                caption: own?.description ?? store!.summary,
                alt: lead.alt,
                dark: asset(`media/${lead.dark}`),
                light: lead.light ? asset(`media/${lead.light}`) : null,
                darkMobile: lead.darkMobile ? asset(`media/${lead.darkMobile}`) : null,
                lightMobile: lead.lightMobile ? asset(`media/${lead.lightMobile}`) : null,
                href: href(locale, `marketplace/${id}/`)
            }
        ];
    };
    return { main: MAIN_FEATURES.flatMap(feature), more: MORE_FEATURES.flatMap(feature) };
}

export function HomeView({ locale }: { locale: SiteLocale }) {
    const all = words(locale);
    const t = all.home;
    const data = siteData();
    const { replaces, showcase } = data.locales[locale];
    const commands = { unix: data.install.unix ?? "", windows: data.install.windows ?? "" };
    const installWords = { unix: t.unix, windows: t.windows, system: t.system, copy: t.copy };
    const lead = showcase[0]?.items[0];
    const steps = [
        { icon: TerminalSquare, title: t.step1Title, body: t.step1Body },
        { icon: MousePointerClick, title: t.step2Title, body: t.step2Body },
        { icon: Globe, title: t.step3Title, body: t.step3Body }
    ];
    return (
        <>
            <section className="flex flex-col items-center gap-6 pt-8 text-center sm:pt-14">
                <span className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                    {t.eyebrow}
                </span>
                <h1 className="max-w-4xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
                    {t.title}
                </h1>
                <p className="max-w-2xl text-pretty text-lg text-muted-foreground">{t.intro}</p>
                <InstallCommand
                    commands={commands}
                    labels={installWords}
                    className="max-w-3xl text-left"
                />
                <p className="text-xs text-muted-foreground">{t.installHint}</p>
                <div className="flex flex-wrap justify-center gap-2">
                    <Link
                        href={href(locale, "docs/")}
                        className={buttonVariants({ variant: "primary" })}
                    >
                        {t.readDocs}
                        <ArrowRight className="size-4" />
                    </Link>
                    <a
                        href={`https://github.com/${data.repo}`}
                        className={buttonVariants({ variant: "outline" })}
                    >
                        {t.github}
                    </a>
                </div>
                {lead ? (
                    <div className="mt-4 w-full max-w-5xl">
                        <ShotGallery shots={[shot(lead)]} words={all.viewer} hero />
                    </div>
                ) : null}
            </section>

            <section aria-labelledby="tour" className="flex flex-col gap-6">
                <SectionHead id="tour" title={t.tourTitle} intro={t.tourIntro} />
                <FeatureTabs
                    {...tourFeatures(locale)}
                    words={{ label: t.tourTitle, more: t.tourMore, open: t.tourOpen }}
                />
            </section>

            {replaces.length ? (
                <section aria-labelledby="replaces" className="flex flex-col gap-6">
                    <SectionHead id="replaces" title={t.replacesTitle} intro={t.replacesIntro} />
                    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {replaces.map((row) => (
                            <li
                                key={row.instead}
                                className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4"
                            >
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {row.tools.map((tool) => (
                                        <span
                                            key={tool.name}
                                            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                                        >
                                            {tool.logo ? (
                                                // eslint-disable-next-line @next/next/no-img-element -- static export
                                                <img
                                                    src={asset(`logos/${tool.logo}`)}
                                                    alt=""
                                                    className="size-3.5"
                                                    loading="lazy"
                                                />
                                            ) : null}
                                            {tool.name}
                                        </span>
                                    ))}
                                </div>
                                <p className="flex min-w-0 items-start gap-2 text-sm">
                                    <ArrowRight
                                        aria-hidden="true"
                                        className="mt-0.5 size-4 shrink-0 text-primary"
                                    />
                                    <span className="min-w-0">{row.instead}</span>
                                </p>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            <section aria-labelledby="steps" className="flex flex-col gap-6">
                <SectionHead id="steps" title={t.stepsTitle} intro={t.stepsIntro} />
                <ol className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {steps.map((step, index) => (
                        <li
                            key={step.title}
                            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
                        >
                            <span className="flex items-center gap-3">
                                <span className="grid size-8 place-items-center rounded-lg bg-primary/15 text-sm font-semibold text-primary">
                                    {index + 1}
                                </span>
                                <step.icon
                                    aria-hidden="true"
                                    className="size-4 text-muted-foreground"
                                />
                            </span>
                            <h3 className="font-semibold">{step.title}</h3>
                            <p className="text-sm text-muted-foreground">{step.body}</p>
                        </li>
                    ))}
                </ol>
            </section>

            <section aria-labelledby="look" className="flex flex-col gap-8">
                <SectionHead id="look" title={t.lookTitle} intro={t.lookIntro} />
                {showcase.map((section) => (
                    <div key={section.heading} className="flex flex-col gap-3">
                        <h3 className="text-lg font-semibold">{section.heading}</h3>
                        <ShotGallery shots={section.items.map(shot)} words={all.viewer} />
                    </div>
                ))}
                <Link
                    href={href(locale, "marketplace/")}
                    className={cn(buttonVariants({ variant: "outline" }), "self-start")}
                >
                    {t.seeApps}
                    <ArrowRight className="size-4" />
                </Link>
            </section>

            <section
                aria-labelledby="start"
                className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-card px-4 py-12 text-center"
            >
                <h2
                    id="start"
                    className="max-w-2xl text-balance text-3xl font-semibold tracking-tight"
                >
                    {t.ctaTitle}
                </h2>
                <p className="max-w-xl text-muted-foreground">{t.ctaBody}</p>
                <InstallCommand
                    commands={commands}
                    labels={installWords}
                    className="max-w-3xl text-left"
                />
                <div className="flex flex-wrap justify-center gap-2">
                    <Link
                        href={href(locale, "docs/")}
                        className={buttonVariants({ variant: "primary" })}
                    >
                        {t.readDocs}
                    </Link>
                    <Link
                        href={href(locale, "downloads/")}
                        className={buttonVariants({ variant: "outline" })}
                    >
                        {all.nav.downloads}
                    </Link>
                </div>
            </section>
        </>
    );
}
