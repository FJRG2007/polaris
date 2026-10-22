/**
 * The feature guides: an index of every one and a page each, beside a sidebar
 * with the search and the list. The guides are the repository's own
 * `docs/features`, rendered when the site is built.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { DocPage } from "@/data/docs";
import type { SiteLocale } from "@/data/builders";
import { DocsSearch } from "@/components/docs-search";
import { asset, href, siteData, words } from "@/lib/site";

function DocsFrame({
    locale,
    current,
    aside,
    children
}: {
    locale: SiteLocale;
    current: string | null;
    aside?: ReactNode;
    children: ReactNode;
}) {
    const t = words(locale).docs;
    const pages = siteData().docs[locale];
    return (
        <div className="flex flex-col gap-8 lg:flex-row">
            <nav
                aria-label={t.guides}
                className="flex shrink-0 flex-col gap-3 text-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:w-56 lg:self-start lg:overflow-y-auto"
            >
                <DocsSearch
                    index={asset(href(locale, "docs/search.json"))}
                    label={t.search}
                    empty={t.empty}
                    loading={t.loading}
                    failed={t.failed}
                />
                <SideList label={t.guides}>
                    <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                        {t.guides}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                        {pages.map((page) => (
                            <li key={page.slug}>
                                <Link
                                    href={href(locale, `docs/${page.slug}/`)}
                                    aria-current={page.slug === current ? "page" : undefined}
                                    className="block truncate rounded-md px-2 py-1 text-muted-foreground hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:text-foreground"
                                >
                                    {page.title}
                                </Link>
                            </li>
                        ))}
                    </ul>
                    <Link
                        href={href(locale, "docs/api/")}
                        className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground"
                    >
                        {words(locale).api.title}
                    </Link>
                </SideList>
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
            {aside}
        </div>
    );
}

/**
 * A sidebar's list: open beside the page on a wide screen, folded under its
 * label on a phone so the page itself is not a screen further down.
 */
export function SideList({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <details className="group rounded-md border border-border lg:hidden">
                <summary className="cursor-pointer select-none px-3 py-2 text-sm">{label}</summary>
                <div className="flex flex-col gap-3 border-t border-border p-2">{children}</div>
            </details>
            <div className="hidden flex-col gap-3 lg:flex">{children}</div>
        </>
    );
}

export function DocsIndexView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).docs;
    const pages = siteData().docs[locale];
    return (
        <DocsFrame locale={locale} current={null}>
            <div className="flex flex-col gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
                <p className="text-muted-foreground">{t.intro}</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
                {pages.map((page) => (
                    <li key={page.slug} className="min-w-0">
                        <Link
                            href={href(locale, `docs/${page.slug}/`)}
                            className="flex h-full min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-4 hover:border-foreground/30"
                        >
                            <span className="font-medium">{page.title}</span>
                            <span className="line-clamp-3 text-sm text-muted-foreground">
                                {page.summary}
                            </span>
                        </Link>
                    </li>
                ))}
                <li className="min-w-0">
                    <Link
                        href={href(locale, "docs/api/")}
                        className="flex h-full min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-4 hover:border-foreground/30"
                    >
                        <span className="flex items-center gap-1 font-medium">
                            {words(locale).api.title}
                            <ArrowRight className="size-4 shrink-0" />
                        </span>
                        <span className="text-sm text-muted-foreground">{t.apiHint}</span>
                    </Link>
                </li>
            </ul>
        </DocsFrame>
    );
}

export function findDoc(locale: SiteLocale, slug: string): DocPage | undefined {
    return siteData().docs[locale].find((page) => page.slug === slug);
}

export function DocView({ locale, page }: { locale: SiteLocale; page: DocPage }) {
    const t = words(locale).docs;
    const { repo } = siteData();
    const file = `docs/features/${page.slug}${locale === "es" ? ".es" : ""}.md`;
    return (
        <DocsFrame
            locale={locale}
            current={page.slug}
            aside={
                page.headings.length ? (
                    <nav
                        aria-label={t.onThisPage}
                        className="hidden shrink-0 flex-col gap-1 text-sm xl:sticky xl:top-20 xl:flex xl:w-48 xl:self-start"
                    >
                        <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                            {t.onThisPage}
                        </p>
                        {page.headings.map((heading) => (
                            <a
                                key={heading.id}
                                href={`#${heading.id}`}
                                className="truncate text-muted-foreground hover:text-foreground"
                                title={heading.text}
                            >
                                {heading.text}
                            </a>
                        ))}
                    </nav>
                ) : null
            }
        >
            <article className="flex min-w-0 flex-col gap-4">
                <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
                <div
                    className="doc-prose"
                    // Rendered at build time from this repository's own Markdown.
                    dangerouslySetInnerHTML={{ __html: page.html }}
                />
                <a
                    className="self-start text-sm text-muted-foreground underline"
                    href={`https://github.com/${repo}/blob/main/${file}`}
                >
                    {t.source}
                </a>
            </article>
        </DocsFrame>
    );
}
