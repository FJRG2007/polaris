/**
 * The API reference, drawn with the design system's own pieces from the
 * OpenAPI document the build generated: an overview, a page per group and a
 * page per call, each with the reference's own sidebar. A third-party renderer
 * would bring its own styles and scripts into a page that loads nothing from
 * outside. Every example is highlighted while the site is built.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { InventoryRoute } from "@/data/api-inventory";
import type { ApiConstraint, ApiField, ApiOperation, SiteLocale } from "@/data/builders";
import { requestSamples } from "@/data/docs";
import { CodeTabs } from "@/components/code-tabs";
import { HostField, HostedHtml } from "@/components/example-host";
import { PageToc, PageTocFolded, type TocItem } from "@/components/page-toc";
import { Badge, CopyButton, buttonVariants, cn } from "@polaris/ui";
import { highlight, highlightAll } from "@/lib/highlight";
import { EXAMPLE_ORIGIN } from "@/lib/example-origin";
import { asset, href, siteData, words } from "@/lib/site";
import * as pages from "@/data/api-pages";
import {
    Breadcrumb,
    CARD,
    DocsLayout,
    NeighborLink,
    PageHead,
    SIDE_LINK,
    SideSection
} from "@/views/docs";

/** Routes that answer to a key but are not in the OpenAPI document yet. */
export function undocumentedRoutes(): InventoryRoute[] {
    return siteData().api.routes.filter((route) => !route.operation);
}

/** Every page of the reference, in reading order. */
export function apiSequence(): pages.ApiPage[] {
    return pages.apiPages(siteData().api.groups, undocumentedRoutes().length);
}

export function findGroup(slug: string): pages.ApiGroup | undefined {
    return siteData().api.groups.find((group) => pages.groupSlug(group.tag) === slug);
}

export function findOperation(
    groupSlug: string,
    operationSlug: string
): { group: pages.ApiGroup; operation: ApiOperation } | undefined {
    const group = findGroup(groupSlug);
    const operation = group?.operations.find((op) => pages.operationSlug(op) === operationSlug);
    return group && operation ? { group, operation } : undefined;
}

/** A page's name as the sidebar, the breadcrumb and the foot of the page show it. */
export function apiPageTitle(locale: SiteLocale, page: pages.ApiPage): string {
    const t = words(locale).api;
    switch (page.kind) {
        case "overview":
            return t.overview;
        case "group":
            return page.group.tag;
        case "operation":
            return page.operation.summary || page.operation.path;
        case "more":
            return t.undocumented;
    }
}

const METHOD_TONE: Record<string, "success" | "primary" | "warning" | "danger" | "neutral"> = {
    GET: "success",
    POST: "primary",
    PUT: "warning",
    PATCH: "warning",
    DELETE: "danger"
};

function MethodTag({ method, small }: { method: string; small?: boolean }) {
    return (
        <Badge
            variant={METHOD_TONE[method] ?? "neutral"}
            className={cn(
                "shrink-0 justify-center font-mono",
                small && "w-9 px-0 py-0 text-[0.625rem] leading-4"
            )}
        >
            {small && method === "DELETE" ? "DEL" : method}
        </Badge>
    );
}

function ApiFrame({
    locale,
    current,
    aside,
    children
}: {
    locale: SiteLocale;
    current: string;
    aside?: ReactNode;
    children: ReactNode;
}) {
    const t = words(locale).api;
    const undocumented = undocumentedRoutes().length;
    const link = (path: string, label: ReactNode, title?: string) => (
        <Link
            href={href(locale, path)}
            aria-current={path === current ? "page" : undefined}
            title={title}
            className={SIDE_LINK}
        >
            {label}
        </Link>
    );
    return (
        <DocsLayout
            locale={locale}
            label={t.title}
            page={current}
            aside={aside}
            sidebar={
                <>
                    {link(pages.apiPath.overview(), t.overview)}
                    {siteData().api.groups.map((group) => {
                        const groupPath = pages.apiPath.group(group.tag);
                        return (
                            <SideSection
                                key={group.tag}
                                label={group.tag}
                                open={current.startsWith(groupPath)}
                            >
                                <li>{link(groupPath, t.overview)}</li>
                                {group.operations.map((op) => (
                                    <li key={op.id}>
                                        {link(
                                            pages.apiPath.operation(op),
                                            <>
                                                <MethodTag method={op.method} small />
                                                <span className="min-w-0 truncate">
                                                    {op.summary || op.path}
                                                </span>
                                            </>,
                                            `${op.method} ${op.path}`
                                        )}
                                    </li>
                                ))}
                            </SideSection>
                        );
                    })}
                    {undocumented ? link(pages.apiPath.more(), t.undocumented) : null}
                    <Link href={href(locale, "docs/")} className={SIDE_LINK}>
                        {words(locale).docs.guides}
                    </Link>
                </>
            }
        >
            {children}
        </DocsLayout>
    );
}

