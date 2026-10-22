/**
 * The API reference, drawn with the design system's own pieces from the
 * OpenAPI document the build generated. A third-party renderer would bring its
 * own styles and scripts into a page that loads nothing from outside.
 */

import type { SiteLocale } from "@/data/builders";
import { Badge, buttonVariants } from "@polaris/ui";
import { asset, siteData, words } from "@/lib/site";

export function ApiDocsView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).api;
    const { api } = siteData();
    return (
        <div className="flex flex-col gap-8 lg:flex-row">
            <nav aria-label={t.title} className="flex shrink-0 flex-col gap-3 text-sm lg:sticky lg:top-20 lg:w-56 lg:self-start">
                {api.groups.map((group) => (
                    <div key={group.tag} className="flex flex-col gap-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">{group.tag}</p>
                        {group.operations.map((op) => (
                            <a key={op.id} href={`#${op.id}`} className="truncate text-muted-foreground hover:text-foreground" title={`${op.method} ${op.path}`}>
                                {op.summary || op.path}
                            </a>
                        ))}
                    </div>
                ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-6">
                <div className="flex flex-col gap-2">
                    <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
                    <p className="text-muted-foreground">{t.intro}</p>
                    {api.description ? <p className="text-sm text-muted-foreground">{api.description}</p> : null}
                    <a className={`${buttonVariants({ variant: "secondary", size: "sm" })} self-start`} href={asset("openapi.json")} download>
                        {t.download}
                    </a>
                </div>
                {api.groups.map((group) => (
                    <section key={group.tag} aria-label={group.tag} className="flex flex-col gap-4">
                        <h2 className="text-xl font-semibold">{group.tag}</h2>
                        {group.operations.map((op) => (
                            <article key={op.id} id={op.id} className="flex min-w-0 scroll-mt-20 flex-col gap-3 rounded-xl border border-border bg-card p-4">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <Badge variant="neutral">{op.method}</Badge>
                                    <code className="min-w-0 break-all text-sm">{op.path}</code>
                                </div>
                                {op.summary ? <p className="font-medium">{op.summary}</p> : null}
                                {op.description ? <p className="text-sm text-muted-foreground">{op.description}</p> : null}
                                {op.parameters.length ? (
                                    <div className="flex flex-col gap-1">
                                        <p className="text-xs font-medium text-muted-foreground">{t.params}</p>
                                        <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border text-sm">
                                            {op.parameters.map((param) => (
                                                <li key={`${param.in}-${param.name}`} className="flex flex-wrap gap-x-2 px-3 py-2">
                                                    <code>{param.name}</code>
                                                    <span className="text-xs text-muted-foreground">
                                                        {param.in} · {param.type}
                                                        {param.required ? ` · ${t.required}` : ""}
                                                    </span>
                                                    {param.description ? <span className="w-full text-muted-foreground">{param.description}</span> : null}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null}
                                {op.body ? (
                                    <div className="flex flex-col gap-1">
                                        <p className="text-xs font-medium text-muted-foreground">{t.body}</p>
                                        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface p-3 text-xs">{op.body}</pre>
                                    </div>
                                ) : null}
                                <div className="flex flex-col gap-1">
                                    <p className="text-xs font-medium text-muted-foreground">{t.responses}</p>
                                    <ul className="flex flex-col gap-1 text-sm">
                                        {op.responses.map((response) => (
                                            <li key={response.status} className="flex gap-2">
                                                <code className="shrink-0">{response.status}</code>
                                                <span className="text-muted-foreground">{response.description}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </article>
                        ))}
                    </section>
                ))}
            </div>
        </div>
    );
}
