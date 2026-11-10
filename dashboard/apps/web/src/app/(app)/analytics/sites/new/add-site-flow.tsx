"use client";

/**
 * Adding a site, step by step.
 *
 * Two roads, because the two kinds of site are measured differently:
 * - a service deployed here is already counted by the edge log, with nothing to
 *   install; the setup picks it, offers the tracker for what a log cannot see,
 *   and waits for the first visit;
 * - a site served from anywhere else is counted only by the tracker, so the setup
 *   creates it, hands over the tag written for the kind of project it is, and
 *   waits until the first visit proves the tag is in place.
 */

import Link from "next/link";
import * as polls from "@/app/(app)/analytics/analytics-polls";
import { useAppUrl } from "@/components/app-url";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { CodeView } from "@/components/json-view";
import { AnalyticsGuideLink } from "@/app/(app)/analytics/guide-link";
import { Check, CheckCircle2, Copy, Globe, Loader2, Server } from "lucide-react";
import { createExternalSiteAction, setTrackerEnabledAction, type HostedService } from "@/app/(app)/analytics/actions";
import { TRACKER_FRAMEWORKS, TRACKER_LANGUAGE, externalSiteSchema, trackerSnippet, type TrackerFramework } from "@/app/(app)/analytics/site-input";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select, Skeleton, Switch, cn } from "@polaris/ui";

type Road = "hosted" | "external";

interface Created {
    scope: "application" | "external";
    id: string;
    name: string;
    publicKey: string | null;
    trackerEnabled: boolean;
}

export function AddSiteFlow() {
    const t = useTranslations("analytics");
    const [road, setRoad] = useState<Road | null>(null);
    const [site, setSite] = useState<Created | null>(null);
    const step = road === null ? 0 : site === null ? 1 : 2;
    const labels = [t("add.stepKind"), road === "hosted" ? t("add.stepPick") : t("add.stepDetails"), t("add.stepInstall")];

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-1">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("add.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("add.intro")}</p>
            </div>
            <ol className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                {labels.map((label, index) => (
                    <li key={label} className="flex min-w-0 items-center gap-2">
                        <span
                            className={cn(
                                "flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] tabular-nums",
                                index < step
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : index === step
                                      ? "border-primary text-primary"
                                      : "border-border text-muted-foreground"
                            )}
                        >
                            {index < step ? <Check className="size-3" /> : index + 1}
                        </span>
                        <span className={cn("truncate", index === step ? "font-medium" : "text-muted-foreground")} title={label}>{label}</span>
                        {index < labels.length - 1 ? <span className="text-muted-foreground/40">/</span> : null}
                    </li>
                ))}
            </ol>

            {step === 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {(
                        [
                            { value: "hosted", icon: Server, title: t("add.hostedTitle"), body: t("add.hostedBody") },
                            { value: "external", icon: Globe, title: t("add.externalTitle"), body: t("add.externalBody") }
                        ] as const
                    ).map((choice) => (
                        <button
                            key={choice.value}
                            type="button"
                            onClick={() => setRoad(choice.value)}
                            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
                        >
                            <choice.icon className="size-5 text-primary" aria-hidden />
                            <span className="font-medium">{choice.title}</span>
                            <span className="text-sm text-muted-foreground">{choice.body}</span>
                        </button>
                    ))}
                </div>
            ) : null}

            {step === 1 && road === "hosted" ? <PickService onPicked={setSite} onBack={() => setRoad(null)} /> : null}
            {step === 1 && road === "external" ? <ExternalForm onCreated={setSite} onBack={() => setRoad(null)} /> : null}
            {step === 2 && site ? <Install site={site} onChange={setSite} /> : null}
        </div>
    );
}

