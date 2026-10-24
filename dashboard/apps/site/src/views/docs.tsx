/**
 * The guides: an index of every one and a page each, beside a sidebar with the
 * search and the guides in their groups. The guides are the repository's own
 * Markdown, rendered when the site is built.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { SiteLocale } from "@/data/builders";
import { href, siteData, words } from "@/lib/site";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import { docNeighbors, type DocPage, type DocSection } from "@/data/docs";
import { DocsSearch, type DocsSearchWords } from "@/components/docs-search";

/** The sidebar's groups in a locale, as the site was generated with them. */
export function docSections(locale: SiteLocale): readonly DocSection[] {
    return siteData().docSections[locale];
}

/** The search panel's words in a locale. */
export function searchWords(locale: SiteLocale): DocsSearchWords {
    const t = words(locale).docs;
    return {
        search: t.search,
        open: t.open,
        empty: t.empty,
        emptyRecent: t.emptyRecent,
        loading: t.loading,
        failed: t.failed,
        recent: t.recent,
        clear: t.clear,
        forget: t.forget,
        forgetNamed: t.forgetNamed,
        results: t.results,
        hintMove: t.hintMove,
        hintClose: t.hintClose
    };
}

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
    const pages = new Map(siteData().docs[locale].map((page) => [page.slug, page]));
    return (
        <div className="flex flex-col gap-8 lg:flex-row">
            <nav
                aria-label={t.guides}
                className="flex shrink-0 flex-col gap-3 text-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:w-56 lg:self-start lg:overflow-y-auto"
            >
                <DocsSearch locale={locale} words={searchWords(locale)} className="w-full" />
                <SideList label={t.guides}>
                    {docSections(locale).map((section) => (
                        <details
                            key={section.label}
                            open={current === null || section.slugs.includes(current)}
                            className="group/section"
                        >
                            <summary className="flex cursor-pointer select-none list-none items-center gap-1 rounded-md px-2 py-1 text-xs font-medium uppercase tracking-wide text-foreground-subtle hover:text-foreground [&::-webkit-details-marker]:hidden">
                                <ChevronRight
                                    className="size-3.5 shrink-0 transition-transform group-open/section:rotate-90"
                                    aria-hidden="true"
                                />
                                <span className="min-w-0 truncate" title={section.label}>
                                    {section.label}
                                </span>
                            </summary>
                            <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
                                {section.slugs.map((slug) => (
                                    <li key={slug}>
                                        <Link
                                            href={href(locale, `docs/${slug}/`)}
                                            aria-current={slug === current ? "page" : undefined}
                                            title={pages.get(slug)?.title}
                                            className="block truncate rounded-md px-2 py-1 text-muted-foreground hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:text-foreground"
                                        >
                                            {pages.get(slug)?.title ?? slug}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ))}
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

const CARD =
    "flex h-full min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-4 hover:border-foreground/30";

export function DocsIndexView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).docs;
    const pages = new Map(siteData().docs[locale].map((page) => [page.slug, page]));
    return (
        <DocsFrame locale={locale} current={null}>
            <div className="flex flex-col gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
                <p className="text-muted-foreground">{t.intro}</p>
            </div>
            {docSections(locale).map((section) => (
                <section key={section.label} className="flex flex-col gap-3">
                    <h2 className="text-lg font-semibold tracking-tight">{section.label}</h2>
                    <ul className="grid gap-3 sm:grid-cols-2">
                        {section.slugs.map((slug) => {
                            const page = pages.get(slug);
                            return page ? (
                                <li key={slug} className="min-w-0">
                                    <Link href={href(locale, `docs/${slug}/`)} className={CARD}>
                                        <span className="font-medium">{page.title}</span>
                                        <span className="line-clamp-3 text-sm text-muted-foreground">
                                            {page.summary}
                                        </span>
                                    </Link>
                                </li>
                            ) : null;
                        })}
                    </ul>
                </section>
            ))}
            <Link href={href(locale, "docs/api/")} className={CARD}>
                <span className="flex items-center gap-1 font-medium">
                    {words(locale).api.title}
                    <ArrowRight className="size-4 shrink-0" />
                </span>
                <span className="text-sm text-muted-foreground">{t.apiHint}</span>
            </Link>
        </DocsFrame>
    );
}

export function findDoc(locale: SiteLocale, slug: string): DocPage | undefined {
    return siteData().docs[locale].find((page) => page.slug === slug);
}

function Neighbor({
    locale,
    slug,
    label,
    next
}: {
    locale: SiteLocale;
    slug: string;
    label: string;
    next?: boolean;
}) {
    const title = findDoc(locale, slug)?.title ?? slug;
    return (
        <Link
            href={href(locale, `docs/${slug}/`)}
            rel={next ? "next" : "prev"}
            className={`flex min-w-0 flex-col gap-0.5 rounded-xl border border-border p-3 hover:border-foreground/30 ${next ? "items-end text-right sm:col-start-2" : ""}`}
        >
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {next ? null : <ArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />}
                {label}
                {next ? <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" /> : null}
            </span>
            <span className="max-w-full truncate font-medium" title={title}>
                {title}
            </span>
        </Link>
    );
}

export function DocView({ locale, page }: { locale: SiteLocale; page: DocPage }) {
    const t = words(locale).docs;
    const { repo } = siteData();
    const { previous, next, section } = docNeighbors(docSections(locale), page.slug);
    return (
        <DocsFrame
            locale={locale}
            current={page.slug}
            aside={
                page.headings.length ? (
                    <nav
                        aria-label={t.onThisPage}
                        className="hidden shrink-0 flex-col gap-1 text-sm xl:sticky xl:top-20 xl:flex xl:max-h-[calc(100vh-6rem)] xl:w-48 xl:self-start xl:overflow-y-auto"
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
                <nav aria-label={t.breadcrumb}>
                    <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
                        <li>
                            <Link href={href(locale, "docs/")} className="hover:text-foreground">
                                {t.title}
                            </Link>
                        </li>
                        {section ? (
                            <li className="flex min-w-0 items-center gap-1">
                                <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                                <span className="truncate" title={section}>
                                    {section}
                                </span>
                            </li>
                        ) : null}
                        <li className="flex min-w-0 items-center gap-1">
                            <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                            <span aria-current="page" className="truncate text-foreground">
                                {page.title}
                            </span>
                        </li>
                    </ol>
                </nav>
                <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
                {page.headings.length ? (
                    <details className="rounded-md border border-border text-sm xl:hidden">
                        <summary className="cursor-pointer select-none px-3 py-2">
                            {t.onThisPage}
                        </summary>
                        <ul className="flex flex-col gap-1 border-t border-border p-3">
                            {page.headings.map((heading) => (
                                <li key={heading.id} className="min-w-0">
                                    <a
                                        href={`#${heading.id}`}
                                        className="block truncate text-muted-foreground hover:text-foreground"
                                        title={heading.text}
                                    >
                                        {heading.text}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </details>
                ) : null}
                <div
                    className="doc-prose"
                    // Rendered at build time from this repository's own Markdown.
                    dangerouslySetInnerHTML={{ __html: page.html }}
                />
                <a
                    className="self-start text-sm text-muted-foreground underline"
                    href={`https://github.com/${repo}/blob/main/${page.source}`}
                >
                    {t.source}
                </a>
                {previous || next ? (
                    <nav className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                        {previous ? (
                            <Neighbor locale={locale} slug={previous} label={t.previous} />
                        ) : null}
                        {next ? <Neighbor locale={locale} slug={next} label={t.next} next /> : null}
                    </nav>
                ) : null}
            </article>
        </DocsFrame>
    );
}