/** The pages before and after this one, at its foot. */
function ApiNeighbors({ locale, path }: { locale: SiteLocale; path: string }) {
    const t = words(locale).docs;
    const { previous, next } = pages.apiNeighbors(apiSequence(), path);
    if (!previous && !next) return null;
    return (
        <nav className="grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2">
            {previous ? (
                <NeighborLink
                    to={href(locale, previous.path)}
                    title={apiPageTitle(locale, previous)}
                    label={t.previous}
                />
            ) : null}
            {next ? (
                <NeighborLink
                    to={href(locale, next.path)}
                    title={apiPageTitle(locale, next)}
                    label={t.next}
                    next
                />
            ) : null}
        </nav>
    );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    return (
        <section id={id} className="flex min-w-0 scroll-mt-20 flex-col gap-3">
            <h2 className="text-xl font-semibold">{title}</h2>
            {children}
        </section>
    );
}

/**
 * A table that scrolls inside its own frame on a narrow screen instead of
 * widening the page; on a phone each row stacks into a card instead (globals.css).
 * `widths` fixes each column's share, so one long value (a pattern) wraps
 * inside its cell instead of squeezing the names beside it.
 */
function Table({
    head,
    widths,
    children
}: {
    head: readonly string[];
    widths: readonly string[];
    children: ReactNode;
}) {
    return (
        <div className="min-w-0 overflow-x-auto rounded-md border border-border">
            <table
                className={cn(
                    "api-table w-full table-fixed text-left text-sm",
                    head.length > 2 && "sm:min-w-[34rem]"
                )}
            >
                <colgroup>
                    {widths.map((width, at) => (
                        <col key={at} style={{ width }} />
                    ))}
                </colgroup>
                <thead className="bg-surface text-xs text-muted-foreground">
                    <tr>
                        {head.map((cell) => (
                            <th key={cell} scope="col" className="px-3 py-2 font-medium">
                                {cell}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/60">{children}</tbody>
            </table>
        </div>
    );
}

function Constraints({ locale, list }: { locale: SiteLocale; list: readonly ApiConstraint[] }) {
    const names = words(locale).api.constraints;
    if (!list.length) return null;
    return (
        <ul className="flex min-w-0 flex-wrap gap-1">
            {list.map((rule) => (
                <li
                    key={rule.kind}
                    className="max-w-full rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                    {names[rule.kind]}:{" "}
                    <code className="break-all text-foreground">{rule.value}</code>
                </li>
            ))}
        </ul>
    );
}

function NameCell({ locale, name, required }: { locale: SiteLocale; name: string; required: boolean }) {
    return (
        <td className="px-3 py-2 align-top">
            <span className="flex flex-wrap items-center gap-1.5">
                <code className="break-all font-medium">{name}</code>
                {required ? (
                    <Badge variant="danger" className="px-1 py-0 text-[0.625rem] leading-4">
                        {words(locale).api.required}
                    </Badge>
                ) : null}
            </span>
        </td>
    );
}

function FieldRows({ locale, fields }: { locale: SiteLocale; fields: readonly ApiField[] }) {
    return fields.map((field) => (
        <tr key={field.name}>
            <NameCell locale={locale} name={field.name} required={field.required} />
            <td className="px-3 py-2 align-top">
                <code className="break-all text-xs text-muted-foreground">{field.type}</code>
            </td>
            <td className="px-3 py-2 align-top">
                <div className="flex min-w-0 flex-col gap-1">
                    {field.description ? (
                        <span className="text-muted-foreground">{field.description}</span>
                    ) : null}
                    <Constraints locale={locale} list={field.constraints} />
                </div>
            </td>
        </tr>
    ));
}

const AUTH_SAMPLE = { method: "GET", path: "/api/v1/me", body: null } as const;
const ERROR_BODY = `{\n  "error": "string"\n}`;

export async function ApiOverviewView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).api;
    const { api } = siteData();
    const operations = api.groups.flatMap((group) => group.operations);
    const common = pages.commonResponses(operations);
    const [auth, base, errorBody] = await Promise.all([
        highlightAll(requestSamples(AUTH_SAMPLE, EXAMPLE_ORIGIN).slice(0, 1)),
        highlightAll([{ label: t.baseTitle, lang: "bash", code: `${EXAMPLE_ORIGIN}/api/v1` }]),
        highlight(ERROR_BODY, "json")
    ]);
    const toc: TocItem[] = [
        { id: "base", text: t.baseTitle },
        { id: "authentication", text: t.authTitle },
        { id: "errors", text: t.errorsTitle },
        { id: "groups", text: t.groupsTitle }
    ];
    return (
        <ApiFrame
            locale={locale}
            current={pages.apiPath.overview()}
            aside={<PageToc label={words(locale).docs.onThisPage} items={toc} />}
        >
            <div className="flex flex-col gap-2">
                <PageHead locale={locale} page={pages.apiPath.overview()}>
                    <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
                </PageHead>
                <p className="text-muted-foreground">{t.intro}</p>
                {api.description ? (
                    <p className="text-sm text-muted-foreground">{api.description}</p>
                ) : null}
                <a
                    className={`${buttonVariants({ variant: "secondary", size: "sm" })} self-start`}
                    href={asset("openapi.json")}
                    download
                >
                    {t.download}
                </a>
            </div>
            <PageTocFolded label={words(locale).docs.onThisPage} items={toc} />
            <Section id="base" title={t.baseTitle}>
                <p className="text-sm text-muted-foreground">{t.baseHint}</p>
                <HostField words={words(locale).host} />
                <CodeTabs samples={base} copy={t.copy} />
            </Section>
            <Section id="authentication" title={t.authTitle}>
                <p className="text-sm text-muted-foreground">{t.auth}</p>
                <CodeTabs samples={auth} copy={t.copy} />
            </Section>
            <Section id="errors" title={t.errorsTitle}>
                <p className="text-sm text-muted-foreground">{t.errorsIntro}</p>
                <Table head={[t.status, t.meaning]} widths={["6rem", "auto"]}>
                    {common.map((response) => (
                        <tr key={response.status} id={`error-${response.status}`}>
                            <td className="px-3 py-2 align-top">
                                <code className="font-medium">{response.status}</code>
                            </td>
                            <td className="px-3 py-2 align-top text-muted-foreground">
                                {response.description}
                            </td>
                        </tr>
                    ))}
                </Table>
                <p className="text-xs font-medium text-muted-foreground">{t.errorBody}</p>
                {/* Highlighted at build time from a fixed sample. */}
                <HostedHtml
                    className="code-block overflow-x-auto rounded-md border border-border bg-surface p-3 text-xs"
                    html={errorBody}
                />
            </Section>
            <Section id="groups" title={t.groupsTitle}>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {api.groups.map((group) => (
                        <li key={group.tag} className="min-w-0">
                            <Link href={href(locale, pages.apiPath.group(group.tag))} className={CARD}>
                                <span className="font-medium">{group.tag}</span>
                                <span className="text-sm text-muted-foreground">
                                    {group.operations.length === 1
                                        ? t.callsOne
                                        : t.calls.replace("{count}", String(group.operations.length))}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            </Section>
            <ApiNeighbors locale={locale} path={pages.apiPath.overview()} />
        </ApiFrame>
    );
}

export function ApiGroupView({ locale, group }: { locale: SiteLocale; group: pages.ApiGroup }) {
    const t = words(locale).api;
    const path = pages.apiPath.group(group.tag);
    return (
        <ApiFrame locale={locale} current={path}>
            <PageHead locale={locale} page={path}>
                <Breadcrumb
                    label={words(locale).docs.breadcrumb}
                    trail={[
                        { label: words(locale).docs.title, to: href(locale, "docs/") },
                        { label: t.title, to: href(locale, pages.apiPath.overview()) },
                        { label: group.tag }
                    ]}
                />
            </PageHead>
            <div className="flex flex-col gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">{group.tag}</h1>
                <p className="text-muted-foreground">{t.groupIntro.replace("{group}", group.tag)}</p>
            </div>
            <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border">
                {group.operations.map((op) => (
                    <li key={op.id} className="min-w-0">
                        <Link
                            href={href(locale, pages.apiPath.operation(op))}
                            className="flex min-w-0 flex-col gap-1 px-4 py-3 hover:bg-surface"
                        >
                            <span className="flex min-w-0 items-center gap-2">
                                <MethodTag method={op.method} />
                                <code className="min-w-0 truncate text-sm" title={op.path}>
                                    {op.path}
                                </code>
                            </span>
                            {op.summary ? <span className="font-medium">{op.summary}</span> : null}
                            {op.description ? (
                                <span className="line-clamp-2 text-sm text-muted-foreground">
                                    {op.description}
                                </span>
                            ) : null}
                        </Link>
                    </li>
                ))}
            </ul>
            <ApiNeighbors locale={locale} path={path} />
        </ApiFrame>
    );
}

export async function ApiOperationView({
    locale,
    group,
    operation: op
}: {
    locale: SiteLocale;
    group: pages.ApiGroup;
    operation: ApiOperation;
}) {
    const t = words(locale).api;
    const path = pages.apiPath.operation(op);
    const operations = siteData().api.groups.flatMap((one) => one.operations);
    const { own, shared } = pages.splitResponses(op, pages.commonResponses(operations));
    const [samples, schema] = await Promise.all([
        highlightAll(requestSamples(op, EXAMPLE_ORIGIN)),
        op.body ? highlight(op.body, "json") : null
    ]);
    const errorsAt = `${href(locale, pages.apiPath.overview())}#errors`;
    const location = (where: string) =>
        (t as Record<string, unknown>)[`location_${where}`] as string | undefined;
    const toc: TocItem[] = [
        ...(op.parameters.length ? [{ id: "parameters", text: t.params }] : []),
        ...(op.body ? [{ id: "body", text: t.body }] : []),
        { id: "examples", text: t.examples },
        { id: "responses", text: t.responses }
    ];
    return (
        <ApiFrame
            locale={locale}
            current={path}
            aside={<PageToc label={words(locale).docs.onThisPage} items={toc} />}
        >
            <article className="flex min-w-0 flex-col gap-6">
                <PageHead locale={locale} page={path}>
                    <Breadcrumb
                        label={words(locale).docs.breadcrumb}
                        trail={[
                            { label: words(locale).docs.title, to: href(locale, "docs/") },
                            { label: t.title, to: href(locale, pages.apiPath.overview()) },
                            { label: group.tag, to: href(locale, pages.apiPath.group(group.tag)) },
                            { label: op.summary || op.path }
                        ]}
                    />
                </PageHead>
                <div className="flex min-w-0 flex-col gap-3">
                    <h1 className="text-3xl font-semibold tracking-tight">{op.summary || op.path}</h1>
                    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                        <MethodTag method={op.method} />
                        <code className="min-w-0 flex-1 break-all text-sm">{op.path}</code>
                        <CopyButton value={op.path} label={t.copyPath} className="shrink-0" />
                    </div>
                    {op.description ? <p className="text-muted-foreground">{op.description}</p> : null}
                    <p className="text-sm text-muted-foreground">
                        <Link
                            href={`${href(locale, pages.apiPath.overview())}#authentication`}
                            className="underline underline-offset-2 hover:text-foreground"
                        >
                            {t.authNeeded}
                        </Link>
                    </p>
                </div>
                <PageTocFolded label={words(locale).docs.onThisPage} items={toc} />
                {op.parameters.length ? (
                    <Section id="parameters" title={t.params}>
                        <Table
                            head={[t.field, t.location, t.type, t.description]}
                            widths={["28%", "12%", "16%", "44%"]}
                        >
                            {op.parameters.map((param) => (
                                <tr key={`${param.in}-${param.name}`}>
                                    <NameCell locale={locale} name={param.name} required={param.required} />
                                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                                        {location(param.in) ?? param.in}
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                        <code className="break-all text-xs text-muted-foreground">
                                            {param.type}
                                        </code>
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                        <div className="flex min-w-0 flex-col gap-1">
                                            {param.description ? (
                                                <span className="text-muted-foreground">
                                                    {param.description}
                                                </span>
                                            ) : null}
                                            <Constraints locale={locale} list={param.constraints} />
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </Table>
                    </Section>
                ) : null}
                {op.body ? (
                    <Section id="body" title={t.body}>
                        {op.bodyShapes.map((shape, at) => (
                            <div key={at} className="flex min-w-0 flex-col gap-2">
                                {op.bodyShapes.length > 1 ? (
                                    <p className="text-xs font-medium text-muted-foreground">
                                        {t.shape
                                            .replace("{n}", String(at + 1))
                                            .replace("{type}", shape.type)}
                                    </p>
                                ) : null}
                                {shape.fields.length ? (
                                    <Table
                                        head={[t.field, t.type, t.description]}
                                        widths={["30%", "18%", "52%"]}
                                    >
                                        <FieldRows locale={locale} fields={shape.fields} />
                                    </Table>
                                ) : op.bodyShapes.length === 1 ? (
                                    <code className="text-xs text-muted-foreground">{shape.type}</code>
                                ) : null}
                            </div>
                        ))}
                        {schema ? (
                            <details className="group min-w-0 rounded-md border border-border">
                                <summary className="cursor-pointer select-none px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
                                    {t.rawSchema}
                                </summary>
                                {/* Highlighted at build time from the generated document. */}
                                <HostedHtml
                                    className="code-block max-h-96 overflow-auto border-t border-border bg-surface p-3 text-xs"
                                    html={schema}
                                />
                            </details>
                        ) : null}
                    </Section>
                ) : null}
                <Section id="examples" title={t.examples}>
                    <CodeTabs samples={samples} copy={t.copy} />
                </Section>
                <Section id="responses" title={t.responses}>
                    {own.length ? (
                        <Table head={[t.status, t.meaning]} widths={["6rem", "auto"]}>
                            {own.map((response) => (
                                <tr key={response.status}>
                                    <td className="px-3 py-2 align-top">
                                        <code className="font-medium">{response.status}</code>
                                    </td>
                                    <td className="px-3 py-2 align-top text-muted-foreground">
                                        {response.description}
                                    </td>
                                </tr>
                            ))}
                        </Table>
                    ) : (
                        <p className="text-sm text-muted-foreground">{t.noOwnResponses}</p>
                    )}
                    {shared.length ? (
                        <p className="text-sm text-muted-foreground">
                            {t.sharedErrors.replace(
                                "{statuses}",
                                shared.map((response) => response.status).join(", ")
                            )}{" "}
                            <Link href={errorsAt} className="underline underline-offset-2 hover:text-foreground">
                                {t.sharedLink}
                            </Link>
                        </p>
                    ) : null}
                </Section>
                <ApiNeighbors locale={locale} path={path} />
            </article>
        </ApiFrame>
    );
}

export function ApiMoreView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).api;
    const path = pages.apiPath.more();
    const routes = undocumentedRoutes();
    return (
        <ApiFrame locale={locale} current={path}>
            <PageHead locale={locale} page={path}>
                <Breadcrumb
                    label={words(locale).docs.breadcrumb}
                    trail={[
                        { label: words(locale).docs.title, to: href(locale, "docs/") },
                        { label: t.title, to: href(locale, pages.apiPath.overview()) },
                        { label: t.undocumented }
                    ]}
                />
            </PageHead>
            <div className="flex flex-col gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">{t.undocumented}</h1>
                <p className="text-muted-foreground">{t.undocumentedHint}</p>
            </div>
            <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border text-sm">
                {routes.map((route) => (
                    <li
                        key={`${route.method} ${route.path}`}
                        className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2"
                    >
                        <MethodTag method={route.method} />
                        <code className="min-w-0 break-all">{route.path}</code>
                    </li>
                ))}
            </ul>
            <ApiNeighbors locale={locale} path={path} />
        </ApiFrame>
    );
}
