"use client";

/**
 * Guided domain setup. Four answers - where the server runs, how services should be
 * reachable, which domain and zones to use, and whether the DNS is actually there -
 * because each one changes what the next should even offer: a carrier-NAT line
 * cannot use a wildcard record, and a wildcard record makes tunnels unnecessary.
 *
 * The recommended option is always preselected, so finishing means pressing Continue.
 */

import { useEffect, useState } from "react";
import {
    Check,
    CheckCircle2,
    ChevronLeft,
    Copy,
    Globe,
    Loader2,
    Plus,
    RefreshCw,
    Sparkles,
    Trash2,
    TriangleAlert,
    Wand2
} from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Checkbox, Input, Select } from "@polaris/ui";
import type { ServerEnvironment } from "@polaris/core";
import type { ZoneDnsProvisionResult, ZoneDnsReport } from "@/lib/domain-dns";
import { strategiesFor, STRATEGY_META, type ExposureStrategy } from "@/lib/domain-strategies";
import { ENVIRONMENT_CHOICES, ENVIRONMENT_META } from "../../apps/servers/environment-meta";
import {
    checkZoneDnsAction,
    domainSetupStateAction,
    provisionZoneDnsAction,
    saveDomainSetupAction,
    type DomainSetupState
} from "./setup-actions";

/** A zone row as the wizard edits it (the saved shape, plus a key for React). */
interface ZoneRow {
    label: string;
    scope: "polaris" | "deploy";
    primary: boolean;
}

const STEPS = ["Server", "Exposure", "Domain", "DNS"];

export function DomainSetupWizard({ onSaved }: { onSaved?: () => void }) {
    const [state, setState] = useState<DomainSetupState | null>(null);
    const [step, setStep] = useState(0);
    const [environment, setEnvironment] = useState<ServerEnvironment>("unknown");
    const [strategy, setStrategy] = useState<ExposureStrategy>("free-subdomain");
    const [baseDomain, setBaseDomain] = useState("");
    const [zones, setZones] = useState<ZoneRow[]>([]);
    const [duckSub, setDuckSub] = useState("");
    const [duckToken, setDuckToken] = useState("");
    const [useForDashboard, setUseForDashboard] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void domainSetupStateAction().then((next) => {
            setState(next);
            setEnvironment(next.environment.environment);
            setBaseDomain(next.zones.baseDomain);
            setZones(next.zones.zones.map((zone) => ({ ...zone })));
            setDuckSub(next.domains.duckdnsSubdomain);
            setStrategy(strategiesFor(next.environment.environment).recommended);
        });
    }, []);

    if (!state) {
        return (
            <Card>
                <CardBody className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Reading your setup...
                </CardBody>
            </Card>
        );
    }

    const choice = strategiesFor(environment);

    function pickEnvironment(next: ServerEnvironment) {
        setEnvironment(next);
        // The recommendation is per environment, so a changed answer re-picks it -
        // otherwise step 2 would keep a choice that no longer fits the server.
        setStrategy(strategiesFor(next).recommended);
    }

    async function save() {
        setBusy(true);
        setError(null);
        const result = await saveDomainSetupAction({
            environment,
            strategy,
            baseDomain,
            zones,
            duckdnsSubdomain: duckSub,
            duckdnsToken: duckToken,
            useForDashboard
        });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setState(result.state);
        setZones(result.state.zones.zones.map((zone) => ({ ...zone })));
        setDuckToken("");
        setStep(3);
        onSaved?.();
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <Wand2 className="size-4 text-primary" /> Guided setup
                    </CardTitle>
                    <div className="flex items-center gap-1.5">
                        {STEPS.map((title, index) => (
                            <span
                                key={title}
                                className={`h-1.5 w-6 rounded-full ${index <= step ? "bg-primary" : "bg-border"}`}
                                title={title}
                            />
                        ))}
                    </div>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                {step === 0 && (
                    <EnvironmentStep
                        selected={environment}
                        detected={state.environment.detected}
                        onSelect={pickEnvironment}
                    />
                )}

                {step === 1 && (
                    <StrategyStep
                        choice={choice}
                        selected={strategy}
                        cloudflareConnected={state.cloudflareConnected}
                        onSelect={setStrategy}
                    />
                )}

                {step === 2 && (
                    <DomainStep
                        strategy={strategy}
                        baseDomain={baseDomain}
                        zones={zones}
                        duckSub={duckSub}
                        duckToken={duckToken}
                        hasDuckToken={state.domains.hasDuckdnsToken}
                        useForDashboard={useForDashboard}
                        onBaseDomain={setBaseDomain}
                        onZones={setZones}
                        onDuckSub={setDuckSub}
                        onDuckToken={setDuckToken}
                        onUseForDashboard={setUseForDashboard}
                    />
                )}

                {step === 3 && <DnsStep state={state} publicIp={state.network.publicIp} />}

                {error && (
                    <p className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {error}
                    </p>
                )}

                <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setStep((current) => Math.max(0, current - 1))}
                        disabled={step === 0 || busy}
                    >
                        <ChevronLeft className="size-4" /> Back
                    </Button>
                    {step < 2 && (
                        <Button size="sm" onClick={() => setStep((current) => current + 1)}>
                            Continue
                        </Button>
                    )}
                    {step === 2 && (
                        <Button size="sm" onClick={save} disabled={busy}>
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            {busy ? "Saving..." : "Save and continue"}
                        </Button>
                    )}
                    {step === 3 && (
                        <span className="flex items-center gap-1.5 text-sm text-success">
                            <CheckCircle2 className="size-4" /> Setup saved.
                        </span>
                    )}
                </div>
            </CardBody>
        </Card>
    );
}

