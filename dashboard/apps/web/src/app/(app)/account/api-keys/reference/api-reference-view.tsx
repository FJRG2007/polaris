"use client";

/**
 * The API reference, drawn from plain data the page built on the server. The
 * examples are put together here, on the address this instance is reached at,
 * with a placeholder where the key goes - never a real one.
 */

import Link from "next/link";
import { useAppUrl } from "@/components/app-url";
import { curlCommand } from "@/lib/api-docs/curl";
import { ArrowLeft, Download } from "lucide-react";
import { Badge, Button, CopyButton, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export interface ReferenceEntry {
    id: string;
    method: string;
    path: string;
    tag: string;
    summary: string;
    description: string | null;
    changes: boolean;
    parameters: {
        name: string;
        where: "path" | "query" | "header";
        required: boolean;
        type: string;
        description: string | null;
    }[];
    body: string | null;
    bodyExample: string | null;
    binaryType: string | null;
    responses: { status: number; description: string; schema: string | null; text: boolean }[];
}

const METHOD_TONE: Record<string, string> = {
    GET: "text-sky-600 dark:text-sky-400",
    POST: "text-emerald-600 dark:text-emerald-400",
    PUT: "text-amber-600 dark:text-amber-400",
    DELETE: "text-danger"
};

const CODE =
    "overflow-x-auto overscroll-x-contain rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed";

export function ApiReferenceView({
    entries,
    placeholder
}: {
    entries: ReferenceEntry[];
    placeholder: string;
}) {
    const t = useTranslations("account");
    const base = useAppUrl();
    const tags = [...new Set(entries.map((entry) => entry.tag))];
    // i18n-ignore: an HTTP header, typed as is
    const header = `Authorization: Bearer ${placeholder}`;

    return (
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        href="/account/api-keys"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
                    >
                        <ArrowLeft className="size-3.5 shrink-0" />
                        {t("apiKeys.reference.back")}
                    </Link>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {t("apiKeys.reference.title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">{t("apiKeys.reference.intro")}</p>
                </div>
                <Button size="sm" variant="outline" asChild>
                    {/* A plain anchor: a router link would prefetch an API route. */}
                    <a
                        href="/api/openapi.json"
                        download="polaris-openapi.json"
                        className="no-underline"
                    >
                        <Download className="size-4 shrink-0" />
                        {t("apiKeys.reference.download")}
                    </a>
                </Button>
            </div>

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold">{t("apiKeys.reference.auth")}</h2>
                <p className="text-sm text-muted-foreground">{t("apiKeys.reference.authBody")}</p>
                <div className="flex items-start gap-2">
                    <pre className={cn(CODE, "min-w-0 flex-1")}>{header}</pre>
                    <CopyButton value={header} />
                </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
                <nav
                    aria-label={t("apiKeys.reference.contents")}
                    className="lg:sticky lg:top-4 lg:self-start"
                >
                    <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("apiKeys.reference.contents")}
                    </h2>
                    <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto overscroll-contain">
                        {tags.map((tag) => (
                            <div key={tag} className="flex flex-col gap-0.5">
                                <span className="text-xs font-semibold">{tag}</span>
                                {entries
                                    .filter((entry) => entry.tag === tag)
                                    .map((entry) => (
                                        <a
                                            key={entry.id}
                                            href={`#${entry.id}`}
                                            className="truncate text-xs text-muted-foreground no-underline hover:text-foreground"
                                            title={`${entry.method} ${entry.path}`}
                                        >
                                            {entry.summary}
                                        </a>
                                    ))}
                            </div>
                        ))}
                    </div>
                </nav>

                <div className="flex min-w-0 flex-col gap-8">
                    {entries.map((entry) => (
                        <Operation
                            key={entry.id}
                            entry={entry}
                            base={base}
                            placeholder={placeholder}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

function Operation({
    entry,
    base,
    placeholder
}: {
    entry: ReferenceEntry;
    base: string;
    placeholder: string;
}) {
    const t = useTranslations("account");
    const example = curlCommand(entry, base, placeholder);
    return (
        <section
            id={entry.id}
            className="flex scroll-mt-4 flex-col gap-3 border-t border-border pt-4"
        >
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{entry.summary}</h3>
                {entry.changes ? (
                    <Badge variant="warning">{t("apiKeys.reference.changes")}</Badge>
                ) : null}
            </div>
            <p className="min-w-0 break-all font-mono text-xs">
                <span className={cn("mr-2 font-semibold", METHOD_TONE[entry.method])}>
                    {entry.method}
                </span>
                {entry.path}
            </p>
            {entry.description ? (
                <p className="text-sm text-muted-foreground">{entry.description}</p>
            ) : null}

            {entry.parameters.length > 0 ? (
                <div className="flex flex-col gap-1">
                    <h4 className="text-xs font-medium text-muted-foreground">
                        {t("apiKeys.reference.parameters")}
                    </h4>
                    <div className="overflow-x-auto overscroll-x-contain">
                        <table className="w-full text-left text-xs">
                            <tbody>
                                {entry.parameters.map((parameter) => (
                                    <tr
                                        key={`${parameter.where}:${parameter.name}`}
                                        className="border-b border-border/60 align-top"
                                    >
                                        <td className="whitespace-nowrap py-1.5 pr-3 font-mono">
                                            {parameter.name}
                                            {parameter.required ? (
                                                <span className="ml-1 text-[0.6875rem] text-muted-foreground">
                                                    {t("apiKeys.reference.required")}
                                                </span>
                                            ) : null}
                                        </td>
                                        <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                                            {t(`apiKeys.reference.where.${parameter.where}`)}
                                        </td>
                                        <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-muted-foreground">
                                            {parameter.type}
                                        </td>
                                        <td className="w-full py-1.5 text-muted-foreground">
                                            {parameter.description}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : null}

            {entry.body ? (
                <details className="flex flex-col gap-1">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                        {t("apiKeys.reference.body")}
                    </summary>
                    <pre className={cn(CODE, "mt-1 max-h-80 overflow-y-auto overscroll-y-contain")}>
                        {entry.body}
                    </pre>
                </details>
            ) : entry.binaryType ? (
                <p className="text-xs text-muted-foreground">
                    {t("apiKeys.reference.body")}:{" "}
                    {t("apiKeys.reference.binaryBody", { type: entry.binaryType })}
                </p>
            ) : null}

            <div className="flex flex-col gap-1">
                <h4 className="text-xs font-medium text-muted-foreground">
                    {t("apiKeys.reference.responses")}
                </h4>
                {entry.responses.map((response) =>
                    response.schema ? (
                        <details key={response.status}>
                            <summary className="cursor-pointer text-xs">
                                <span className="mr-2 font-mono font-semibold">
                                    {response.status}
                                </span>
                                {response.description}
                                {response.text ? (
                                    <span className="ml-2 text-muted-foreground">
                                        ({t("apiKeys.reference.textToo")})
                                    </span>
                                ) : null}
                            </summary>
                            <pre
                                className={cn(
                                    CODE,
                                    "mt-1 max-h-80 overflow-y-auto overscroll-y-contain"
                                )}
                            >
                                {response.schema}
                            </pre>
                        </details>
                    ) : (
                        <p key={response.status} className="text-xs">
                            <span className="mr-2 font-mono font-semibold">{response.status}</span>
                            {response.description}
                        </p>
                    )
                )}
            </div>

            <div className="flex flex-col gap-1">
                <h4 className="text-xs font-medium text-muted-foreground">
                    {t("apiKeys.reference.example")}
                </h4>
                <div className="flex items-start gap-2">
                    <pre className={cn(CODE, "min-w-0 flex-1")}>{example}</pre>
                    <CopyButton value={example} />
                </div>
            </div>
        </section>
    );
}
