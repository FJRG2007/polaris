/**
 * The guides: an index of every one and a page each, beside a sidebar with the
 * search and the guides in their groups. The guides are the repository's own
 * Markdown, rendered when the site is built.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { SiteLocale } from "@/data/builders";
import { SITE_ORIGIN, asset, href, siteData, words } from "@/lib/site";
import { ArrowLeft, ArrowRight, Bug, ChevronRight, Lightbulb, Pencil } from "lucide-react";
import { docNeighbors, type DocPage, type DocSection } from "@/data/docs";
import { DocsSearch, type DocsSearchWords } from "@/components/docs-search";
import { HostField, HostedHtml } from "@/components/example-host";
import { EXAMPLE_HOST } from "@/lib/example-origin";
import { SiteTvChecker, SiteTvGallery } from "@/components/site-tv-checker";
import { TV_COMPAT_SLUG, TV_PRIVACY_SLUG } from "@/data/builders";
import { PageToc, PageTocFolded } from "@/components/page-toc";
import { apiPath, markdownPath } from "@/data/api-pages";
import { PageActions, type PageActionsWords } from "@/components/page-actions";

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

/**
 * A docs page: the search and a sidebar list on the left, the page in the
 * middle and, on a wide screen, `aside` on the right. The guides and the API
 * reference share it, each with its own list.
 */
export function DocsLayout({
    locale,
    label,
    sidebar,
    page,
    source,
    aside,
    children
}: {
    locale: SiteLocale;
    /** The sidebar list's name, read aloud and shown on its folded form. */
    label: string;
    sidebar: ReactNode;
    /** The page's path in the locale (`docs/chat/`), named in the issues filed from it. */
    page: string;
    /** The page's file in the repository, when it has one, for "Edit this page". */
    source?: string;
    aside?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-8 lg:flex-row">
            <nav
                aria-label={label}
                className="flex shrink-0 flex-col gap-3 text-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:w-56 lg:self-start lg:overflow-y-auto"
            >
                <DocsSearch locale={locale} words={searchWords(locale)} className="w-full" />
                <SideList label={label}>
                    {sidebar}
                    <Contribute locale={locale} page={page} source={source} />
                </SideList>
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
            {aside}
        </div>
    );
}

/** A page's address as a reader shares it. */
export function pageUrl(locale: SiteLocale, page: string): string {
    return `${SITE_ORIGIN}${asset(href(locale, page))}`;
}

/**
 * The foot of the sidebar: an issue or a feature request filed against the
 * repository's own templates with this page already named, and the page's
 * file to edit when it has one.
 */