function PickService({ onPicked, onBack }: { onPicked: (site: Created) => void; onBack: () => void }) {
    const t = useTranslations("analytics");
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<HostedService[] | null>(null);
    const [next, setNext] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const sentinel = useRef<HTMLDivElement | null>(null);

    const load = useCallback(
        (cursor: string | null, search: string, signal?: AbortSignal) => {
            setLoading(true);
            polls
                .analyticsHosted({ ...(cursor ? { cursor } : {}), ...(search ? { query: search } : {}) }, signal)
                .then((result) => {
                    if (signal?.aborted || "error" in result) return;
                    setNext(result.next);
                    setRows((current) => (cursor ? [...(current ?? []), ...result.rows] : result.rows));
                })
                .catch(() => setRows((current) => current ?? []))
                .finally(() => {
                    if (!signal?.aborted) setLoading(false);
                });
        },
        []
    );

    useEffect(() => {
        const controller = new AbortController();
        const timer = setTimeout(() => load(null, query.trim(), controller.signal), 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, load]);

    useEffect(() => {
        const node = sentinel.current;
        if (!node || !next || loading) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) load(next, query.trim());
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [next, loading, load, query]);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("add.pickTitle")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("sites.search")}
                    aria-label={t("sites.search")}
                    maxLength={120}
                />
                {rows === null ? (
                    <div className="flex flex-col gap-2">
                        {Array.from({ length: 4 }, (_, index) => (
                            <Skeleton key={index} className="h-12 w-full" />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">{t("add.noServices")}</p>
                ) : (
                    <ul className="flex max-h-[26rem] flex-col divide-y divide-border overflow-y-auto overscroll-contain rounded-md border border-border">
                        {rows.map((service) => (
                            <li key={service.id}>
                                <button
                                    type="button"
                                    onClick={() =>
                                        onPicked({
                                            scope: "application",
                                            id: service.id,
                                            name: service.label,
                                            publicKey: null,
                                            trackerEnabled: false
                                        })
                                    }
                                    className="flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-left text-sm hover:bg-muted/40"
                                >
                                    <span className="truncate font-medium" title={service.label}>
                                        {service.label}
                                    </span>
                                    <span className="flex min-w-0 flex-wrap gap-1">
                                        {service.domains.length === 0 ? (
                                            <span className="text-xs text-muted-foreground">{t("add.noDomain")}</span>
                                        ) : (
                                            service.domains.slice(0, 4).map((domain) => (
                                                <Badge key={domain} variant="neutral" className="max-w-full truncate">
                                                    {domain}
                                                </Badge>
                                            ))
                                        )}
                                    </span>
                                </button>
                            </li>
                        ))}
                        {next ? <div ref={sentinel} className="h-6" /> : null}
                    </ul>
                )}
                <div>
                    <Button variant="ghost" size="sm" onClick={onBack}>
                        {t("add.back")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function ExternalForm({ onCreated, onBack }: { onCreated: (site: Created) => void; onBack: () => void }) {
    const t = useTranslations("analytics");
    const [name, setName] = useState("");
    const [hostname, setHostname] = useState("");
    const [failure, setFailure] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    const parsed = externalSiteSchema.safeParse({ name, hostname });
    // Empty is unfinished, not wrong: only a typed value that cannot be used is flagged.
    const nameBad = name.trim() !== "" && !externalSiteSchema.shape.name.safeParse(name).success;
    const hostBad = hostname.trim() !== "" && !externalSiteSchema.shape.hostname.safeParse(hostname).success;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("add.detailsTitle")}</CardTitle>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!parsed.success || saving) return;
                        startSave(async () => {
                            const result = await createExternalSiteAction(parsed.data);
                            if ("error" in result) {
                                setFailure(result.error);
                                return;
                            }
                            onCreated({
                                scope: "external",
                                id: result.scopeId,
                                name: result.name,
                                publicKey: result.publicKey,
                                trackerEnabled: true
                            });
                        });
                    }}
                >
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium">{t("add.name")} *</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            onBlur={() => setName((value) => value.trim())}
                            maxLength={80}
                            placeholder={t("add.namePlaceholder")}
                            aria-invalid={nameBad || undefined}
                        />
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium">{t("add.hostname")} *</span>
                        <Input
                            value={hostname}
                            onChange={(event) => setHostname(event.target.value)}
                            onBlur={() => {
                                const host = externalSiteSchema.shape.hostname.safeParse(hostname);
                                if (host.success) setHostname(host.data);
                            }}
                            maxLength={260}
                            placeholder="example.com"
                            inputMode="url"
                            aria-invalid={hostBad || undefined}
                        />
                        <span className={cn("text-xs", hostBad ? "text-danger-ink" : "text-muted-foreground")}>
                            {hostBad ? t("add.hostnameBad") : t("add.hostnameHint")}
                        </span>
                    </label>
                    {failure ? <p className="text-sm text-danger-ink">{failure}</p> : null}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
                            {t("add.back")}
                        </Button>
                        <Button type="submit" size="sm" aria-disabled={!parsed.success || saving} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t("add.create")}
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}

/** How often the last step asks whether the first visit has arrived. */
const CHECK_EVERY_MS = 5_000;