function EnvironmentStep({
    selected,
    detected,
    onSelect
}: {
    selected: ServerEnvironment;
    detected: ServerEnvironment;
    onSelect: (next: ServerEnvironment) => void;
}) {
    return (
        <div className="flex flex-col gap-3">
            <StepTitle title="Where does this server run?" hint="It decides which ways of reaching it can work at all." />
            <div className="grid gap-2 sm:grid-cols-2">
                {ENVIRONMENT_CHOICES.map((option) => {
                    const meta = ENVIRONMENT_META[option];
                    return (
                        <button
                            key={option}
                            type="button"
                            onClick={() => onSelect(option)}
                            className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors ${
                                selected === option ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/40"
                            }`}
                        >
                            <span className="flex items-center gap-2 text-sm font-medium">
                                {meta.label}
                                {detected === option && <Badge variant="neutral">Detected</Badge>}
                            </span>
                            <span className="text-xs text-muted-foreground">{meta.summary}</span>
                        </button>
                    );
                })}
            </div>
            <p className="rounded-md border border-border/60 bg-surface/40 px-3 py-2 text-xs text-muted-foreground">
                {ENVIRONMENT_META[selected].routing}
            </p>
        </div>
    );
}

function StrategyStep({
    choice,
    selected,
    cloudflareConnected,
    onSelect
}: {
    choice: ReturnType<typeof strategiesFor>;
    selected: ExposureStrategy;
    cloudflareConnected: boolean;
    onSelect: (next: ExposureStrategy) => void;
}) {
    return (
        <div className="flex flex-col gap-3">
            <StepTitle
                title="How should services be reachable?"
                hint="Ordered by what costs least and depends on the fewest others."
            />
            <div className="flex flex-col gap-2">
                {choice.options.map((option) => {
                    const active = selected === option.id;
                    return (
                        <button
                            key={option.id}
                            type="button"
                            disabled={!option.available}
                            onClick={() => onSelect(option.id)}
                            className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors ${
                                active ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/40"
                            } ${option.available ? "" : "cursor-not-allowed opacity-50"}`}
                        >
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                {option.meta.label}
                                {option.id === choice.recommended && (
                                    <Badge variant="success">
                                        <Sparkles className="size-3" /> Recommended
                                    </Badge>
                                )}
                                {option.meta.wildcard && <Badge variant="neutral">Wildcard</Badge>}
                                {option.id === "cloudflare-tunnel" && cloudflareConnected && (
                                    <Badge variant="neutral">Token connected</Badge>
                                )}
                            </span>
                            <span className="text-xs text-muted-foreground">{option.meta.summary}</span>
                            <span className="text-xs text-muted-foreground">Depends on: {option.meta.dependency}</span>
                            {option.meta.requires.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                    Needs: {option.meta.requires.join(" - ")}
                                </span>
                            )}
                            {option.note && (
                                <span className={`text-xs ${option.available ? "text-primary" : "text-warning"}`}>
                                    {option.note}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function DomainStep({
    strategy,
    baseDomain,
    zones,
    duckSub,
    duckToken,
    hasDuckToken,
    useForDashboard,
    onBaseDomain,
    onZones,
    onDuckSub,
    onDuckToken,
    onUseForDashboard
}: {
    strategy: ExposureStrategy;
    baseDomain: string;
    zones: ZoneRow[];
    duckSub: string;
    duckToken: string;
    hasDuckToken: boolean;
    useForDashboard: boolean;
    onBaseDomain: (next: string) => void;
    onZones: (next: ZoneRow[]) => void;
    onDuckSub: (next: string) => void;
    onDuckToken: (next: string) => void;
    onUseForDashboard: (next: boolean) => void;
}) {
    const meta = STRATEGY_META[strategy];
    const effectiveBase = strategy === "duckdns" ? (duckSub ? `${duckSub}.duckdns.org` : "") : baseDomain.trim();

    function updateZone(index: number, patch: Partial<ZoneRow>) {
        onZones(zones.map((zone, position) => (position === index ? { ...zone, ...patch } : zone)));
    }

    function makePrimary(index: number) {
        const scope = zones[index]?.scope;
        if (!scope) return;
        onZones(zones.map((zone, position) => (zone.scope === scope ? { ...zone, primary: position === index } : zone)));
    }

    // Only a wildcard strategy has zones to lay out. A tunnel publishes each service
    // itself, so the domain lives with the tunnel's own credentials under Integrations
    // - asking for DNS records here would be asking for records that must not exist.
    if (!meta.wildcard) {
        return (
            <div className="flex flex-col gap-3">
                <StepTitle
                    title={meta.needsDomain ? "Set this up under Integrations" : "Nothing to configure"}
                    hint={meta.needsDomain ? "The tunnel publishes each service itself." : "This option needs no domain and no DNS."}
                />
                <p className="rounded-md border border-border/60 bg-surface/40 px-3 py-2 text-xs text-muted-foreground">
                    {meta.summary}
                </p>
                {meta.needsDomain ? (
                    <a href="/integrations" className="w-fit text-xs text-primary hover:underline">
                        Open Integrations
                    </a>
                ) : (
                    <p className="text-xs text-muted-foreground">You can come back and point a domain here at any time.</p>
                )}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <StepTitle
                title="Domain and zones"
                hint="A zone is one wildcard record. Everything Polaris mints lives under it, so DNS is a one-time job."
            />

            {strategy === "duckdns" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                        DuckDNS subdomain
                        <Input value={duckSub} onChange={(event) => onDuckSub(event.target.value)} placeholder="mypolaris" autoComplete="off" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Token
                        <Input
                            type="password"
                            value={duckToken}
                            onChange={(event) => onDuckToken(event.target.value)}
                            placeholder={hasDuckToken ? "Saved - enter a new token to replace it" : "DuckDNS token"}
                            autoComplete="off"
                        />
                    </label>
                </div>
            ) : (
                <label className="flex flex-col gap-1 text-sm">
                    Base domain
                    <Input
                        value={baseDomain}
                        onChange={(event) => onBaseDomain(event.target.value)}
                        placeholder="example.com"
                        autoComplete="off"
                    />
                    <span className="text-xs text-muted-foreground">
                        Any domain or subdomain you control - example.com, plr.com, or plr.example.com.
                    </span>
                </label>
            )}

            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Zones</span>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onZones([...zones, { label: "", scope: "deploy", primary: false }])}
                    >
                        <Plus className="size-4" /> Add zone
                    </Button>
                </div>
                {zones.map((zone, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2">
                        <Input
                            value={zone.label}
                            onChange={(event) => updateZone(index, { label: event.target.value })}
                            placeholder="plr"
                            autoComplete="off"
                            className="w-28"
                        />
                        <Select
                            value={zone.scope}
                            onValueChange={(value) => updateZone(index, { scope: value as ZoneRow["scope"] })}
                            options={[
                                { value: "polaris", label: "Polaris itself" },
                                { value: "deploy", label: "Deployed services" }
                            ]}
                            className="w-44"
                        />
                        <code className="flex-1 truncate text-xs text-muted-foreground">
                            {effectiveBase ? `*.${zone.label ? `${zone.label}.` : ""}${effectiveBase}` : "Enter a domain above"}
                        </code>
                        {zone.primary ? (
                            <Badge variant="neutral">Default</Badge>
                        ) : (
                            <Button size="sm" variant="ghost" onClick={() => makePrimary(index)}>
                                Make default
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onZones(zones.filter((_, position) => position !== index))}
                            aria-label="Remove zone"
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                ))}
                <p className="text-xs text-muted-foreground">
                    Leave a label empty to use the base domain itself. New services get a name in the default deploy zone.
                </p>
            </div>

            {/* Only offered while there is a Polaris zone to move onto: with the zone
                removed the choice could never be carried out, and a checkbox that does
                nothing is worse than no checkbox. */}
            {effectiveBase && zones.some((zone) => zone.scope === "polaris") && (
                <div className="flex flex-col gap-1">
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                            checked={useForDashboard}
                            onChange={(event) => onUseForDashboard(event.target.checked)}
                        />
                        Use the Polaris zone for the dashboard too
                    </label>
                    <span className="text-xs text-muted-foreground">
                        Applied once the zone is seen resolving to this server, so no link breaks in the meantime.
                    </span>
                </div>
            )}
        </div>
    );
}

function DnsStep({ state, publicIp }: { state: DomainSetupState; publicIp: string | null }) {
    const [report, setReport] = useState<ZoneDnsReport | null>(null);
    const [conflicts, setConflicts] = useState<ZoneDnsProvisionResult["conflicts"]>([]);
    const [busy, setBusy] = useState<"check" | "create" | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    async function check() {
        setBusy("check");
        setMessage(null);
        try {
            setReport(await checkZoneDnsAction());
        } catch (caught) {
            // Without this the buttons stay disabled forever on any failure, leaving
            // the operator on a dead final step with nothing said.
            setMessage(caught instanceof Error ? caught.message : "Could not check the DNS records");
        } finally {
            setBusy(null);
        }
    }

    // `overwrite` is only ever true on the second press, after the conflicting records
    // below have been shown: repointing a name the operator already uses - the apex of
    // their domain, when a zone has an empty label - takes whatever is there offline.
    async function create(overwrite = false) {
        setBusy("create");
        setMessage(null);
        const result = await provisionZoneDnsAction({ overwrite }).catch((caught: unknown) => ({
            created: [],
            replaced: [],
            unchanged: [],
            conflicts: [],
            failed: [],
            error: caught instanceof Error ? caught.message : "Could not create the DNS records"
        }));
        setBusy(null);
        if (result.error) {
            setMessage(result.error);
            return;
        }
        setConflicts(result.conflicts);
        // A run where every record was already right is the good outcome, not a failure:
        // counting only what changed would report "0 created, 0 repointed" and read like
        // the button did nothing.
        const parts = [
            ...(result.created.length > 0 ? [`${result.created.length} created`] : []),
            ...(result.replaced.length > 0 ? [`${result.replaced.length} repointed`] : []),
            ...(result.unchanged.length > 0 ? [`${result.unchanged.length} already correct`] : []),
            ...(result.conflicts.length > 0 ? [`${result.conflicts.length} left alone`] : []),
            ...(result.failed.length > 0 ? [`failed: ${result.failed.map((entry) => entry.name).join(", ")}`] : [])
        ];
        setMessage(parts.length > 0 ? `${parts.join(", ")}.` : "Nothing to do - the records are already in place.");
        await check();
    }

    // Checking is what records the zone as resolving here, and Polaris only hands out
    // links on a zone it has seen resolve - so it runs on its own instead of waiting
    // for a button, which the DuckDNS path below does not even show.
    useEffect(() => {
        if (state.records.length > 0) void check();
    }, [state.records.length]);

    // DuckDNS manages one record - the subdomain's IP - and answers for everything
    // under it, so listing per-zone A records would ask for records that cannot be
    // created (and "Create them on Cloudflare" would fail on a domain that is not
    // theirs). Polaris keeps that one record pointed here on its own.
    const duckdns = state.zones.baseDomain.endsWith(".duckdns.org");

    if (state.records.length === 0 || duckdns) {
        return (
            <div className="flex flex-col gap-3">
                <StepTitle title="Done" hint={duckdns ? "DuckDNS answers for every name under your subdomain." : "This setup needs no DNS records."} />
                <p className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-muted-foreground">
                    {duckdns
                        ? `Nothing to create: ${state.zones.baseDomain} already resolves every subdomain, and Polaris keeps it pointed at this server as your IP changes.`
                        : "Services get their hostname the moment they are deployed."}
                </p>
                {duckdns && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={check} disabled={busy !== null}>
                            <RefreshCw className={`size-4 ${busy === "check" ? "animate-spin" : ""}`} /> Check DNS
                        </Button>
                        {message && <span className="text-xs text-muted-foreground">{message}</span>}
                    </div>
                )}
                {duckdns && <ZoneResults report={report} />}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <StepTitle
                title="Create these DNS records"
                hint={publicIp ? `Point them at this server: ${publicIp}` : "Polaris could not detect this server's public IP."}
            />
            <div className="flex flex-col divide-y divide-border/60 rounded-md border border-border/60">
                {state.records.map((record) => (
                    <div key={record.wildcard} className="flex flex-col gap-1 p-2 text-xs">
                        <RecordRow name={record.host} ip={publicIp} />
                        <RecordRow name={record.wildcard} ip={publicIp} />
                    </div>
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={check} disabled={busy !== null}>
                    <RefreshCw className={`size-4 ${busy === "check" ? "animate-spin" : ""}`} /> Check DNS
                </Button>
                {state.cloudflareConnected && (
                    <Button size="sm" onClick={() => create()} disabled={busy !== null}>
                        <Globe className="size-4" /> Create them on Cloudflare
                    </Button>
                )}
            </div>

            {message && <p className="text-xs text-muted-foreground">{message}</p>}

            {conflicts.length > 0 && (
                <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
                    <span className="flex items-start gap-2 text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                        These records already exist and point somewhere else. Polaris left them alone - replacing one
                        takes whatever answers on it today offline.
                    </span>
                    <ul className="flex flex-col gap-0.5 pl-5 text-muted-foreground">
                        {conflicts.map((conflict) => (
                            <li key={conflict.name}>
                                <code>{conflict.name}</code> - {conflict.content || "unknown address"}
                            </li>
                        ))}
                    </ul>
                    <Button
                        size="sm"
                        variant="secondary"
                        className="w-fit"
                        onClick={() => create(true)}
                        disabled={busy !== null}
                    >
                        Point them at this server
                    </Button>
                </div>
            )}

            <ZoneResults report={report} />
        </div>
    );
}

/** What the last check saw for each zone - the proof the records are really there. */
function ZoneResults({ report }: { report: ZoneDnsReport | null }) {
    return (
        <>
            {report?.zones.map((zone) => (
                <p
                    key={zone.wildcard}
                    className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                        zone.ok ? "border-success/30 bg-success/5 text-muted-foreground" : "border-warning/30 bg-warning/5 text-muted-foreground"
                    }`}
                >
                    {zone.ok ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                    ) : (
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    )}
                    <span>
                        <code>{zone.wildcard}</code> - {zone.detail}
                    </span>
                </p>
            ))}
        </>
    );
}

function RecordRow({ name, ip }: { name: string; ip: string | null }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="flex items-center gap-2">
            <Badge variant="neutral">A</Badge>
            <code className="flex-1 truncate">{name}</code>
            <code className="text-muted-foreground">{ip ?? "your public IP"}</code>
            <button
                type="button"
                aria-label={`Copy ${name}`}
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                    void navigator.clipboard?.writeText(name);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                }}
            >
                {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </button>
        </div>
    );
}

function StepTitle({ title, hint }: { title: string; hint: string }) {
    return (
        <div className="flex flex-col gap-0.5">
            <h3 className="text-sm font-medium">{title}</h3>
            <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
    );
}
