/**
 * The landing page: what Polaris is, the line that installs it, what it
 * replaces, and the README's screenshots by section.
 */

import Link from "next/link";
import { CopyButton } from "@polaris/ui";
import type { SiteLocale } from "@/data/builders";
import { asset, href, siteData, words } from "@/lib/site";

function InstallLine({ label, command }: { label: string; command: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs text-muted-foreground">{label}</p>
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs">
                    {command}
                </code>
                <CopyButton value={command} />
            </div>
        </div>
    );
}

export function HomeView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).home;
    const data = siteData();
    const { replaces, showcase } = data.locales[locale];
    return (
        <>
            <section className="flex flex-col gap-5 pt-6">
                <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
                    {t.title}
                </h1>
                <p className="max-w-2xl text-pretty text-muted-foreground">{t.intro}</p>
                <div className="flex w-full max-w-2xl flex-col gap-3">
                    {data.install.unix ? (
                        <InstallLine label={t.unix} command={data.install.unix} />
                    ) : null}
                    {data.install.windows ? (
                        <InstallLine label={t.windows} command={data.install.windows} />
                    ) : null}
                    <p className="text-xs text-muted-foreground">{t.installHint}</p>
                </div>
            </section>

            {replaces.length ? (
                <section aria-labelledby="replaces" className="flex flex-col gap-4">
                    <div>
                        <h2 id="replaces" className="text-2xl font-semibold tracking-tight">
                            {t.replacesTitle}
                        </h2>
                        <p className="text-muted-foreground">{t.replacesIntro}</p>
                    </div>
                    <div className="overflow-hidden rounded-xl border border-border bg-card">
                        <table className="w-full text-left text-sm">
                            <thead className="hidden sm:table-header-group">
                                <tr className="border-b border-border">
                                    <th className="px-4 py-2">{t.today}</th>
                                    <th className="px-4 py-2">{t.instead}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {replaces.map((row) => (
                                    <tr
                                        key={row.instead}
                                        className="flex flex-col border-b border-border/60 last:border-0 sm:table-row"
                                    >
                                        <td className="px-4 pt-3 sm:w-2/5 sm:py-3">
                                            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                {row.tools.map((tool) => (
                                                    <span
                                                        key={tool.name}
                                                        className="inline-flex items-center gap-1.5 font-medium"
                                                    >
                                                        {tool.logo ? (
                                                            // eslint-disable-next-line @next/next/no-img-element -- static export
                                                            <img
                                                                src={asset(`logos/${tool.logo}`)}
                                                                alt=""
                                                                className="size-4"
                                                                loading="lazy"
                                                            />
                                                        ) : null}
                                                        {tool.name}
                                                    </span>
                                                ))}
                                            </span>
                                        </td>
                                        <td className="px-4 pb-3 text-muted-foreground sm:py-3">
                                            {row.instead}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            ) : null}

            <section aria-labelledby="look" className="flex flex-col gap-6">
                <div>
                    <h2 id="look" className="text-2xl font-semibold tracking-tight">
                        {t.lookTitle}
                    </h2>
                    <p className="text-muted-foreground">{t.lookIntro}</p>
                </div>
                {showcase.map((section) => (
                    <div key={section.heading} className="flex flex-col gap-3">
                        <h3 className="text-lg font-semibold">{section.heading}</h3>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            {section.items.map((item) => (
                                <figure
                                    key={item.dark}
                                    className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
                                >
                                    <picture>
                                        {item.light ? (
                                            <source
                                                media="(prefers-color-scheme: light)"
                                                srcSet={asset(`media/${item.light}`)}
                                            />
                                        ) : null}
                                        {/* eslint-disable-next-line @next/next/no-img-element -- static export, webp */}
                                        <img
                                            src={asset(`media/${item.dark}`)}
                                            alt={item.alt}
                                            loading="lazy"
                                            className="w-full"
                                        />
                                    </picture>
                                    <figcaption className="p-3 text-sm">
                                        <b className="font-semibold">{item.name}</b>
                                        {item.caption ? (
                                            <span className="text-muted-foreground">
                                                : {item.caption}
                                            </span>
                                        ) : null}
                                    </figcaption>
                                </figure>
                            ))}
                        </div>
                    </div>
                ))}
                <Link href={href(locale, "marketplace/")} className="self-start text-sm underline">
                    {t.seeApps}
                </Link>
            </section>
        </>
    );
}
