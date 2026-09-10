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

const PERIOD_OPTIONS = [
    { value: "1s", label: "per second" },
    { value: "1m", label: "per minute" },
    { value: "1h", label: "per hour" }
];

const KEY_OPTIONS = [
    { value: "ip", label: "By visitor address" },
    { value: "header", label: "By request header" }
];

const HSTS_OPTIONS = [
    { value: "0", label: "Not sent" },
    { value: "15552000", label: "6 months" },
    { value: "31536000", label: "1 year" },
    { value: "63072000", label: "2 years" }
];

const REDIRECT_OPTIONS = [
    { value: "www-to-apex", label: "www to the bare domain" },
    { value: "apex-to-www", label: "The bare domain to www" },
    { value: "regex", label: "Matching a pattern" }
];

const REWRITE_OPTIONS = [
    { value: "strip-prefix", label: "Remove a path prefix" },
    { value: "add-prefix", label: "Add a path prefix" },
    { value: "replace-path", label: "Rewrite the path by pattern" }
];

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
    const verdict = useMemo(
        () => (draft ? core.appEdgeConfigSchema.safeParse(draft) : null),
        [draft]
    );
    const invalid =
        verdict && !verdict.success
            ? (verdict.error.issues[0]?.message ?? "Check the values")
            : null;
    // Dirty means the values differ from what is saved, not that a field was touched.
    const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
    const preview = useMemo(() => (draft ? core.securityHeaderMap(draft.headers) : {}), [draft]);

    if (loadError) return <p className="text-xs text-danger">{loadError}</p>;
    if (!draft || !facts) {
        return (
            <div
                className="h-40 animate-pulse rounded-md bg-muted/40"
                aria-label="Loading the edge settings"
            />
        );
    }

    const update = (next: Partial<Config>) => setDraft({ ...draft, ...next });
    const updateHeaders = (next: Partial<Headers>) =>
        update({ headers: { ...draft.headers, ...next } });

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
            toast.show({ title: "Saved. The edge is using it now." });
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
                        ? "Opening the port. The service is redeploying."
                        : "Closing the port. The service is redeploying."
                    : "Saved."
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
                            <h3 className="text-sm font-medium">
                                Reachable on the server&apos;s address
                            </h3>
                            <p className="text-xs text-muted-foreground">
                                {facts.publishPort
                                    ? "The container port is open on the server's own address, so anyone who can reach the server can reach the service without its domains."
                                    : "Closed. The service is reached only through its domains and tunnels, where the firewall and these settings apply."}
                            </p>
                        </div>
                        <Switch
                            checked={facts.publishPort}
                            onChange={togglePort}
                            disabled={toggling || (portLocked && facts.publishPort)}
                            aria-label="Reachable on the server's address"
                        />
                    </div>
                    {portLocked && facts.publishPort && (
                        <p className="text-xs text-foreground-subtle">
                            {facts.catalog
                                ? "Polaris reaches this installed app on its port, so it stays open."
                                : "Polaris serves this service's domains from here and reaches it on its server's port. Switch its domains to be served by its own server to close it."}
                        </p>
                    )}
                </section>
            )}

            <section className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-medium">Traffic protection</h3>
                    <p className="text-xs text-muted-foreground">
                        Applied at the edge, before a request reaches the service.
                    </p>
                </div>

                <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Rate limits</span>
                    {draft.rateLimits.length === 0 && (
                        <p className="text-xs text-foreground-subtle">
                            No limit. Every request is let through.
                        </p>
                    )}
                    {draft.rateLimits.map((limit, index) => (
                        <div
                            key={index}
                            className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
                        >
                            <Input
                                value={limit.path ?? ""}
                                onChange={(event) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index
                                                ? {
                                                      ...one,
                                                      path: event.target.value.trim() || undefined
                                                  }
                                                : one
                                        )
                                    })
                                }
                                placeholder="Every path"
                                aria-label="Path this limit applies to"
                                className="h-8 w-32 text-xs"
                                disabled={!canEdit}
                            />
                            <Input
                                value={String(limit.average)}
                                onChange={(event) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index
                                                ? {
                                                      ...one,
                                                      average: Number(event.target.value) || 0
                                                  }
                                                : one
                                        )
                                    })
                                }
                                inputMode="numeric"
                                aria-label="Requests allowed"
                                className="h-8 w-20 text-xs"
                                disabled={!canEdit}
                            />
                            <Select
                                value={limit.period}
                                onValueChange={(period) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index
                                                ? { ...one, period: period as core.EdgeRatePeriod }
                                                : one
                                        )
                                    })
                                }
                                options={PERIOD_OPTIONS}
                                aria-label="Period"
                                className="h-8 w-32 text-xs"
                                disabled={!canEdit}
                            />
                            <label className="flex items-center gap-1 text-xs text-muted-foreground">
                                burst
                                <Input
                                    value={String(limit.burst)}
                                    onChange={(event) =>
                                        update({
                                            rateLimits: draft.rateLimits.map((one, at) =>
                                                at === index
                                                    ? {
                                                          ...one,
                                                          burst: Number(event.target.value) || 0
                                                      }
                                                    : one
                                            )
                                        })
                                    }
                                    inputMode="numeric"
                                    aria-label="Burst"
                                    className="h-8 w-20 text-xs"
                                    disabled={!canEdit}
                                />
                            </label>
                            <Select
                                value={limit.key}
                                onValueChange={(key) =>
                                    update({
                                        rateLimits: draft.rateLimits.map((one, at) =>
                                            at === index
                                                ? { ...one, key: key as core.EdgeRateKey }
                                                : one
                                        )
                                    })
                                }
                                options={KEY_OPTIONS}
                                aria-label="Counted"
                                className="h-8 w-44 text-xs"
                                disabled={!canEdit}
                            />
                            {limit.key === "header" && (
                                <Input
                                    value={limit.header ?? ""}
                                    onChange={(event) =>
                                        update({
                                            rateLimits: draft.rateLimits.map((one, at) =>
                                                at === index
                                                    ? {
                                                          ...one,
                                                          header:
                                                              event.target.value.trim() || undefined
                                                      }
                                                    : one
                                            )
                                        })
                                    }
                                    placeholder="X-Api-Key"
                                    aria-label="Header counted by"
                                    className="h-8 w-32 text-xs"
                                    disabled={!canEdit}
                                />
                            )}
                            {canEdit && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Remove this limit"
                                    title="Remove this limit"
                                    onClick={() =>
                                        update({
                                            rateLimits: draft.rateLimits.filter(
                                                (_, at) => at !== index
                                            )
                                        })
                                    }
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
                                    rateLimits: [
                                        ...draft.rateLimits,
                                        { average: 20, period: "1s", burst: 40, key: "ip" }
                                    ]
                                })
                            }
                        >
                            <Plus className="size-4 shrink-0" aria-hidden /> Add a limit
                        </Button>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                        Requests in progress at once
                    </span>
                    <Input
                        value={draft.concurrency === 0 ? "" : String(draft.concurrency)}
                        onChange={(event) =>
                            update({ concurrency: Number(event.target.value) || 0 })
                        }
                        placeholder="No cap"
                        inputMode="numeric"
                        aria-label="Requests in progress at once"
                        className="h-8 w-24 text-xs"
                        disabled={!canEdit}
                    />
                    <SegmentedControl
                        size="sm"
                        value={draft.concurrencyScope}
                        onValueChange={(scope) => update({ concurrencyScope: scope })}
                        options={[
                            { value: "client", label: "Per visitor" },
                            { value: "service", label: "Whole service" }
                        ]}
                        aria-label="Who the cap counts"
                    />
                </div>

                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Browser check</span>
                    <SegmentedControl
                        size="sm"
                        value={draft.challenge}
                        onValueChange={(challenge) => update({ challenge })}
                        options={[
                            { value: "off", label: "Off" },
                            { value: "auto", label: "When flooded" },
                            { value: "on", label: "Always" }
                        ]}
                        aria-label="Browser check"
                    />
                    <p className="text-xs text-foreground-subtle">
                        Visitors&apos; browsers solve a short calculation before they get through,
                        which scripts flooding the service cannot skip. Webhooks and APIs need a
                        firewall rule that skips the browser check for their path.
                    </p>
                    {draft.challenge === "auto" && facts.flooded && (
                        <p className="flex items-center gap-1.5 text-xs text-warning">
                            <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                            Flooded right now, so visitors are being checked.
                        </p>
                    )}
                    {draft.challenge !== "off" && facts.guardChallenge === false && (
                        <p className="text-xs text-danger">
                            The firewall on this server is older than the browser check and will not
                            run it. Update Polaris from Settings to switch it on.
                        </p>
                    )}
                </div>
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-medium">Security headers</h3>
                    <p className="text-xs text-muted-foreground">
                        Sent with every answer the service gives.
                    </p>
                </div>
                <SegmentedControl
                    size="sm"
                    value={draft.headers.preset}
                    onValueChange={(preset) => updateHeaders({ preset })}
                    options={[
                        { value: "off", label: "Off" },
                        {
                            value: "recommended",
                            label: "Recommended",
                            title: "Safe in front of any app"
                        },
                        {
                            value: "strict",
                            label: "Strict",
                            title: "Full isolation. Test the app with it first."
                        }
                    ]}
                    aria-label="Security headers"
                />
                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        HSTS
                        <Select
                            // Read back from what would actually be sent, so the preset's own
                            // lifetime shows until somebody picks another.
                            value={
                                /max-age=(\d+)/.exec(
                                    preview["Strict-Transport-Security"] ?? ""
                                )?.[1] ?? "0"
                            }
                            onValueChange={(value) => updateHeaders({ hstsMaxAge: Number(value) })}
                            options={HSTS_OPTIONS}
                            aria-label="HSTS lifetime"
                            className="h-8 w-32 text-xs"
                            disabled={!canEdit}
                        />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                            checked={
                                "Strict-Transport-Security" in preview &&
                                preview["Strict-Transport-Security"]!.includes("includeSubDomains")
                            }
                            onChange={(checked) =>
                                updateHeaders({ hstsIncludeSubdomains: checked })
                            }
                            disabled={!canEdit}
                            aria-label="Include subdomains"
                        />
                        Subdomains
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                            checked={
                                "Strict-Transport-Security" in preview &&
                                preview["Strict-Transport-Security"]!.includes("preload")
                            }
                            onChange={(checked) => updateHeaders({ hstsPreload: checked })}
                            disabled={!canEdit}
                            aria-label="Preload"
                        />
                        Preload
                    </label>
                </div>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Content Security Policy
                    <Textarea
                        value={draft.headers.contentSecurityPolicy ?? ""}
                        onChange={(event) =>
                            updateHeaders({
                                contentSecurityPolicy: event.target.value || undefined
                            })
                        }
                        placeholder={preview["Content-Security-Policy"] ?? "Not sent"}
                        rows={2}
                        className="font-mono text-xs"
                        disabled={!canEdit}
                    />
                </label>
                {Object.keys(preview).length > 0 && (
                    <ul className="flex flex-col gap-1 rounded-md border border-border p-2">
                        {Object.entries(preview).map(([name, value]) => {
                            const preset = PRESET_FIELDS[name];
                            const custom = draft.headers.custom.some(
                                (entry) => entry.name === name
                            );
                            return (
                                <li key={name} className="group flex items-start gap-2 text-xs">
                                    <code className="shrink-0 font-mono text-foreground">
                                        {name}
                                    </code>
                                    <code className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
                                        {value}
                                    </code>
                                    {canEdit &&
                                        (preset || custom) &&
                                        name !== "Strict-Transport-Security" && (
                                            <button
                                                type="button"
                                                aria-label={`Stop sending ${name}`}
                                                title={`Stop sending ${name}`}
                                                className="text-foreground-subtle hover:text-foreground"
                                                onClick={() =>
                                                    custom
                                                        ? updateHeaders({
                                                              custom: draft.headers.custom.filter(
                                                                  (entry) => entry.name !== name
                                                              )
                                                          })
                                                        : preset &&
                                                          updateHeaders({
                                                              [preset.key]: preset.off
                                                          } as Partial<Headers>)
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
                            placeholder="Header"
                            aria-label="Header name"
                            className="h-8 w-44 text-xs"
                        />
                        <Input
                            value={headerValue}
                            onChange={(event) => setHeaderValue(event.target.value)}
                            placeholder="Value"
                            aria-label="Header value"
                            className="h-8 min-w-0 flex-1 text-xs"
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={
                                !headerName.trim() ||
                                draft.headers.custom.length >= core.EDGE_CUSTOM_HEADERS_MAX
                            }
                            onClick={() => {
                                const name = headerName.trim();
                                updateHeaders({
                                    custom: [
                                        ...draft.headers.custom.filter(
                                            (entry) => entry.name !== name
                                        ),
                                        { name, value: headerValue.trim() }
                                    ]
                                });
                                setHeaderName("");
                                setHeaderValue("");
                            }}
                        >
                            <Plus className="size-4 shrink-0" aria-hidden /> Add header
                        </Button>
                    </div>
                )}
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-medium">Redirects and rewrites</h3>
                    <p className="text-xs text-muted-foreground">
                        A www or bare-domain redirect only applies once the service has both names.
                    </p>
                </div>
                {draft.redirects.map((redirect, index) => (
                    <div
                        key={`r${index}`}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
                    >
                        <Select
                            value={redirect.kind}
                            onValueChange={(kind) =>
                                update({
                                    redirects: draft.redirects.map((one, at) =>
                                        at === index
                                            ? { ...one, kind: kind as core.EdgeRedirectKind }
                                            : one
                                    )
                                })
                            }
                            options={REDIRECT_OPTIONS}
                            aria-label="Redirect"
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
                                                at === index
                                                    ? {
                                                          ...one,
                                                          regex: event.target.value || undefined
                                                      }
                                                    : one
                                            )
                                        })
                                    }
                                    placeholder="^https://example.com/old/(.*)"
                                    aria-label="Pattern"
                                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                                    disabled={!canEdit}
                                />
                                <Input
                                    value={redirect.replacement ?? ""}
                                    onChange={(event) =>
                                        update({
                                            redirects: draft.redirects.map((one, at) =>
                                                at === index
                                                    ? {
                                                          ...one,
                                                          replacement:
                                                              event.target.value || undefined
                                                      }
                                                    : one
                                            )
                                        })
                                    }
                                    placeholder="https://example.com/new/${1}"
                                    aria-label="Goes to"
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
                                        redirects: draft.redirects.map((one, at) =>
                                            at === index ? { ...one, permanent } : one
                                        )
                                    })
                                }
                                disabled={!canEdit}
                                aria-label="Permanent"
                            />
                            Permanent
                        </label>
                        {canEdit && (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Remove this redirect"
                                title="Remove this redirect"
                                onClick={() =>
                                    update({
                                        redirects: draft.redirects.filter((_, at) => at !== index)
                                    })
                                }
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                            </Button>
                        )}
                    </div>
                ))}
                {draft.rewrites.map((rewrite, index) => (
                    <div
                        key={`w${index}`}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
                    >
                        <Select
                            value={rewrite.kind}
                            onValueChange={(kind) =>
                                update({
                                    rewrites: draft.rewrites.map((one, at) =>
                                        at === index
                                            ? { ...one, kind: kind as core.EdgeRewriteKind }
                                            : one
                                    )
                                })
                            }
                            options={REWRITE_OPTIONS}
                            aria-label="Rewrite"
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
                                                at === index
                                                    ? {
                                                          ...one,
                                                          regex: event.target.value || undefined
                                                      }
                                                    : one
                                            )
                                        })
                                    }
                                    placeholder="^/api/v1/(.*)"
                                    aria-label="Pattern"
                                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                                    disabled={!canEdit}
                                />
                                <Input
                                    value={rewrite.replacement ?? ""}
                                    onChange={(event) =>
                                        update({
                                            rewrites: draft.rewrites.map((one, at) =>
                                                at === index
                                                    ? {
                                                          ...one,
                                                          replacement:
                                                              event.target.value || undefined
                                                      }
                                                    : one
                                            )
                                        })
                                    }
                                    placeholder="/v1/${1}"
                                    aria-label="Rewritten to"
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
                                            at === index
                                                ? {
                                                      ...one,
                                                      prefix: event.target.value.trim() || undefined
                                                  }
                                                : one
                                        )
                                    })
                                }
                                placeholder="/api"
                                aria-label="Path prefix"
                                className="h-8 w-40 font-mono text-xs"
                                disabled={!canEdit}
                            />
                        )}
                        {canEdit && (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Remove this rewrite"
                                title="Remove this rewrite"
                                onClick={() =>
                                    update({
                                        rewrites: draft.rewrites.filter((_, at) => at !== index)
                                    })
                                }
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
                                onClick={() =>
                                    update({
                                        redirects: [
                                            ...draft.redirects,
                                            { kind: "www-to-apex", permanent: true }
                                        ]
                                    })
                                }
                            >
                                <Plus className="size-4 shrink-0" aria-hidden /> Add a redirect
                            </Button>
                        )}
                        {draft.rewrites.length < core.EDGE_REWRITES_MAX && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                    update({
                                        rewrites: [...draft.rewrites, { kind: "strip-prefix" }]
                                    })
                                }
                            >
                                <Plus className="size-4 shrink-0" aria-hidden /> Add a rewrite
                            </Button>
                        )}
                    </div>
                )}
            </section>

            {canEdit && (
                <div className="flex items-center gap-3">
                    <Button
                        size="sm"
                        onClick={save}
                        disabled={!dirty || Boolean(invalid) || pending}
                        aria-disabled={!dirty || Boolean(invalid) || pending}
                    >
                        {pending ? "Saving..." : "Save"}
                    </Button>
                    {dirty && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDraft(saved)}
                            disabled={pending}
                        >
                            Discard
                        </Button>
                    )}
                    {dirty && invalid && <span className="text-xs text-danger">{invalid}</span>}
                    {error && <span className="text-xs text-danger">{error}</span>}
                </div>
            )}
        </div>
    );
}
