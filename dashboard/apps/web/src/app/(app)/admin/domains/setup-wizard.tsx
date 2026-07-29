"use client";

/**
 * Guided domain setup. Four answers - where the server runs, how services should be
 * reachable, which domain and zones to use, and whether the DNS is actually there -
 * because each one changes what the next should even offer: a carrier-NAT line
 * cannot use a wildcard record, and a wildcard record makes tunnels unnecessary.
 *
 * The recommended option is always preselected, so finishing means pressing Continue.
 *
 * Three things keep the operator out of dead ends: the answers survive a reload (they
 * are kept locally until the setup is saved), reopening it lands on the domain that is
 * already configured rather than on the first question again, and the domain's real DNS
 * provider is looked up as it is typed - so the setup can create the records itself
 * where it can, and link straight to the right panel where it cannot.
 */

import { useEffect, useState } from "react";
import {
    Check,
    CheckCircle2,
    ChevronLeft,
    Copy,
    ExternalLink,
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
import type { DnsProviderInfo } from "@/lib/dns-provider";
import type { ZoneDnsProvisionResult, ZoneDnsReport } from "@/lib/domain-dns";
import { CLOUDFLARE_DNS_TOKEN_URL } from "@/lib/integrations/cloudflare-token-link";
import { strategiesFor, STRATEGY_META, type ExposureStrategy } from "@/lib/domain-strategies";
import { ENVIRONMENT_CHOICES, ENVIRONMENT_META } from "../../apps/servers/environment-meta";
import { connectCloudflareAccountAction } from "../../integrations/actions";
import { clearSetupDraft, isUntouched, readSetupDraft, savedAnswers, writeSetupDraft } from "./setup-draft";
import {
    checkZoneDnsAction,
    detectDnsProviderAction,
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

/**
 * Every fresh read of the server's state is reported outwards, because the page around
 * this cannot see what the setup changed: it writes the DuckDNS pair, can move the
 * dashboard onto the Polaris zone, and creating the records marks that zone as
 * resolving - which promotes the exposure mode. Saving is not the only moment any of
 * that happens, so a "saved" signal would leave the panels below showing the state from
 * before the records existed.
 */
export function DomainSetupWizard({ onState }: { onState?: (state: DomainSetupState) => void }) {
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
    const [loadError, setLoadError] = useState<string | null>(null);
    const [resumed, setResumed] = useState(false);
    const [provider, setProvider] = useState<DnsProviderInfo | null>(null);

    // The domain the setup would actually use, which is what DNS is looked up for and
    // what the zone previews are built from - a DuckDNS subdomain is a domain too.
    const effectiveBase =
        strategy === "duckdns" ? duckSub.trim() && `${duckSub.trim()}.duckdns.org` : baseDomain.trim();

    // Every fresh read is handed on, not just the one after a save: opening the setup
    // re-checks the DNS, and a zone that has started answering moves the dashboard onto
    // it - so the domain settings can change without the operator pressing anything.
    function applyState(next: DomainSetupState) {
        setState(next);
        onState?.(next);
    }

    /**
     * The first read, which everything below renders from. It is not a cheap one - it
     * re-checks the zone's DNS and looks up the public IP - so it can fail, and a failure
     * that only stopped the spinner would leave the operator on "Reading your setup..."
     * for good with nothing to press.
     */
    function load() {
        setLoadError(null);
        void domainSetupStateAction()
            .then((next) => {
                applyState(next);
                const draft = readSetupDraft();
                const answers = draft ?? savedAnswers(next);
                setEnvironment(answers.environment);
                setStrategy(answers.strategy);
                setBaseDomain(answers.baseDomain);
                setZones(answers.zones.map((zone) => ({ ...zone })));
                setDuckSub(answers.duckSub);
                setUseForDashboard(answers.useForDashboard);
                if (draft) {
                    setStep(draft.step);
                    setResumed(true);
                    return;
                }
                // Nothing unfinished, but a layout already saved: what that domain's DNS
                // is doing is the useful view, not the first question over again.
                if (next.zones.baseDomain) setStep(3);
            })
            .catch((caught: unknown) => {
                setLoadError(caught instanceof Error ? caught.message : "Could not read your setup");
            });
    }

    useEffect(() => {
        load();
    }, []);

    // Kept only while the answers are unsaved and say something the server does not
    // already hold. Past the save the server holds them, and a draft that merely repeats
    // what is configured would resume the operator into a form they had opened to look
    // at - instead of onto the state of the domain they came to check.
    useEffect(() => {
        if (!state || step > 2) return;
        const draft = { step, environment, strategy, baseDomain, zones, duckSub, useForDashboard };
        if (isUntouched(draft, state)) {
            clearSetupDraft();
            return;
        }
        writeSetupDraft(draft);
    }, [state, step, environment, strategy, baseDomain, zones, duckSub, useForDashboard]);

    // Who answers DNS for the typed domain. A hint, never a gate: it runs after a pause
    // so a half-typed name does not fire a lookup per keystroke, and a late answer for a
    // domain that has since changed is dropped rather than shown against the new one.
    useEffect(() => {
        setProvider(null);
        if (!STRATEGY_META[strategy].wildcard || !effectiveBase.includes(".")) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            void detectDnsProviderAction({ domain: effectiveBase })
                .then((next) => {
                    if (!cancelled) setProvider(next);
                })
                // The action answers null for a domain it cannot resolve, but the call
                // itself can still fail - an expired session, a dropped connection -
                // and this fires on every pause in typing. No hint is the right outcome
                // there: a lookup that never ran says nothing about the domain, and null
                // keeps the Cloudflare offer open.
                .catch(() => {
                    if (!cancelled) setProvider(null);
                });
        }, 600);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [effectiveBase, strategy]);

    if (!state) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2 text-sm text-muted-foreground">
                    {loadError ? (
                        <>
                            <p className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {loadError}
                            </p>
                            <Button size="sm" variant="secondary" className="w-fit" onClick={load}>
                                <RefreshCw className="size-4" /> Try again
                            </Button>
                        </>
                    ) : (
                        <span className="flex items-center gap-2">
                            <Loader2 className="size-4 animate-spin" /> Reading your setup...
                        </span>
                    )}
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

    /** Drop the resumed answers and start again from what is actually saved. */
    function startOver() {
        if (!state) return;
        const answers = savedAnswers(state);
        clearSetupDraft();
        setResumed(false);
        setEnvironment(answers.environment);
        setStrategy(answers.strategy);
        setBaseDomain(answers.baseDomain);
        setZones(answers.zones);
        setDuckSub(answers.duckSub);
        setUseForDashboard(answers.useForDashboard);
        setDuckToken("");
        setError(null);
        setStep(0);
    }

    /**
     * Re-read what the server holds, after something the wizard did changed it. It never
     * rejects: this runs after the write it follows has already succeeded, and letting it
     * throw would unwind the caller - leaving the button that started it spinning over a
     * token that is, in fact, connected.
     */
    async function refresh() {
        try {
            applyState(await domainSetupStateAction());
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not re-read your setup");
        }
    }

    async function save() {
        setBusy(true);
        setError(null);
        // The action reports what it refused as `error`, but it can still reject outright
        // on an expired session or a dropped connection - and a Save button left spinning
        // and disabled is a dead end that only a reload gets out of.
        const result = await saveDomainSetupAction({
            environment,
            strategy,
            baseDomain,
            zones,
            duckdnsSubdomain: duckSub,
            duckdnsToken: duckToken,
            useForDashboard
        }).catch((caught: unknown) => ({
            state: null,
            error: caught instanceof Error ? caught.message : "Could not save the domain setup"
        }));
        setBusy(false);
        if (!result.state || result.error) {
            setError(result.error ?? "Could not save the domain setup");
            return;
        }
        applyState(result.state);
        setZones(result.state.zones.zones.map((zone) => ({ ...zone })));
        // The server normalizes what it stored - a pasted URL becomes a bare domain, a
        // DuckDNS name loses its suffix - so the answers on screen are put back to the
        // ones it holds. Left as typed, they read as unsaved changes and step 2 would
        // resume from a draft the operator never made.
        setBaseDomain(result.state.zones.baseDomain);
        setDuckSub(result.state.domains.duckdnsSubdomain);
        setDuckToken("");
        // The answers now live on the server, so the local copy has nothing left to
        // protect and would only compete with what the operator changes from here.
        clearSetupDraft();
        setResumed(false);
        setStep(3);
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <Wand2 className="size-4 text-primary" /> Guided setup
                    </CardTitle>
                    <div className="flex items-center gap-1.5">
                        {/* The domain in use, on every step: the answer to "what is this
                            box on" was two steps deep before, so reopening the setup read
                            as though the domain had never been saved. */}
                        {state.zones.baseDomain && <Badge variant="neutral">{state.zones.baseDomain}</Badge>}
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
                {resumed && step <= 2 && (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-surface/40 px-3 py-2 text-xs text-muted-foreground">
                        <span>Picked up where you left off.</span>
                        <button
                            type="button"
                            onClick={startOver}
                            className="font-medium text-foreground underline-offset-2 hover:underline"
                        >
                            Start over
                        </button>
                    </div>
                )}

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
                        tunnelReady={state.cloudflareTunnelReady}
                        onSelect={setStrategy}
                    />
                )}

                {step === 2 && (
                    <DomainStep
                        strategy={strategy}
                        baseDomain={baseDomain}
                        effectiveBase={effectiveBase}
                        zones={zones}
                        duckSub={duckSub}
                        duckToken={duckToken}
                        hasDuckToken={state.domains.hasDuckdnsToken}
                        useForDashboard={useForDashboard}
                        provider={provider}
                        cloudflareConnected={state.cloudflareConnected}
                        onBaseDomain={setBaseDomain}
                        onZones={setZones}
                        onDuckSub={setDuckSub}
                        onDuckToken={setDuckToken}
                        onUseForDashboard={setUseForDashboard}
                    />
                )}

                {step === 3 && (
                    <DnsStep
                        state={state}
                        publicIp={state.network.publicIp}
                        provider={provider}
                        onRefresh={refresh}
                    />
                )}

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
    tunnelReady,
    onSelect
}: {
    choice: ReturnType<typeof strategiesFor>;
    selected: ExposureStrategy;
    /** A token that reaches an account. A DNS-only one cannot create a tunnel. */
    tunnelReady: boolean;
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
                                {option.id === "cloudflare-tunnel" && tunnelReady && (
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
    effectiveBase,
    zones,
    duckSub,
    duckToken,
    hasDuckToken,
    useForDashboard,
    provider,
    cloudflareConnected,
    onBaseDomain,
    onZones,
    onDuckSub,
    onDuckToken,
    onUseForDashboard
}: {
    strategy: ExposureStrategy;
    baseDomain: string;
    effectiveBase: string;
    zones: ZoneRow[];
    duckSub: string;
    duckToken: string;
    hasDuckToken: boolean;
    useForDashboard: boolean;
    provider: DnsProviderInfo | null;
    cloudflareConnected: boolean;
    onBaseDomain: (next: string) => void;
    onZones: (next: ZoneRow[]) => void;
    onDuckSub: (next: string) => void;
    onDuckToken: (next: string) => void;
    onUseForDashboard: (next: boolean) => void;
}) {
    const meta = STRATEGY_META[strategy];

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

            {provider && <ProviderHint provider={provider} cloudflareConnected={cloudflareConnected} />}

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

function DnsStep({
    state,
    publicIp,
    provider,
    onRefresh
}: {
    state: DomainSetupState;
    publicIp: string | null;
    provider: DnsProviderInfo | null;
    onRefresh: () => Promise<void>;
}) {
    const [report, setReport] = useState<ZoneDnsReport | null>(null);
    const [conflicts, setConflicts] = useState<ZoneDnsProvisionResult["conflicts"]>([]);
    const [busy, setBusy] = useState<"check" | "create" | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [connecting, setConnecting] = useState(false);

    /** The check itself, without the button state: creating the records runs it too. */
    async function runCheck() {
        try {
            setReport(await checkZoneDnsAction());
        } catch (caught) {
            // Without this the buttons stay disabled forever on any failure, leaving
            // the operator on a dead final step with nothing said.
            setMessage(caught instanceof Error ? caught.message : "Could not check the DNS records");
        }
    }

    async function check() {
        setBusy("check");
        setMessage(null);
        try {
            await runCheck();
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
        // Held across the check and the re-read below, not just the write: those are DNS
        // resolution and an HTTP probe per zone, seconds in which a live button would
        // take a second press as another provision run.
        try {
            const result = await provisionZoneDnsAction({ overwrite }).catch((caught: unknown) => ({
                created: [],
                replaced: [],
                unchanged: [],
                conflicts: [],
                failed: [],
                error: caught instanceof Error ? caught.message : "Could not create the DNS records"
            }));
            if (result.error) {
                setMessage(result.error);
                return;
            }
            setConflicts(result.conflicts);
            // A run where every record was already right is the good outcome, not a
            // failure: counting only what changed would report "0 created, 0 repointed"
            // and read like the button did nothing.
            const parts = [
                ...(result.created.length > 0 ? [`${result.created.length} created`] : []),
                ...(result.replaced.length > 0 ? [`${result.replaced.length} repointed`] : []),
                ...(result.unchanged.length > 0 ? [`${result.unchanged.length} already correct`] : []),
                ...(result.conflicts.length > 0 ? [`${result.conflicts.length} left alone`] : []),
                ...(result.failed.length > 0 ? [`failed: ${result.failed.map((entry) => entry.name).join(", ")}`] : [])
            ];
            setMessage(parts.length > 0 ? `${parts.join(", ")}.` : "Nothing to do - the records are already in place.");
            await runCheck();
            // The check above is where a zone is first seen answering, which is what
            // moves the dashboard onto it - so what the server holds has just changed
            // under the rest of the page, and only a re-read tells it.
            await onRefresh();
        } finally {
            setBusy(null);
        }
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

    // Automation is only offered where it can work: a token writes into the Cloudflare
    // zone, so on a domain served by someone else the button could only ever fail, and
    // the hint above already points at the panel that can. An undetected provider keeps
    // the offer - a lookup that failed is not evidence the domain is not on Cloudflare.
    const cloudflarePossible = provider === null || provider.id === "cloudflare";
    // Proven, not assumed: a zone counts as done only once the check has seen both of
    // its names answer with this server's address.
    const done = new Map(report?.zones.map((zone) => [zone.wildcard, zone.ok]) ?? []);
    const verified = report !== null && report.zones.length > 0 && report.zones.every((zone) => zone.ok);

    return (
        <div className="flex flex-col gap-3">
            <StepTitle
                title={verified ? "The DNS is in place" : "Create these DNS records"}
                hint={
                    verified
                        ? `${state.zones.baseDomain} points at this server, so every service gets a hostname under it.`
                        : publicIp
                          ? `Point them at this server: ${publicIp}`
                          : "Polaris could not detect this server's public IP."
                }
            />
            <div className="flex flex-col divide-y divide-border/60 rounded-md border border-border/60">
                {state.records.map((record) => (
                    <div key={record.wildcard} className="flex flex-col gap-1 p-2 text-xs">
                        <RecordRow name={record.host} ip={publicIp} done={done.get(record.wildcard) === true} />
                        <RecordRow name={record.wildcard} ip={publicIp} done={done.get(record.wildcard) === true} />
                    </div>
                ))}
            </div>

            {provider && <ProviderHint provider={provider} cloudflareConnected={state.cloudflareConnected} />}

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={check} disabled={busy !== null}>
                    <RefreshCw className={`size-4 ${busy === "check" ? "animate-spin" : ""}`} /> Check DNS
                </Button>
                {/* Withdrawn once every zone answers with this server's address: there is
                    nothing left to create, and a live button there invites a second run
                    whose only possible outcome is "already correct". Any zone still
                    pending brings it back, since that one does have records to write. */}
                {cloudflarePossible &&
                    !verified &&
                    (state.cloudflareConnected ? (
                        <Button size="sm" onClick={() => create()} disabled={busy !== null}>
                            <Globe className="size-4" /> Create them on Cloudflare
                        </Button>
                    ) : (
                        <Button
                            size="sm"
                            onClick={() => setConnecting(true)}
                            disabled={busy !== null || connecting}
                        >
                            <Globe className="size-4" /> Create them for me
                        </Button>
                    ))}
            </div>

            {/* The token is asked for here rather than under Integrations: it is the
                same token either way, and a detour into another page mid-setup is
                where operators put the domain down and do not come back. */}
            {connecting && !state.cloudflareConnected && (
                <CloudflareConnect
                    zone={provider?.zone ?? state.zones.baseDomain}
                    onConnected={async () => {
                        // The panel disappears on its own once the refreshed state says
                        // the token is connected, so the records are created straight
                        // away rather than behind a second button.
                        await onRefresh();
                        await create();
                    }}
                />
            )}

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

/**
 * Connect a Cloudflare API token without leaving the setup, then hand back so the
 * records can be written. The link opens Cloudflare's own token form with the two
 * permissions Polaris needs already ticked, so the operator creates it, pastes it
 * back, and never picks anything out of a permission tree.
 *
 * The token is only ever sent to the server, which stores it encrypted; nothing here
 * keeps a copy once it has been accepted.
 */
function CloudflareConnect({ zone, onConnected }: { zone: string; onConnected: () => Promise<void> }) {
    const [token, setToken] = useState("");
    const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
    const [accountId, setAccountId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function connect() {
        setBusy(true);
        setError(null);
        const result = await connectCloudflareAccountAction({
            token,
            // The setup only ever needs to write records, and the link beside this
            // field asks Cloudflare for exactly that - so connecting it as anything
            // wider would reject the token it just told the operator to create.
            scope: "dns",
            ...(accountId ? { accountId } : {})
        }).catch((caught: unknown) => ({
            error: caught instanceof Error ? caught.message : "Could not connect the Cloudflare token",
            connected: false,
            accounts: []
        }));
        if (result.error) {
            setError(result.error);
            setBusy(false);
            return;
        }
        if (!result.connected) {
            // The token reaches several accounts and Cloudflare will not pick one for
            // us: ask which, then connect again with the answer.
            const options = result.accounts ?? [];
            setAccounts(options);
            if (options[0]) setAccountId(options[0].id);
            setBusy(false);
            return;
        }
        setToken("");
        try {
            // The token is stored by this point, so whatever happens next must not leave
            // the button spinning: on a reload the account is connected and nothing on
            // screen would explain why pressing it did nothing.
            await onConnected();
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
                Polaris writes the records through Cloudflare&apos;s API, which needs a token. The link opens
                Cloudflare with the two permissions it needs already selected - create the token, paste it here,
                and {zone ? <code>{zone}</code> : "your domain"} is set up without touching a DNS panel.
            </span>
            <a
                href={CLOUDFLARE_DNS_TOKEN_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex w-fit items-center gap-1 font-medium text-primary hover:underline"
            >
                Create the token on Cloudflare <ExternalLink className="size-3" />
            </a>
            <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste your Cloudflare API token"
                autoComplete="off"
            />
            {accounts.length > 0 && (
                <label className="flex flex-col gap-1 text-muted-foreground">
                    The token reaches several accounts - pick the one holding this domain
                    <Select
                        value={accountId}
                        onValueChange={setAccountId}
                        options={accounts.map((account) => ({ value: account.id, label: account.name }))}
                    />
                </label>
            )}
            {error && <p className="text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button size="sm" onClick={connect} disabled={busy || !token.trim()}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    {accounts.length > 0 ? "Use this account" : "Connect and create the records"}
                </Button>
            </div>
        </div>
    );
}

/**
 * What the domain's own DNS provider means for this setup. Three outcomes, in order of
 * how little work is left for the operator: Polaris can create the records itself,
 * Polaris could once a token is connected, or here is the panel where they are created.
 * A provider Polaris does not recognize still names its nameservers - that is usually
 * enough for the operator to recognize who they are with.
 */
function ProviderHint({ provider, cloudflareConnected }: { provider: DnsProviderInfo; cloudflareConnected: boolean }) {
    const automated = provider.automatable && cloudflareConnected;
    return (
        <div
            className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${
                automated ? "border-success/30 bg-success/5" : "border-border/60 bg-surface/40"
            }`}
        >
            <span className="flex items-center gap-2 text-muted-foreground">
                <Globe className={`size-3.5 shrink-0 ${automated ? "text-success" : "text-muted-foreground"}`} />
                {provider.label ? (
                    <span>
                        <b className="font-medium text-foreground">{provider.label}</b> answers for{" "}
                        <code>{provider.zone}</code>
                        {automated
                            ? " and your token is connected - Polaris creates the records for you."
                            : provider.automatable
                              ? " - Polaris can create the records for you on the last step, with no DNS panel at all."
                              : "."}
                    </span>
                ) : (
                    <span>
                        <code>{provider.zone}</code> is served by <code>{provider.nameservers[0]}</code>. Create the
                        records where you manage it.
                    </span>
                )}
            </span>
            {provider.url && (
                <a
                    href={provider.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1 font-medium text-primary hover:underline"
                >
                    Open {provider.label} <ExternalLink className="size-3" />
                </a>
            )}
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

/** One record the zone needs. `done` means the check saw this zone's names answer
 *  with this server's address, so the record exists and is pointed correctly. */
function RecordRow({ name, ip, done }: { name: string; ip: string | null; done: boolean }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="flex items-center gap-2">
            <Badge variant={done ? "success" : "neutral"}>A</Badge>
            <code className="flex-1 truncate">{name}</code>
            <code className="text-muted-foreground">{ip ?? "your public IP"}</code>
            {done && (
                <span title="Answering with this server's address" aria-label="Created" role="img">
                    <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                </span>
            )}
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