function Contribute({ locale, page, source }: { locale: SiteLocale; page: string; source?: string }) {
    const t = words(locale).docs;
    const { repo } = siteData();
    const body = t.issueBody.replace("{url}", pageUrl(locale, page));
    const issue = (template: string, field: string) =>
        `https://github.com/${repo}/issues/new?template=${template}&${field}=${encodeURIComponent(body)}`;
    const links = [
        { to: issue("bug_report.yml", "what-happened"), label: t.reportIssue, Icon: Bug },
        { to: issue("feature_request.yml", "problem"), label: t.requestFeature, Icon: Lightbulb },
        ...(source
            ? [{ to: `https://github.com/${repo}/edit/main/${source}`, label: t.editPage, Icon: Pencil }]
            : [])
    ];
    return (
        <div className="flex flex-col gap-0.5 border-t border-border pt-3">
            <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                {t.contribute}
            </p>
            {links.map(({ to, label, Icon }) => (
                <a
                    key={label}
                    href={to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={SIDE_LINK}
                >
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{label}</span>
                </a>
            ))}
        </div>
    );
}

/** The words of "Copy page" and its menu. */
export function pageActionWords(locale: SiteLocale): PageActionsWords {
    const t = words(locale).docs;
    return {
        copyPage: t.copyPage,
        pageActions: t.pageActions,
        copyMarkdown: t.copyMarkdown,
        copyMarkdownHint: t.copyMarkdownHint,
        openClaude: t.openClaude,
        openChatGpt: t.openChatGpt,
        askHint: t.askHint,
        copied: t.copied,
        copyFailed: t.copyFailed,
        prompt: t.prompt
    };
}

/** A page's first row: where it sits on the left, "Copy page" on the right. */
export function PageHead({
    locale,
    page,
    children
}: {
    locale: SiteLocale;
    page: string;
    children?: ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">{children}</div>
            <PageActions
                markdown={asset(`${locale}/${markdownPath(page)}`)}
                url={pageUrl(locale, page)}
                words={pageActionWords(locale)}
            />
        </div>
    );
}

/** A folding group in a sidebar list, open when it holds the current page. */
export function SideSection({
    label,
    open,
    children
}: {
    label: string;
    open: boolean;
    children: ReactNode;
}) {
    return (
        <details open={open} className="group/section">
            <summary className="flex cursor-pointer select-none list-none items-center gap-1 rounded-md px-2 py-1 text-xs font-medium uppercase tracking-wide text-foreground-subtle hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight
                    className="size-3.5 shrink-0 transition-transform group-open/section:rotate-90"
                    aria-hidden="true"
                />
                <span className="min-w-0 truncate" title={label}>
                    {label}
                </span>
            </summary>
            <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">{children}</ul>
        </details>
    );
}

/** A sidebar link, marked when it is the page being read. */
export const SIDE_LINK =
    "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:text-foreground";

function DocsFrame({
    locale,
    current,
    source,
    aside,
    children
}: {
    locale: SiteLocale;
    current: string | null;
    source?: string;
    aside?: ReactNode;
    children: ReactNode;
}) {
    const t = words(locale).docs;
    const pages = new Map(siteData().docs[locale].map((page) => [page.slug, page]));
    return (
        <DocsLayout
            locale={locale}
            label={t.guides}
            page={current ? `docs/${current}/` : "docs/"}
            source={source}
            aside={aside}
            sidebar={
                <>
                    {docSections(locale).map((section) => (
                        <SideSection
                            key={section.label}
                            label={section.label}
                            open={current === null || section.slugs.includes(current)}
                        >
                            {section.slugs.map((slug) => (
                                <li key={slug}>
                                    <Link
                                        href={href(locale, `docs/${slug}/`)}
                                        aria-current={slug === current ? "page" : undefined}
                                        title={pages.get(slug)?.title}
                                        className={SIDE_LINK}
                                    >
                                        <span className="min-w-0 truncate">
                                            {pages.get(slug)?.title ?? slug}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </SideSection>
                    ))}
                    <Link href={href(locale, apiPath.overview())} className={SIDE_LINK}>
                        {words(locale).api.title}
                    </Link>
                </>
            }
        >
            {children}
        </DocsLayout>
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

export const CARD =
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
                    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <Link href={href(locale, apiPath.overview())} className={CARD}>
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

/** The previous or next page, at the foot of a page. */
export function NeighborLink({
    to,
    title,
    label,
    next
}: {
    to: string;
    title: string;
    label: string;
    next?: boolean;
}) {
    return (
        <Link
            href={to}
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

/** Where a page sits: each step a link but the last, which is the page itself. */
export function Breadcrumb({
    label,
    trail
}: {
    label: string;
    trail: readonly { label: string; to?: string }[];
}) {
    return (
        <nav aria-label={label}>
            <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
                {trail.map((step, at) => (
                    <li key={`${at}-${step.label}`} className="flex min-w-0 items-center gap-1">
                        {at ? (
                            <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                        ) : null}
                        {at === trail.length - 1 ? (
                            <span
                                aria-current="page"
                                className="truncate text-foreground"
                                title={step.label}
                            >
                                {step.label}
                            </span>
                        ) : step.to ? (
                            <Link
                                href={step.to}
                                className="truncate hover:text-foreground"
                                title={step.label}
                            >
                                {step.label}
                            </Link>
                        ) : (
                            <span className="truncate" title={step.label}>
                                {step.label}
                            </span>
                        )}
                    </li>
                ))}
            </ol>
        </nav>
    );
}

export function DocView({ locale, page }: { locale: SiteLocale; page: DocPage }) {
    const t = words(locale).docs;
    const { repo } = siteData();
    const { previous, next, section } = docNeighbors(docSections(locale), page.slug);
    const neighbor = (slug: string, label: string, isNext?: boolean) => (
        <NeighborLink
            to={href(locale, `docs/${slug}/`)}
            title={findDoc(locale, slug)?.title ?? slug}
            label={label}
            next={isNext}
        />
    );
    return (
        <DocsFrame
            locale={locale}
            current={page.slug}
            source={page.source}
            aside={
                page.headings.length ? <PageToc label={t.onThisPage} items={page.headings} /> : null
            }
        >
            <article className="flex min-w-0 flex-col gap-4">
                <PageHead locale={locale} page={`docs/${page.slug}/`}>
                    <Breadcrumb
                        label={t.breadcrumb}
                        trail={[
                            { label: t.title, to: href(locale, "docs/") },
                            ...(section ? [{ label: section }] : []),
                            { label: page.title }
                        ]}
                    />
                </PageHead>
                <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
                {page.headings.length ? (
                    <PageTocFolded label={t.onThisPage} items={page.headings} />
                ) : null}
                {page.html.includes(EXAMPLE_HOST) ? <HostField words={words(locale).host} /> : null}
                {/* Rendered at build time from this repository's own Markdown. */}
                <HostedHtml className="doc-prose" html={page.html} viewer={words(locale).viewer} />
                {page.slug === TV_COMPAT_SLUG || page.slug === TV_PRIVACY_SLUG ? (
                    <SiteTvChecker
                        locale={locale}
                        messages={siteData().downloadsPage.messages[locale].tvCompat}
                        view={page.slug === TV_PRIVACY_SLUG ? "privacy" : "checker"}
                    />
                ) : null}
                {page.slug === TV_COMPAT_SLUG ? (
                    <SiteTvGallery
                        locale={locale}
                        messages={siteData().downloadsPage.messages[locale].tvCompat}
                        items={siteData().downloadsPage.tvGallery ?? []}
                        viewer={words(locale).viewer}
                    />
                ) : null}
                <a
                    className="self-start text-sm text-muted-foreground underline"
                    href={`https://github.com/${repo}/blob/main/${page.source}`}
                >
                    {t.source}
                </a>
                {previous || next ? (
                    <nav className="grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2">
                        {previous ? neighbor(previous, t.previous) : null}
                        {next ? neighbor(next, t.next, true) : null}
                    </nav>
                ) : null}
            </article>
        </DocsFrame>
    );
}