function Install({ site, onChange }: { site: Created; onChange: (site: Created) => void }) {
    const t = useTranslations("analytics");
    const baseUrl = useAppUrl();
    const [framework, setFramework] = useState<TrackerFramework>("html");
    const [copied, setCopied] = useState(false);
    const [first, setFirst] = useState<{ at: string; path: string; tracker: boolean } | null>(null);
    const [key, setKey] = useState<string | null>(site.publicKey);
    const [failure, setFailure] = useState<string | null>(null);
    const [checking, setChecking] = useState(true);

    // The key of a service that was only picked comes with its first read.
    useEffect(() => {
        if (key) return;
        void polls
            .analyticsOverview({ scopeType: site.scope, scopeId: site.id, range: "24h", filters: "" })
            .then((result) => {
                if ("error" in result) setFailure(result.error);
                else {
                    setKey(result.site.publicKey);
                    if (result.site.trackerEnabled !== site.trackerEnabled)
                        onChange({ ...site, trackerEnabled: result.site.trackerEnabled });
                }
            })
            .catch(() => undefined);
    }, [key, site, onChange]);

    useEffect(() => {
        if (first) return;
        const controller = new AbortController();
        const ask = () =>
            polls
                .analyticsInstallation({ scopeType: site.scope, scopeId: site.id }, controller.signal)
                .then((result) => {
                    if (controller.signal.aborted) return;
                    setChecking(false);
                    if ("error" in result) setFailure(result.error);
                    else if (result.first) setFirst(result.first);
                })
                .catch(() => undefined);
        void ask();
        const timer = setInterval(() => void ask(), CHECK_EVERY_MS);
        return () => {
            clearInterval(timer);
            controller.abort();
        };
    }, [site.scope, site.id, first]);

    const snippet = key ? trackerSnippet(framework, baseUrl, key) : "";
    const open = `/analytics?scope=${site.scope}&id=${encodeURIComponent(site.id)}`;

    return (
        <div className="flex flex-col gap-3">
            {site.scope === "application" ? (
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <p className="text-sm">{t("add.edgeReady", { name: site.name })}</p>
                        <label className="flex items-start gap-3">
                            <Switch
                                checked={site.trackerEnabled}
                                aria-label={t("tracker.accept")}
                                onChange={(checked) => {
                                    const previous = site;
                                    onChange({ ...site, trackerEnabled: checked });
                                    void setTrackerEnabledAction({ scopeType: site.scope, scopeId: site.id, enabled: checked }).then(
                                        (result) => {
                                            if (result.error) {
                                                setFailure(result.error);
                                                onChange(previous);
                                            }
                                        }
                                    );
                                }}
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="text-sm font-medium">{t("tracker.accept")}</span>
                                <span className="text-xs text-muted-foreground">{t("add.trackerOptional")}</span>
                            </span>
                        </label>
                    </CardBody>
                </Card>
            ) : null}

            {site.trackerEnabled ? (
                <Card>
                    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                        <CardTitle className="text-sm">{t("add.snippetTitle")}</CardTitle>
                        <Select
                            value={framework}
                            aria-label={t("add.framework")}
                            className="h-8 w-44"
                            options={TRACKER_FRAMEWORKS.map((value) => ({
                                value,
                                label: t(`add.frameworks.${value}` as NamespaceKey<"analytics">)
                            }))}
                            onValueChange={(value) => setFramework(value as TrackerFramework)}
                        />
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-xs text-muted-foreground">
                            {t(`add.where.${framework}` as NamespaceKey<"analytics">)}
                        </p>
                        <AnalyticsGuideLink />
                        {snippet ? (
                            <CodeView value={snippet} language={TRACKER_LANGUAGE[framework]} label={t("add.snippetTitle")} copyable={false} className="max-w-full" />
                        ) : (
                            <Skeleton className="h-16 w-full" />
                        )}
                        <div>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!snippet}
                                onClick={() => {
                                    void navigator.clipboard.writeText(snippet).then(() => {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 1500);
                                    });
                                }}
                            >
                                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                                {copied ? t("tracker.copied") : t("tracker.copy")}
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">{t("add.checkTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {failure ? <p className="text-sm text-danger-ink">{failure}</p> : null}
                    {first ? (
                        <p className="flex items-start gap-2 text-sm text-success-ink">
                            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                            <span className="min-w-0 break-words">
                                {first.tracker ? t("add.arrivedTracker", { path: first.path }) : t("add.arrived", { path: first.path })}
                            </span>
                        </p>
                    ) : (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                            {checking ? t("add.checking") : site.scope === "external" ? t("add.waitingTracker") : t("add.waitingEdge")}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button asChild size="sm">
                            <Link href={open}>{t("add.open")}</Link>
                        </Button>
                        <Button asChild size="sm" variant="ghost">
                            <Link href="/analytics/sites">{t("add.toSites")}</Link>
                        </Button>
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}
