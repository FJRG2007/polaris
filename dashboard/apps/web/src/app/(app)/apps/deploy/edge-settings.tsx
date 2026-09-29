"use client";

/**
 * What the edge does in front of a service, on the service's own Settings tab.
 *
 * Three concerns, one save: how hard the service may be hit (rate limits, a
 * concurrency cap, the browser challenge), which headers every answer carries, and
 * which requests are redirected or rewritten on the way in. They are edited together
 * and saved as one value because they are rendered together - a half-saved edge
 * config is not a state the edge should ever be written in.
 *
 * Whether the service is reachable on the machine's own address is a separate switch
 * above them, because it is not an edge setting: it changes what the container
 * publishes, and so it takes effect through a redeploy rather than a save.
 */

import * as core from "@polaris/core";
import * as deployActions from "./actions";
import { Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Button, Input, SegmentedControl, Select, Switch, Textarea, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Config = core.AppEdgeConfig;
type Headers = core.EdgeHeaders;

/** What the screen reads besides the config itself. */
interface Facts {
    readonly publishPort: boolean;
    readonly flooded: boolean;
    readonly catalog: boolean;
    readonly servedThroughPolaris: boolean;
    readonly local: boolean;
    readonly guardChallenge: boolean | null;
}

type Option = { readonly value: string; readonly label: NamespaceKey<"deployConfig"> };

const PERIOD_OPTIONS: readonly Option[] = [
    { value: "1s", label: "edge.periods.second" },
    { value: "1m", label: "edge.periods.minute" },
    { value: "1h", label: "edge.periods.hour" }
];

const KEY_OPTIONS: readonly Option[] = [
    { value: "ip", label: "edge.keys.ip" },
    { value: "header", label: "edge.keys.header" }
];

const HSTS_OPTIONS: readonly Option[] = [
    { value: "0", label: "edge.hsts.off" },
    { value: "15552000", label: "edge.hsts.months6" },
    { value: "31536000", label: "edge.hsts.year1" },
    { value: "63072000", label: "edge.hsts.years2" }
];

const REDIRECT_OPTIONS: readonly Option[] = [
    { value: "www-to-apex", label: "edge.redirectKinds.wwwToApex" },
    { value: "apex-to-www", label: "edge.redirectKinds.apexToWww" },
    { value: "regex", label: "edge.redirectKinds.regex" }
];

const REWRITE_OPTIONS: readonly Option[] = [
    { value: "strip-prefix", label: "edge.rewriteKinds.stripPrefix" },
    { value: "add-prefix", label: "edge.rewriteKinds.addPrefix" },
    { value: "replace-path", label: "edge.rewriteKinds.replacePath" }
];

/** A list of options with its labels in the reader's language. */
function translated(t: NamespaceTranslator<"deployConfig">, options: readonly Option[]) {
    return options.map((option) => ({ value: option.value, label: t(option.label) }));
}

/** The preset headers a removal switches off, by the override that does it. The
 *  value is what "do not send" is for that field. */
const PRESET_FIELDS: Readonly<Record<string, { key: keyof Headers; off: string | boolean }>> = {
    "Content-Security-Policy": { key: "contentSecurityPolicy", off: "" },
    "X-Frame-Options": { key: "frameOptions", off: "" },
    "Referrer-Policy": { key: "referrerPolicy", off: "" },
    "Permissions-Policy": { key: "permissionsPolicy", off: "" },
    "Cross-Origin-Opener-Policy": { key: "crossOriginOpenerPolicy", off: "" },
    "Cross-Origin-Embedder-Policy": { key: "crossOriginEmbedderPolicy", off: "" },
    "Cross-Origin-Resource-Policy": { key: "crossOriginResourcePolicy", off: "" },
    "X-Content-Type-Options": { key: "contentTypeNosniff", off: false }
};

export function EdgeSettings({
    applicationId,
    canEdit,
    canConfigure,
    onChanged
}: {
    applicationId: string;
    /** May change what the edge does (domains.manage). */
    canEdit: boolean;
    /** May change what the container publishes (service.configure). */
    canConfigure: boolean;
    onChanged: () => void;
}) {
    const toast = useToast();
    const t = useTranslations("deployConfig");
    const [saved, setSaved] = useState<Config | null>(null);
    const [draft, setDraft] = useState<Config | null>(null);
    const [facts, setFacts] = useState<Facts | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [toggling, startToggle] = useTransition();
    const [headerName, setHeaderName] = useState("");
    const [headerValue, setHeaderValue] = useState("");

    const load = useCallback(() => {
        void deployActions.edgeSettingsAction(applicationId).then((result) => {
            if ("error" in result) {
                setLoadError(result.error);
                return;
            }
            setLoadError(null);
            setSaved(result.config);
            setDraft(result.config);
            setFacts({
                publishPort: result.publishPort,
                flooded: result.flooded,
                catalog: result.catalog,
                servedThroughPolaris: result.servedThroughPolaris,
                local: result.local,
                guardChallenge: result.guardChallenge
            });
        });
    }, [applicationId]);

    useEffect(load, [load]);

    // Checked against the same schema the server applies, on every change, so what
    // Save would refuse is said beside the form rather than after pressing it.
    const verdict = useMemo(() => (draft ? core.appEdgeConfigSchema.safeParse(draft) : null), [draft]);
    const invalid = verdict && !verdict.success ? (verdict.error.issues[0]?.message ?? t("edge.checkValues")) : null;
    // Dirty means the values differ from what is saved, not that a field was touched.
    const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
    const preview = useMemo(() => (draft ? core.securityHeaderMap(draft.headers) : {}), [draft]);

    if (loadError) return <p className="text-xs text-danger">{loadError}</p>;
    if (!draft || !facts) {
        return <div className="h-40 animate-pulse rounded-md bg-muted/40" aria-label={t("edge.loading")} />;
    }

    const update = (next: Partial<Config>) => setDraft({ ...draft, ...next });
    const updateHeaders = (next: Partial<Headers>) => update({ headers: { ...draft.headers, ...next } });

    function save() {
        if (!verdict?.success) return;
        setError(null);
        const next = verdict.data;
        startTransition(async () => {
            const result = await deployActions.saveEdgeSettingsAction(applicationId, next);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(next);
            setDraft(next);
            toast.show({ title: t("edge.saved") });
            onChanged();
        });
    }

    function togglePort(publish: boolean) {
        if (!facts) return;
        const before = facts.publishPort;
        // Shown at once and put back if the server refuses.
        setFacts({ ...facts, publishPort: publish });
        startToggle(async () => {
            const result = await deployActions.setPublishPortAction(applicationId, publish);
            if (result.error) {
                setFacts((current) => (current ? { ...current, publishPort: before } : current));
                toast.show({ title: result.error });
                return;
            }
            toast.show({
                title: result.redeployed
                    ? publish
                        ? t("edge.opening")
                        : t("edge.closing")
                    : t("edge.savedShort")
            });
            onChanged();
        });
    }

    const portLocked = facts.catalog || facts.servedThroughPolaris;

    return (
        <div className="flex flex-col gap-6">
            {canConfigure && (
                <section className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h3 className="text-sm font-medium">{t("edge.publishPort")}</h3>
                            <p className="text-xs text-muted-foreground">
                                {facts.publishPort
                                    ? t("edge.publishPortOpen")
                                    : t("edge.publishPortClosed")}
                            </p>
                        </div>
                        <Switch
                            checked={facts.publishPort}
                            onChange={togglePort}
                            disabled={toggling || (portLocked && facts.publishPort)}
                            aria-label={t("edge.publishPort")}
                        />
                    </div>
                    {portLocked && facts.publishPort && (
                        <p className="text-xs text-foreground-subtle">
                            {facts.catalog
                                ? t("edge.lockedCatalog")
                                : t("edge.lockedPolaris")}
                        </p>
                    )}
                </section>
            )}

            <section className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-medium">{t("edge.traffic")}</h3>
                    <p className="text-xs text-muted-foreground">
                        {t("edge.trafficHint")}
                    </p>
                </div>

                <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t("edge.rateLimits")}</span>
                    {draft.rateLimits.length === 0 && (
                        <p className="text-xs text-foreground-subtle">{t("edge.noLimit")}</p>
                    )}
                    {draft.rateLimits.map((limit, index) => (
                        <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                            <Input
                                value={limit.path ?? ""}
                                onChange={(event) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index ? { ...one, path: event.target.value.trim() || undefined } : one
                                        )
                                    })
                                }
                                placeholder={t("edge.everyPath")}
                                aria-label={t("edge.limitPath")}
                                className="h-8 w-32 text-xs"
                                disabled={!canEdit}
                            />
                            <Input
                                value={String(limit.average)}
                                onChange={(event) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index ? { ...one, average: Number(event.target.value) || 0 } : one
                                        )
                                    })
                                }
                                inputMode="numeric"
                                aria-label={t("edge.requestsAllowed")}
                                className="h-8 w-20 text-xs"
                                disabled={!canEdit}
                            />
                            <Select
                                value={limit.period}
                                onValueChange={(period) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index ? { ...one, period: period as core.EdgeRatePeriod } : one
                                        )
                                    })
                                }
                                options={translated(t, PERIOD_OPTIONS)}
                                aria-label={t("edge.period")}
                                className="h-8 w-32 text-xs"
                                disabled={!canEdit}
                            />
                            <label className="flex items-center gap-1 text-xs text-muted-foreground">
                                {t("edge.burstLabel")}
                                <Input
                                    value={String(limit.burst)}
                                    onChange={(event) =>
                                        update({
                                            rateLimits: draft.rateLimits.map((one, at) =>
                                                at === index ? { ...one, burst: Number(event.target.value) || 0 } : one
                                            )
                                        })
                                    }
                                    inputMode="numeric"
                                    aria-label={t("edge.burst")}
                                    className="h-8 w-20 text-xs"
                                    disabled={!canEdit}
                                />
                            </label>
                            <Select
                                value={limit.key}
                                onValueChange={(key) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index ? { ...one, key: key as core.EdgeRateKey } : one
                                        )
                                    })
                                }
                                options={translated(t, KEY_OPTIONS)}
                                aria-label={t("edge.counted")}
                                className="h-8 w-44 text-xs"
                                disabled={!canEdit}
                            />
                            {limit.key === "header" && (
                                <Input
                                    value={limit.header ?? ""}
                                    onChange={(event) =>
                                        update({
                                            rateLimits: draft.rateLimits.map((one, at) =>
                                                at === index ? { ...one, header: event.target.value.trim() || undefined } : one
                                            )
                                        })
                                    }
                                    // i18n-ignore: an example header name
                                    placeholder="X-Api-Key"
                                    aria-label={t("edge.headerCounted")}
                                    className="h-8 w-32 text-xs"
                                    disabled={!canEdit}
                                />
                            )}
                            {canEdit && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("edge.removeLimit")}
                                    title={t("edge.removeLimit")}
                                    onClick={() => update({ rateLimits: draft.rateLimits.filter((_, at) => at !== index) })}
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            )}
                        </div>
                    ))}
                    {canEdit && draft.rateLimits.length < core.EDGE_RATE_LIMITS_MAX && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-fit"
                            onClick={() =>
                                update({
                                    rateLimits: [...draft.rateLimits, { average: 20, period: "1s", burst: 40, key: "ip" }]
                                })
                            }
                        >
                            <Plus className="size-4 shrink-0" aria-hidden /> {t("edge.addLimit")}
                        </Button>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t("edge.concurrency")}</span>
                    <Input
                        value={draft.concurrency === 0 ? "" : String(draft.concurrency)}
                        onChange={(event) => update({ concurrency: Number(event.target.value) || 0 })}
                        placeholder={t("edge.noCap")}
                        inputMode="numeric"
                        aria-label={t("edge.concurrency")}
                        className="h-8 w-24 text-xs"
                        disabled={!canEdit}
                    />
                    <SegmentedControl
                        size="sm"
                        value={draft.concurrencyScope}
                        onValueChange={(scope) => update({ concurrencyScope: scope })}
                        options={[
                            { value: "client", label: t("edge.perVisitor") },
                            { value: "service", label: t("edge.wholeService") }
                        ]}
                        aria-label={t("edge.capScope")}
                    />
                </div>

                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{t("edge.browserCheck")}</span>
                    <SegmentedControl
                        size="sm"
                        value={draft.challenge}
                        onValueChange={(challenge) => update({ challenge })}
                        options={[
                            { value: "off", label: t("edge.off") },
                            { value: "auto", label: t("edge.whenFlooded") },
                            { value: "on", label: t("edge.always") }
                        ]}
                        aria-label={t("edge.browserCheck")}
                    />
                    <p className="text-xs text-foreground-subtle">
                        {t("edge.browserCheckHint")}
                    </p>
                    {draft.challenge === "auto" && facts.flooded && (
                        <p className="flex items-center gap-1.5 text-xs text-warning">
                            <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                            {t("edge.floodedNow")}
                        </p>
                    )}
                    {draft.challenge !== "off" && facts.guardChallenge === false && (
                        <p className="text-xs text-danger">
                            {t("edge.guardTooOld")}
                        </p>
                    )}
                </div>
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-medium">{t("edge.headers")}</h3>
                    <p className="text-xs text-muted-foreground">{t("edge.headersHint")}</p>
                </div>
                <SegmentedControl
                    size="sm"
                    value={draft.headers.preset}
                    onValueChange={(preset) => updateHeaders({ preset })}
                    options={[
                        { value: "off", label: t("edge.off") },
                        { value: "recommended", label: t("edge.recommended"), title: t("edge.recommendedTitle") },
                        { value: "strict", label: t("edge.strict"), title: t("edge.strictTitle") }
                    ]}
                    aria-label={t("edge.headers")}
                />
                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        {/* i18n-ignore: a header name */}
                        HSTS
                        <Select
                            // Read back from what would actually be sent, so the preset's own
                            // lifetime shows until somebody picks another.
                            value={/max-age=(\d+)/.exec(preview["Strict-Transport-Security"] ?? "")?.[1] ?? "0"}
                            onValueChange={(value) => updateHeaders({ hstsMaxAge: Number(value) })}
                            options={translated(t, HSTS_OPTIONS)}
                            aria-label={t("edge.hstsLifetime")}
                            className="h-8 w-32 text-xs"
                            disabled={!canEdit}
                        />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                            checked={"Strict-Transport-Security" in preview && preview["Strict-Transport-Security"]!.includes("includeSubDomains")}
                            onChange={(checked) => updateHeaders({ hstsIncludeSubdomains: checked })}
                            disabled={!canEdit}
                            aria-label={t("edge.includeSubdomains")}
                        />
                        {t("edge.subdomains")}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                            checked={"Strict-Transport-Security" in preview && preview["Strict-Transport-Security"]!.includes("preload")}
                            onChange={(checked) => updateHeaders({ hstsPreload: checked })}
                            disabled={!canEdit}
                            aria-label={t("edge.preload")}
                        />
                        {t("edge.preload")}
                    </label>
                </div>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t("edge.csp")}
                    <Textarea
                        value={draft.headers.contentSecurityPolicy ?? ""}
                        onChange={(event) => updateHeaders({ contentSecurityPolicy: event.target.value || undefined })}
                        placeholder={preview["Content-Security-Policy"] ?? t("edge.hsts.off")}
                        rows={2}
                        className="font-mono text-xs"
                        disabled={!canEdit}
                    />
                </label>
                {Object.keys(preview).length > 0 && (
                    <ul className="flex flex-col gap-1 rounded-md border border-border p-2">
                        {Object.entries(preview).map(([name, value]) => {
                            const preset = PRESET_FIELDS[name];
                            const custom = draft.headers.custom.some((entry) => entry.name === name);
                            return (
                                <li key={name} className="group flex items-start gap-2 text-xs">
                                    <code className="shrink-0 font-mono text-foreground">{name}</code>
                                    <code className="min-w-0 flex-1 break-all font-mono text-muted-foreground">{value}</code>
                                    {canEdit && (preset || custom) && name !== "Strict-Transport-Security" && (
                                        <button
                                            type="button"
                                            aria-label={t("edge.stopSending", { name })}
                                            title={t("edge.stopSending", { name })}
                                            className="text-foreground-subtle hover:text-foreground"
                                            onClick={() =>
                                                custom
                                                    ? updateHeaders({ custom: draft.headers.custom.filter((entry) => entry.name !== name) })
                                                    : preset && updateHeaders({ [preset.key]: preset.off } as Partial<Headers>)
                                            }
                                        >
                                            <Trash2 className="size-3.5 shrink-0" aria-hidden />
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={headerName}
                            onChange={(event) => setHeaderName(event.target.value)}
                            placeholder={t("edge.header")}
                            aria-label={t("edge.headerName")}
                            className="h-8 w-44 text-xs"
                        />
                        <Input
                            value={headerValue}
                            onChange={(event) => setHeaderValue(event.target.value)}
                            placeholder={t("edge.value")}
                            aria-label={t("edge.headerValue")}
                            className="h-8 min-w-0 flex-1 text-xs"
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={!headerName.trim() || draft.headers.custom.length >= core.EDGE_CUSTOM_HEADERS_MAX}
                            onClick={() => {
                                const name = headerName.trim();
                                updateHeaders({
                                    custom: [
                                        ...draft.headers.custom.filter((entry) => entry.name !== name),
                                        { name, value: headerValue.trim() }
                                    ]
                                });
                                setHeaderName("");
                                setHeaderValue("");
                            }}
                        >
                            <Plus className="size-4 shrink-0" aria-hidden /> {t("edge.addHeader")}
                        </Button>
                    </div>
                )}
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-medium">{t("edge.redirects")}</h3>
                    <p className="text-xs text-muted-foreground">
                        {t("edge.redirectsHint")}
                    </p>
                </div>
                {draft.redirects.map((redirect, index) => (
                    <div key={`r${index}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                        <Select
                            value={redirect.kind}
                            onValueChange={(kind) =>
                                update({
                                    redirects: draft.redirects.map((one, at) =>
                                        at === index ? { ...one, kind: kind as core.EdgeRedirectKind } : one
                                    )
                                })
                            }
                            options={translated(t, REDIRECT_OPTIONS)}
                            aria-label={t("edge.redirect")}
                            className="h-8 w-56 text-xs"
                            disabled={!canEdit}
                        />
                        {redirect.kind === "regex" && (
                            <>
                                <Input
                                    value={redirect.regex ?? ""}
                                    onChange={(event) =>
                                        update({
                                            redirects: draft.redirects.map((one, at) =>
                                                at === index ? { ...one, regex: event.target.value || undefined } : one
                                            )
                                        })
                                    }
                                    // i18n-ignore: an example pattern
                                    placeholder="^https://example.com/old/(.*)"
                                    aria-label={t("edge.pattern")}
                                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                                    disabled={!canEdit}
                                />
                                <Input
                                    value={redirect.replacement ?? ""}
                                    onChange={(event) =>
                                        update({
                                            redirects: draft.redirects.map((one, at) =>
                                                at === index ? { ...one, replacement: event.target.value || undefined } : one
                                            )
                                        })
                                    }
                                    // i18n-ignore: an example replacement
                                    placeholder="https://example.com/new/${1}"
                                    aria-label={t("edge.goesTo")}
                                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                                    disabled={!canEdit}
                                />
                            </>
                        )}
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Switch
                                checked={redirect.permanent}
                                onChange={(permanent) =>
                                    update({
                                        redirects: draft.redirects.map((one, at) => (at === index ? { ...one, permanent } : one))
                                    })
                                }
                                disabled={!canEdit}
                                aria-label={t("edge.permanent")}
                            />
                            {t("edge.permanent")}
                        </label>
                        {canEdit && (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("edge.removeRedirect")}
                                title={t("edge.removeRedirect")}
                                onClick={() => update({ redirects: draft.redirects.filter((_, at) => at !== index) })}
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                            </Button>
                        )}
                    </div>
                ))}
                {draft.rewrites.map((rewrite, index) => (
                    <div key={`w${index}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                        <Select
                            value={rewrite.kind}
                            onValueChange={(kind) =>
                                update({
                                    rewrites: draft.rewrites.map((one, at) =>
                                        at === index ? { ...one, kind: kind as core.EdgeRewriteKind } : one
                                    )
                                })
                            }
                            options={translated(t, REWRITE_OPTIONS)}
                            aria-label={t("edge.rewrite")}
                            className="h-8 w-56 text-xs"
                            disabled={!canEdit}
                        />
                        {rewrite.kind === "replace-path" ? (
                            <>
                                <Input
                                    value={rewrite.regex ?? ""}
                                    onChange={(event) =>
                                        update({
                                            rewrites: draft.rewrites.map((one, at) =>
                                                at === index ? { ...one, regex: event.target.value || undefined } : one
                                            )
                                        })
                                    }
                                    // i18n-ignore: an example pattern
                                    placeholder="^/api/v1/(.*)"
                                    aria-label={t("edge.pattern")}
                                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                                    disabled={!canEdit}
                                />
                                <Input
                                    value={rewrite.replacement ?? ""}
                                    onChange={(event) =>
                                        update({
                                            rewrites: draft.rewrites.map((one, at) =>
                                                at === index ? { ...one, replacement: event.target.value || undefined } : one
                                            )
                                        })
                                    }
                                    // i18n-ignore: an example replacement
                                    placeholder="/v1/${1}"
                                    aria-label={t("edge.rewrittenTo")}
                                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                                    disabled={!canEdit}
                                />
                            </>
                        ) : (
                            <Input
                                value={rewrite.prefix ?? ""}
                                onChange={(event) =>
                                    update({
                                        rewrites: draft.rewrites.map((one, at) =>
                                            at === index ? { ...one, prefix: event.target.value.trim() || undefined } : one
                                        )
                                    })
                                }
                                // i18n-ignore: an example path
                                placeholder="/api"
                                aria-label={t("edge.pathPrefix")}
                                className="h-8 w-40 font-mono text-xs"
                                disabled={!canEdit}
                            />
                        )}
                        {canEdit && (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("edge.removeRewrite")}
                                title={t("edge.removeRewrite")}
                                onClick={() => update({ rewrites: draft.rewrites.filter((_, at) => at !== index) })}
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                            </Button>
                        )}
                    </div>
                ))}
                {canEdit && (
                    <div className="flex flex-wrap gap-2">
                        {draft.redirects.length < core.EDGE_REDIRECTS_MAX && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => update({ redirects: [...draft.redirects, { kind: "www-to-apex", permanent: true }] })}
                            >
                                <Plus className="size-4 shrink-0" aria-hidden /> {t("edge.addRedirect")}
                            </Button>
                        )}
                        {draft.rewrites.length < core.EDGE_REWRITES_MAX && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => update({ rewrites: [...draft.rewrites, { kind: "strip-prefix" }] })}
                            >
                                <Plus className="size-4 shrink-0" aria-hidden /> {t("edge.addRewrite")}
                            </Button>
                        )}
                    </div>
                )}
            </section>

            {canEdit && (
                <div className="flex items-center gap-3">
                    <Button size="sm" onClick={save} disabled={!dirty || Boolean(invalid) || pending} aria-disabled={!dirty || Boolean(invalid) || pending}>
                        {pending ? t("edge.saving") : t("edge.save")}
                    </Button>
                    {dirty && (
                        <Button variant="ghost" size="sm" onClick={() => setDraft(saved)} disabled={pending}>
                            {t("edge.discard")}
                        </Button>
                    )}
                    {dirty && invalid && <span className="text-xs text-danger">{invalid}</span>}
                    {error && <span className="text-xs text-danger">{error}</span>}
                </div>
            )}
        </div>
    );
}
