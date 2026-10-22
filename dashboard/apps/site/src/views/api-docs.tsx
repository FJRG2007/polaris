/**
 * The API reference, drawn with the design system's own pieces from the
 * OpenAPI document the build generated. A third-party renderer would bring its
 * own styles and scripts into a page that loads nothing from outside. Every
 * example is highlighted while the site is built.
 */

import { requestSamples } from "@/data/docs";
import type { SiteLocale } from "@/data/builders";
import { CodeTabs } from "@/components/code-tabs";
import { Badge, buttonVariants } from "@polaris/ui";
import { SideList } from "@/views/docs";
import { DocsSearch } from "@/components/docs-search";
import { highlight, highlightAll } from "@/lib/highlight";
import { EXAMPLE_ORIGIN } from "@/lib/example-origin";
import { asset, href, siteData, words } from "@/lib/site";

export async function ApiDocsView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).api;
    const d = words(locale).docs;
    const { api } = siteData();
    const operations = api.groups.flatMap((group) => group.operations);
    const [samples, bodies, auth] = await Promise.all([
        Promise.all(operations.map((op) => highlightAll(requestSamples(op, EXAMPLE_ORIGIN)))),
        Promise.all(operations.map((op) => (op.body ? highlight(op.body, "json") : null))),
        highlightAll(
            requestSamples({ method: "GET", path: "/api/v1/me", body: null }, EXAMPLE_ORIGIN).slice(0, 1)
        )
    ]);
    const sampleFor = new Map(operations.map((op, at) => [op.id, samples[at]!]));
    const bodyFor = new Map(operations.map((op, at) => [op.id, bodies[at]]));
    const undocumented = api.routes.filter((route) => !route.operation);
    return (
        <div className="flex flex-col gap-8 lg:flex-row">
            <nav
                aria-label={t.title}
                className="flex shrink-0 flex-col gap-3 text-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:w-56 lg:self-start lg:overflow-y-auto"
            >
                <DocsSearch
                    index={asset(href(locale, "docs/search.json"))}
                    label={d.search}
                    empty={d.empty}
                    loading={d.loading}
                    failed={d.failed}
                />
                <SideList label={t.title}>
                    <a href="#authentication" className="text-muted-foreground hover:text-foreground">
                        {t.authTitle}
                    </a>
                    {api.groups.map((group) => (
                        <div key={group.tag} className="flex flex-col gap-1">
                            <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                                {group.tag}
                            </p>
                            {group.operations.map((op) => (
                                <a
                                    key={op.id}
                                    href={`#${op.id}`}
                                    className="truncate text-muted-foreground hover:text-foreground"
                                    title={`${op.method} ${op.path}`}
                                >
                                    {op.summary || op.path}
                                </a>
                            ))}
                        </div>
                    ))}
                    {undocumented.length ? (
                        <a href="#undocumented" className="text-muted-foreground hover:text-foreground">
                            {t.undocumented}
                        </a>
                    ) : null}
                </SideList>
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-6">
                <div className="flex flex-col gap-2">
                    <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
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
                <section id="authentication" className="flex scroll-mt-20 flex-col gap-3">
                    <h2 className="text-xl font-semibold">{t.authTitle}</h2>
                    <p className="text-sm text-muted-foreground">{t.auth}</p>
                    <CodeTabs samples={auth} copy={t.copy} />
                </section>
                {api.groups.map((group) => (
                    <section key={group.tag} aria-label={group.tag} className="flex flex-col gap-4">
                        <h2 className="text-xl font-semibold">{group.tag}</h2>
                        {group.operations.map((op) => {
                            const body = bodyFor.get(op.id);
                            return (
                                <article
                                    key={op.id}
                                    id={op.id}
                                    className="flex min-w-0 scroll-mt-20 flex-col gap-3 rounded-xl border border-border bg-card p-4"
                                >
                                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                                        <Badge variant="neutral">{op.method}</Badge>
                                        <code className="min-w-0 break-all text-sm">{op.path}</code>
                                    </div>
                                    {op.summary ? <p className="font-medium">{op.summary}</p> : null}
                                    {op.description ? (
                                        <p className="text-sm text-muted-foreground">
                                            {op.description}
                                        </p>
                                    ) : null}
                                    {op.parameters.length ? (
                                        <div className="flex flex-col gap-1">
                                            <p className="text-xs font-medium text-muted-foreground">
                                                {t.params}
                                            </p>
                                            <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border text-sm">
                                                {op.parameters.map((param) => (
                                                    <li
                                                        key={`${param.in}-${param.name}`}
                                                        className="flex flex-wrap gap-x-2 px-3 py-2"
                                                    >
                                                        <code>{param.name}</code>
                                                        <span className="text-xs text-muted-foreground">
                                                            {param.in} · {param.type}
                                                            {param.required ? ` · ${t.required}` : ""}
                                                        </span>
                                                        {param.description ? (
                                                            <span className="w-full text-muted-foreground">
                                                                {param.description}
                                                            </span>
                                                        ) : null}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    ) : null}
                                    {body ? (
                                        <div className="flex flex-col gap-1">
                                            <p className="text-xs font-medium text-muted-foreground">
                                                {t.body}
                                            </p>
                                            <div
                                                className="code-block max-h-80 overflow-auto rounded-md border border-border bg-surface p-3 text-xs"
                                                // Highlighted at build time from the generated document.
                                                dangerouslySetInnerHTML={{ __html: body }}
                                            />
                                        </div>
                                    ) : null}
                                    <div className="flex flex-col gap-1">
                                        <p className="text-xs font-medium text-muted-foreground">
                                            {t.examples}
                                        </p>
                                        <CodeTabs samples={sampleFor.get(op.id) ?? []} copy={t.copy} />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <p className="text-xs font-medium text-muted-foreground">
                                            {t.responses}
                                        </p>
                                        <ul className="flex flex-col gap-1 text-sm">
                                            {op.responses.map((response) => (
                                                <li key={response.status} className="flex gap-2">
                                                    <code className="shrink-0">{response.status}</code>
                                                    <span className="text-muted-foreground">
                                                        {response.description}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                </article>
                            );
                        })}
                    </section>
                ))}
                {undocumented.length ? (
                    <section id="undocumented" className="flex scroll-mt-20 flex-col gap-3">
                        <h2 className="text-xl font-semibold">{t.undocumented}</h2>
                        <p className="text-sm text-muted-foreground">{t.undocumentedHint}</p>
                        <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border text-sm">
                            {undocumented.map((route) => (
                                <li
                                    key={`${route.method} ${route.path}`}
                                    className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2"
                                >
                                    <Badge variant="neutral">{route.method}</Badge>
                                    <code className="min-w-0 break-all">{route.path}</code>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}
            </div>
        </div>
    );
}
