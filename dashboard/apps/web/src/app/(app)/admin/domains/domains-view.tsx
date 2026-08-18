"use client";

/**
 * Domains admin panel. The guided setup owns the decisions - where the box runs, how
 * it is exposed, which domain and zones - and everything else on the page is either a
 * separate question it does not answer (the dashboard's own address, the sharing
 * domain, the full list of names it answers on, trusting the LAN certificate) or the
 * manual controls behind it.
 *
 * Those manual controls sit under Advanced rather than beside the setup, because they
 * are the same settings a second time: an exposure mode the setup already stored and a
 * DuckDNS pair it already asked for, each with its own Save. Two panels editing one
 * setting is the fastest way to leave an operator unsure which one won.
 *
 * The panel reads its own data once the page is on screen, and every card is drawn
 * before that read lands: the titles, the certificate card and the Advanced toggle do
 * not depend on it, and the ones that do hold a skeleton shaped like the fields that
 * are coming. What this replaced was rendered on the server, so the navigation itself
 * waited on a tunnel daemon and a probe of every configured hostname before the
 * browser was handed anything at all - the previous page sat there, and Domains looked
 * like a link that did nothing.
 */

import { readJson } from "@/lib/read-json";
import { CallPortsCard } from "./call-ports-card";
import { GamePortsCard } from "./game-ports-card";
import { DomainSetupWizard } from "./setup-wizard";
import { AddressList } from "@/components/address-list";
import { OwnerDomainsCard } from "./owner-domains-card";
import type { DomainConfig } from "@/lib/domain-service";
import type { CheckedAddress } from "@/lib/address-health";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { DOMAINS_OVERVIEW_URL, type DomainsOverview } from "./overview";
import type { NetworkMode, NetworkStatus } from "@/lib/network-service";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { domainSuggestions, type DomainSuggestions } from "@/lib/domain-suggestions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";
import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Download,
    Globe,
    Link2,
    Loader2,
    Network,
    RefreshCw,
    ShieldCheck,
    TriangleAlert
} from "lucide-react";
import {
    clearDuckdnsTokenAction,
    deploymentAddressesAction,
    networkStatusAction,
    saveDomainsAction,
    saveExtraDomainsAction,
    saveNetworkConfigAction,
    syncDuckDnsAction
} from "./actions";

/** How stale a kept read may be and still be worth painting while the fresh one is
 *  on its way. Past a few minutes an address that has gone down since misleads
 *  more than a skeleton would. */
const MAX_AGE_MS = 5 * 60_000;

/** Where the kept read lives, namespaced like every other snapshot. */
const CACHE_KEY = "admin.domainsOverview";

/** What the guided setup owns of the panel's data, when it has reported. */
type SetupState = Pick<DomainsOverview, "config" | "zones">;

export function DomainsView() {
    const [overview, setOverview] = useState<DomainsOverview | null>(null);
    // Why there is nothing to draw, when that is the answer. Kept apart from the data
    // so a failed refresh does not blank what is already on screen, and shown rather
    // than swallowed: a skeleton that never resolves is a dead page with the reason
    // taken out.
    const [unread, setUnread] = useState<string | null>(null);
    const [advanced, setAdvanced] = useState(false);
    // Bumped on every read the wizard makes, not only after a save: creating the records
    // from the setup is what first proves the zone resolves, which promotes the exposure
    // mode - so the panel would otherwise keep reporting "lan" underneath a setup that
    // says the DNS is in place.
    const [setupNonce, setSetupNonce] = useState(0);
    // What the setup has said about the domains and the zone layout, if anything. It
    // re-checks the DNS and can move the dashboard onto a zone, so its answer is newer
    // than the one this read was given - and the two land in whichever order the
    // network decides, so the read defers to it rather than racing it.
    const fromSetup = useRef<SetupState | null>(null);

    /** Fold a change into what is on screen and into the kept copy, so a save shows
     *  at once and a revisit does not paint what it replaced. */
    const apply = useCallback((patch: Partial<DomainsOverview>) => {
        setOverview((current) => {
            if (!current) return current;
            const next = { ...current, ...patch };
            writeSnapshot(CACHE_KEY, next);
            return next;
        });
    }, []);

    const load = useCallback(async () => {
        const result = await readJson<DomainsOverview>(DOMAINS_OVERVIEW_URL);
        if (!result.ok) {
            setUnread(result.reason);
            return;
        }
        setUnread(null);
        const next = fromSetup.current ? { ...result.value, ...fromSetup.current } : result.value;
        writeSnapshot(CACHE_KEY, next);
        setOverview(next);
    }, []);

    useEffect(() => {
        // The kept copy first, from an effect rather than from the initial state: this
        // component is rendered on the server too, and seeding it from sessionStorage
        // during render would have the browser hydrate what the HTML does not contain.
        const kept = readSnapshot<DomainsOverview>(CACHE_KEY, MAX_AGE_MS);
        if (kept) setOverview(kept.value);
        void load();
    }, [load]);

    return (
        <div className="flex w-full flex-col gap-4">
            {unread && !overview ? (
                <Card>
                    <CardBody className="flex flex-col items-start gap-2">
                        <ErrorNote message={unread} />
                        <Button size="sm" variant="secondary" onClick={() => void load()}>
                            <RefreshCw className="size-4" /> Try again
                        </Button>
                    </CardBody>
                </Card>
            ) : null}

            <DomainSetupWizard
                onState={(next) => {
                    fromSetup.current = { config: next.domains, zones: next.zones };
                    apply(fromSetup.current);
                    setSetupNonce((nonce) => nonce + 1);
                }}
            />

            {overview ? (
                <AppDomains
                    config={overview.config}
                    suggestions={domainSuggestions(overview.zones)}
                    effectiveAppUrl={overview.effectiveAppUrl}
                    onSaved={(config) => apply({ config })}
                />
            ) : (
                <PendingCard
                    title={
                        <>
                            <Globe className="size-4 text-primary" /> Polaris&apos;s own addresses
                        </>
                    }
                >
                    <FieldSkeleton />
                    <FieldSkeleton />
                </PendingCard>
            )}

            {overview ? (
                <DashboardDomains
                    config={overview.config}
                    addresses={overview.addresses}
                    onConfig={(config) => apply({ config })}
                    onAddresses={(addresses) => apply({ addresses })}
                />
            ) : (
                <PendingCard
                    title={
                        <>
                            <Globe className="size-4 text-primary" /> Where Polaris answers
                        </>
                    }
                >
                    <AddressesSkeleton />
                    <div className="border-t border-border pt-4">
                        <FieldSkeleton />
                    </div>
                </PendingCard>
            )}

            <LocalCertificate />

            <div className="flex flex-col gap-4">
                <button
                    type="button"
                    onClick={() => setAdvanced((value) => !value)}
                    className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                    {advanced ? (
                        <ChevronDown className="size-3.5" />
                    ) : (
                        <ChevronRight className="size-3.5" />
                    )}
                    Advanced: exposure mode and DuckDNS
                </button>
                {advanced && (
                    <>
                        <NetworkExposure nonce={setupNonce} />
                        {overview ? (
                            <DuckDns
                                config={overview.config}
                                onConfig={(config) => apply({ config })}
                            />
                        ) : (
                            <PendingCard title="DuckDNS">
                                <FieldSkeleton />
                                <FieldSkeleton />
                            </PendingCard>
                        )}
                    </>
                )}
            </div>

            {/* The zone check above is finished once 80 and 443 arrive, and a game
                server answers on neither - so what it needs is asked for here
                rather than folded into advice that disappears when the website
                works. Renders nothing when no game server exists. */}
            <GamePortsCard />

            {/* Same reason again, for the other traffic 443 does not carry: a
                call's audio. Renders nothing when calls run through a server
                somebody else operates. */}
            <CallPortsCard />

            {/* Below the instance's own addresses, because it is a different
                decision: not what Polaris answers on, but what other people are
                allowed to point at it. */}
            {overview ? (
                <OwnerDomainsCard
                    policy={overview.ownerPolicy}
                    onSaved={(ownerPolicy) => apply({ ownerPolicy })}
                />
            ) : (
                <PendingCard title="Domains of their own">
                    <div className="flex flex-col gap-1.5">
                        <Skeleton className="h-3.5 w-full" />
                        <Skeleton className="h-3.5 w-4/5" />
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                        <Skeleton className="h-9 min-w-48 flex-1" />
                        <Skeleton className="h-9 w-32" />
                        <Skeleton className="h-9 w-16" />
                    </div>
                </PendingCard>
            )}
        </div>
    );
}

/**
 * A card whose chrome is on screen before its contents are.
 *
 * The title is the real one rather than a block: it does not depend on the read, and
 * a page an operator can already navigate by is the entire point of painting before
 * the data lands. Only what is genuinely waiting pulses, in the shape it will take.
 */
function PendingCard({ title, children }: { title: ReactNode; children: ReactNode }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">{title}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">{children}</CardBody>
        </Card>
    );
}

/** A labelled field's shape: the label, the box, and the line of help under it. */
function FieldSkeleton() {
    return (
        <div className="flex flex-col gap-1">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-4/5" />
        </div>
    );
}

/** The address list's shape: a URL, what kind of address it is, and its buttons.
 *  Three rows, which is what a deployment with a domain configured has. */
function AddressesSkeleton() {
    return (
        <div className="flex flex-col gap-1.5">
            {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-2">
                    <Skeleton className="h-4 w-56 max-w-[60%]" />
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="ml-auto h-6 w-6" />
                </div>
            ))}
        </div>
    );
}

/**
 * A field that follows the stored value until the operator edits it. The guided setup
 * rewrites these same settings while the page is open - it moves the dashboard onto the
 * Polaris zone the moment that zone answers - so a field nobody has touched has to
 * follow, and a field being typed into must not be replaced mid-word with nothing said.
 */
function useStoredField(stored: string) {
    const [value, setValue] = useState(stored);
    const adopted = useRef(stored);

    useEffect(() => {
        if (stored === adopted.current) return;
        // Read before the ref moves on: React runs the updater when it renders, not
        // when it is queued, so an updater that read the ref itself would compare the
        // field against the value it is about to adopt and never see it as untouched.
        const previous = adopted.current;
        adopted.current = stored;
        setValue((current) => (current === previous ? stored : current));
    }, [stored]);

    /** Take a value as the stored one, once a save has written it. */
    function adopt(next: string) {
        adopted.current = next;
        setValue(next);
    }

    return { value, setValue, adopt };
}

/**
 * The two addresses Polaris itself uses, which the guided setup does not decide: where
 * the dashboard answers, and which domain the links it hands out are built from.
 */
function AppDomains({
    config,
    suggestions,
    effectiveAppUrl,
    onSaved
}: {
    config: DomainConfig;
    /** What the configured zones can answer for, or nulls when no domain is set up. */
    suggestions: DomainSuggestions;
    effectiveAppUrl: string;
    onSaved: (next: DomainConfig) => void;
}) {
    // The guided setup moves the dashboard onto the Polaris zone once it resolves, so
    // the app domain can change without this card being touched.
    const appDomain = useStoredField(config.appDomain);
    const sharingDomain = useStoredField(config.sharingDomain);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Nothing to save until a field differs from what is stored. */
    const changed =
        appDomain.value.trim() !== config.appDomain ||
        sharingDomain.value.trim() !== config.sharingDomain;

    async function save() {
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            const result = await saveDomainsAction({
                appDomain: appDomain.value,
                sharingDomain: sharingDomain.value
            });
            onSaved(result.config);
            appDomain.adopt(result.config.appDomain);
            sharingDomain.adopt(result.config.sharingDomain);
            setSaved(true);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not save the domains");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Globe className="size-4 text-primary" />
                    Polaris&apos;s own addresses
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm">
                    App domain
                    <Input
                        value={appDomain.value}
                        onChange={(event) => appDomain.setValue(event.target.value)}
                        placeholder={suggestions.app ?? "polaris.example.com"}
                        autoComplete="off"
                    />
                    <span className="text-xs text-muted-foreground">
                        The dashboard&apos;s stable address. Leave empty to use the deployment
                        default ({effectiveAppUrl}).
                    </span>
                    <Suggestion
                        value={appDomain.value}
                        suggestion={suggestions.app}
                        onUse={appDomain.setValue}
                    />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                    <span className="flex items-center gap-1.5">
                        <Link2 className="size-3.5 text-muted-foreground" />
                        Sharing domain
                    </span>
                    <Input
                        value={sharingDomain.value}
                        onChange={(event) => sharingDomain.setValue(event.target.value)}
                        placeholder={suggestions.sharing ?? "share.example.com"}
                        autoComplete="off"
                    />
                    <span className="text-xs text-muted-foreground">
                        Used for the links Polaris hands out (share links and drop points). Point a
                        throwaway free subdomain (e.g. a dokploy / traefik.me one) here for
                        disposable links. Falls back to the app domain.
                    </span>
                    <Suggestion
                        value={sharingDomain.value}
                        suggestion={suggestions.sharing}
                        onUse={sharingDomain.setValue}
                    />
                </label>

                {error ? <ErrorNote message={error} /> : null}

                <div className="flex items-center justify-end gap-3">
                    {saved && !changed ? (
                        <span className="text-sm text-success">Saved.</span>
                    ) : null}
                    <Button onClick={save} disabled={saving || !changed}>
                        {saving ? "Saving..." : "Save"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

/**
 * Every name the dashboard answers on, in one place, and the way to add another.
 *
 * The two fields above decide which domain Polaris calls its own; this is the whole
 * list, including the ones nothing on this page put there - the address the
 * deployment was installed with, the zone hostname the guided setup created, a quick
 * tunnel. Settings showed those and this page did not, which left an operator with a
 * name they could see, could not manage, and (for a tunnel) could never get back.
 *
 * Extra domains are anything else pointed here: a second brand, an old domain kept
 * answering, a name a proxy forwards. They are routed at the edge and trusted as
 * sign-in origins exactly like the app domain, which is why they are added one at a
 * time and shown with whether they actually answer.
 */
function DashboardDomains({
    config,
    addresses,
    onConfig,
    onAddresses
}: {
    config: DomainConfig;
    addresses: CheckedAddress[];
    onConfig: (next: DomainConfig) => void;
    onAddresses: (next: CheckedAddress[]) => void;
}) {
    const [draft, setDraft] = useState("");
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const candidate = draft
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
    const known = addresses.some((address) => address.host === candidate);
    const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
        candidate
    );

    /**
     * Add one name to the stored list and re-read the addresses, so the row appears
     * with its health rather than as an entry the page invented. The list is saved
     * whole because that is how it is stored and published.
     */
    async function add() {
        if (!valid || known) return;
        setAdding(true);
        setError(null);
        try {
            const result = await saveExtraDomainsAction([...config.extraDomains, candidate]);
            onConfig(result.config);
            setDraft("");
            onAddresses(await deploymentAddressesAction());
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not add the domain");
        } finally {
            setAdding(false);
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Globe className="size-4 text-primary" /> Where Polaris answers
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <AddressList addresses={addresses} onChanged={onAddresses} />

                <div className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
                    Add a domain
                    <div className="flex gap-2">
                        <Input
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => event.key === "Enter" && void add()}
                            // Not the app domain's example: two fields on one page
                            // showing the same name reads as the same field twice.
                            placeholder="another.example.com"
                            autoComplete="off"
                            aria-invalid={draft.trim() !== "" && !valid}
                        />
                        <Button onClick={() => void add()} disabled={adding || !valid || known}>
                            {adding ? <Loader2 className="size-4 animate-spin" /> : null} Add
                        </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">
                        Point the name at this server first. Polaris then routes it, orders a
                        certificate for it, and accepts sign-ins on it.
                    </span>
                    {draft.trim() !== "" && !valid ? (
                        <span className="text-xs text-danger">That is not a domain name.</span>
                    ) : null}
                    {known ? (
                        <span className="text-xs text-muted-foreground">Already on the list.</span>
                    ) : null}
                </div>

                {error ? <ErrorNote message={error} /> : null}
            </CardBody>
        </Card>
    );
}

/**
 * The name the configured zones can already answer for, one press away. Offered only
 * while the field is empty: once something is typed the suggestion is a competing
 * answer, and replacing what the operator wrote is not a hint's job. It fills the
 * field rather than saving, so the value is still theirs to change or discard.
 */
function Suggestion({
    value,
    suggestion,
    onUse
}: {
    value: string;
    suggestion: string | null;
    onUse: (next: string) => void;
}) {
    if (!suggestion || value.trim()) return null;
    return (
        <button
            type="button"
            onClick={() => onUse(suggestion)}
            className="w-fit text-xs text-primary underline-offset-2 hover:underline"
        >
            Use {suggestion}
        </button>
    );
}

/**
 * What went wrong, where the operator is looking. Every save here reaches the server,
 * so any of them can fail on an expired session or a dropped connection - and a button
 * that goes back to "Save" with nothing said reads as though nothing happened.
 */
function ErrorNote({ message }: { message: string }) {
    return (
        <p className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {message}
        </p>
    );
}

/** The root certificate that makes the LAN hostname trusted, once, per device. */
function LocalCertificate() {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <ShieldCheck className="size-4 text-primary" /> Trust this device
                    (polaris.local)
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-2 text-xs">
                <p className="text-muted-foreground">
                    LAN hostnames can&apos;t get a public certificate, so Polaris signs its own.
                    Install this root certificate on your devices once to make{" "}
                    <code>https://polaris.local</code> trusted with no browser warning. macOS/iOS:
                    open it and trust it in Keychain / Profiles. Windows: import into &quot;Trusted
                    Root Certification Authorities&quot;. Firefox: import under Authorities.
                </p>
                <a
                    href="/api/system/local-ca"
                    className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-muted"
                >
                    <Download className="size-3.5" /> Download root certificate
                </a>
            </CardBody>
        </Card>
    );
}

/**
 * DuckDNS on its own terms: the guided setup asks for the same pair when DuckDNS is
 * the chosen strategy, and this is where an operator who uses it for something else -
 * or who only wants to replace the token - edits it.
 */
function DuckDns({
    config,
    onConfig
}: {
    config: DomainConfig;
    onConfig: (next: DomainConfig) => void;
}) {
    // The guided setup asks for the same subdomain, so a save there has to land here
    // rather than leaving this card claiming the field is empty.
    const duckSub = useStoredField(config.duckdnsSubdomain);
    const [duckToken, setDuckToken] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<{ ok: boolean; detail: string } | null>(null);

    /** A token is only ever typed, never read back, so any entry counts as a change. */
    const changed = duckSub.value.trim() !== config.duckdnsSubdomain || duckToken !== "";

    async function save() {
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            const result = await saveDomainsAction({
                duckdnsSubdomain: duckSub.value,
                duckdnsToken: duckToken || undefined
            });
            onConfig(result.config);
            duckSub.adopt(result.config.duckdnsSubdomain);
            setDuckToken("");
            setSaved(true);
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : "Could not save the DuckDNS settings"
            );
        } finally {
            setSaving(false);
        }
    }

    async function sync() {
        setSyncing(true);
        setSyncResult(null);
        try {
            setSyncResult(await syncDuckDnsAction());
        } catch (caught) {
            setSyncResult({
                ok: false,
                detail: caught instanceof Error ? caught.message : "Could not reach DuckDNS"
            });
        } finally {
            setSyncing(false);
        }
    }

    async function clearToken() {
        setError(null);
        try {
            const result = await clearDuckdnsTokenAction();
            onConfig(result.config);
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : "Could not remove the stored token"
            );
        }
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        DuckDNS
                        {config.hasDuckdnsToken ? (
                            <Badge variant="success">Configured</Badge>
                        ) : null}
                    </CardTitle>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={sync}
                        disabled={syncing || !config.hasDuckdnsToken}
                    >
                        <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
                        {syncing ? "Syncing..." : "Sync IP now"}
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-xs text-muted-foreground">
                    Free dynamic DNS. Polaris keeps your DuckDNS record pointed at this host&apos;s
                    current public IP, auto-synced every few minutes. Use{" "}
                    <code>&lt;sub&gt;.duckdns.org</code> as the wildcard base in the guided setup
                    (DuckDNS resolves <code>*.&lt;sub&gt;.duckdns.org</code> too) for free public
                    subdomains with Let&apos;s Encrypt.
                </p>
                <label className="flex flex-col gap-1 text-sm">
                    Subdomain
                    <Input
                        value={duckSub.value}
                        onChange={(event) => duckSub.setValue(event.target.value)}
                        placeholder="mypolaris"
                        autoComplete="off"
                    />
                    <span className="text-xs text-muted-foreground">
                        The part before <code>.duckdns.org</code>.
                    </span>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                    Token
                    <Input
                        type="password"
                        value={duckToken}
                        onChange={(event) => setDuckToken(event.target.value)}
                        placeholder={
                            config.hasDuckdnsToken
                                ? "Saved - enter a new token to replace it"
                                : "DuckDNS token"
                        }
                        autoComplete="off"
                    />
                </label>
                {config.hasDuckdnsToken ? (
                    <button
                        type="button"
                        onClick={clearToken}
                        className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                        Remove stored token
                    </button>
                ) : null}
                {syncResult ? (
                    <p
                        className={`flex items-center gap-1.5 text-sm ${syncResult.ok ? "text-success" : "text-danger"}`}
                    >
                        {syncResult.ok ? (
                            <CheckCircle2 className="size-4" />
                        ) : (
                            <TriangleAlert className="size-4" />
                        )}
                        {syncResult.ok ? "DuckDNS updated." : syncResult.detail}
                    </p>
                ) : null}
                {error ? <ErrorNote message={error} /> : null}

                <div className="flex items-center justify-end gap-3">
                    {saved && !changed ? (
                        <span className="text-sm text-success">Saved.</span>
                    ) : null}
                    <Button onClick={save} disabled={saving || !changed}>
                        {saving ? "Saving..." : "Save"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

const MODE_OPTIONS = [
    { value: "auto", label: "Automatic (detect)" },
    { value: "lan", label: "LAN only" },
    { value: "public", label: "Public IP (direct)" },
    { value: "wildcard", label: "Custom wildcard domain" },
    { value: "tunnel", label: "Cloudflare / ngrok tunnel" }
];

/**
 * Network topology + exposure control: the manual view behind the guided setup.
 * Shows whether the box is publicly reachable or behind NAT, lets the operator
 * override how auto domains are exposed, and explains what each mode needs, so a
 * free subdomain that would only work on the LAN is never handed out as if it
 * worked everywhere.
 */
function NetworkExposure({ nonce }: { nonce: number }) {
    const [status, setStatus] = useState<NetworkStatus | null>(null);
    const [mode, setMode] = useState<NetworkMode>("auto");
    const [wildcard, setWildcard] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // What the last read (or save) left in these two controls. The setup re-reads this
    // panel whenever it changes something, so a control nobody has touched follows the
    // stored value, and one the operator has changed and not saved yet is left alone.
    const loaded = useRef({ mode: "auto" as NetworkMode, wildcard: "" });

    /**
     * The read this panel renders from. Callable rather than inline in the effect: it
     * detects the public IP and the hosting placement, so it can fail, and the setup
     * only re-reads when it changes something of its own - leaving the operator with a
     * message and nothing to press.
     */
    function load() {
        // A re-read after the setup changed something has to clear what the last one
        // failed with, or the error stays under a panel that has just loaded fine.
        setError(null);
        setLoading(true);
        void networkStatusAction()
            .then((next) => {
                const previous = loaded.current;
                loaded.current = { mode: next.mode, wildcard: next.wildcardDomain };
                setStatus(next);
                setMode((current) => (current === previous.mode ? next.mode : current));
                setWildcard((current) =>
                    current === previous.wildcard ? next.wildcardDomain : current
                );
            })
            .catch((caught: unknown) => {
                setError(
                    caught instanceof Error ? caught.message : "Could not read the network status"
                );
            })
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        load();
    }, [nonce]);

    async function redetect() {
        setBusy(true);
        setError(null);
        try {
            setStatus(await networkStatusAction(true));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not re-detect the network");
        } finally {
            setBusy(false);
        }
    }

    async function save() {
        setBusy(true);
        setSaved(false);
        setError(null);
        try {
            // A zone-managed wildcard is not editable here, so it is not written back:
            // storing a copy would leave two values for one setting.
            const next = await saveNetworkConfigAction(
                status?.wildcardManaged ? { mode } : { mode, wildcardDomain: wildcard }
            );
            loaded.current = { mode: next.mode, wildcard: next.wildcardDomain };
            setStatus(next);
            // Put back as it was stored - the server strips a scheme, a `*.` prefix and
            // a trailing slash - so what is on screen is what was saved, and the field
            // does not keep reading as an unsaved change.
            setWildcard(next.wildcardDomain);
            setSaved(true);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not save the exposure mode");
        } finally {
            setBusy(false);
        }
    }

    if (loading) {
        return (
            <PendingCard
                title={
                    <>
                        <Network className="size-4 text-primary" /> Network &amp; exposure
                    </>
                }
            >
                {/* The six facts it reports, in the grid they land in. */}
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-border/60 p-3">
                    {[0, 1, 2, 3, 4, 5].map((row) => (
                        <div key={row} className="flex items-center justify-between gap-2">
                            <Skeleton className="h-3 w-20" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                    ))}
                </div>
                <FieldSkeleton />
            </PendingCard>
        );
    }

    if (!status) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <ErrorNote message={error ?? "Could not read the network status"} />
                    <Button size="sm" variant="secondary" className="w-fit" onClick={load}>
                        <RefreshCw className="size-4" /> Try again
                    </Button>
                </CardBody>
            </Card>
        );
    }

    const effective = status.effectiveMode;
    const publiclyReachable = effective === "public" || effective === "wildcard";
    /** Nothing to save until a control differs from what the last read or save left.
     *  A zone-managed wildcard is not written back, so it cannot be a change either. */
    const changed =
        mode !== loaded.current.mode ||
        (!status.wildcardManaged && wildcard.trim() !== loaded.current.wildcard);

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <Network className="size-4 text-primary" /> Network &amp; exposure
                    </CardTitle>
                    <Button size="sm" variant="secondary" onClick={redetect} disabled={busy}>
                        <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Re-detect
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-border/60 p-3 text-xs">
                    <StatusRow
                        label="Hosting"
                        value={
                            status.placement === "cloud"
                                ? "Cloud / data centre"
                                : status.placement === "home"
                                  ? "Home / local"
                                  : "Unknown"
                        }
                    />
                    <StatusRow label="Public IP" value={status.publicIp ?? "not detected"} />
                    <StatusRow label="Server IP" value={status.subdomainIp ?? "unknown"} />
                    <StatusRow
                        label="Behind NAT"
                        value={status.natted ? "Yes" : "No"}
                        tone={status.natted ? "warn" : "ok"}
                    />
                    <StatusRow
                        label="Active mode"
                        value={effective}
                        tone={publiclyReachable ? "ok" : "warn"}
                    />
                    <StatusRow
                        label="DuckDNS"
                        value={status.duckdns ? "Configured" : "Not set"}
                        tone={status.duckdns ? "ok" : undefined}
                    />
                </div>

                {status.natted && status.mode === "auto" && (
                    <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                        This looks like a server behind NAT: free subdomains point at the LAN IP (
                        {status.subdomainIp}) and only work on your network. For public access,
                        choose a wildcard domain or a tunnel below.
                    </p>
                )}

                {status.placement === "home" &&
                    !status.duckdns &&
                    status.effectiveMode !== "wildcard" && (
                        <p className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-primary" />
                            Recommended for a home/local server: set up <b>DuckDNS</b> below (free)
                            and use <code>&lt;sub&gt;.duckdns.org</code> as the wildcard base -
                            Polaris then serves public subdomains with Let&apos;s Encrypt and keeps
                            the IP updated automatically.
                        </p>
                    )}

                <label className="flex flex-col gap-1 text-sm">
                    Exposure mode
                    <Select
                        value={mode}
                        onValueChange={(value) => setMode(value as NetworkMode)}
                        options={MODE_OPTIONS}
                    />
                </label>

                {mode === "wildcard" && (
                    <label className="flex flex-col gap-1 text-sm">
                        Wildcard base domain
                        <Input
                            value={wildcard}
                            onChange={(event) => setWildcard(event.target.value)}
                            placeholder="apps.example.com"
                            autoComplete="off"
                            disabled={status.wildcardManaged}
                        />
                        {status.wildcardManaged && (
                            <span className="text-xs text-muted-foreground">
                                Taken from your zone layout. Change it in the guided setup above.
                            </span>
                        )}
                        {status.wildcardManaged && !status.wildcardReady && (
                            <span className="text-xs text-warning">
                                Not in use yet: the wildcard has not been seen resolving to this
                                server. New services keep a free subdomain until the DNS check in
                                the guided setup passes.
                            </span>
                        )}
                    </label>
                )}

                <ExposureGuidance status={status} mode={mode} wildcard={wildcard} />

                {error ? <ErrorNote message={error} /> : null}

                <div className="flex items-center justify-end gap-3">
                    {saved && !changed ? (
                        <span className="text-sm text-success">Saved.</span>
                    ) : null}
                    <Button onClick={save} disabled={busy || !changed}>
                        {busy ? "Saving..." : "Save exposure"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
    const color =
        tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-foreground";
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className={`font-mono ${color}`}>{value}</span>
        </div>
    );
}

function ExposureGuidance({
    status,
    mode,
    wildcard
}: {
    status: NetworkStatus;
    mode: NetworkMode;
    wildcard: string;
}) {
    const effective = mode === "auto" ? status.effectiveMode : mode;
    const base = wildcard.trim() || "apps.example.com";

    if (effective === "public") {
        return (
            <GuidanceNote ok>
                Your box is internet-reachable at {status.publicIp ?? status.subdomainIp}. Free
                subdomains get a real Let&apos;s Encrypt certificate and work from anywhere.
            </GuidanceNote>
        );
    }
    if (effective === "wildcard") {
        return (
            <GuidanceNote>
                <b>Point a wildcard at your server, then Polaris manages every subdomain:</b>
                <ol className="mt-1 list-decimal space-y-1 pl-4">
                    <li>
                        Create a DNS record <code>*.{base}</code> of type A pointing at your public
                        IP
                        {status.publicIp ? ` (${status.publicIp})` : ""}.
                    </li>
                    <li>
                        Forward ports <code>80</code> and <code>443</code> on your router to this
                        server
                        {status.subdomainIp ? ` (${status.subdomainIp})` : ""}.
                    </li>
                    <li>
                        Save. New services get <code>&lt;app&gt;.{base}</code> with an automatic
                        Let&apos;s Encrypt certificate.
                    </li>
                </ol>
                <p className="mt-2">
                    No domain? Use a free <b>DuckDNS</b> subdomain (
                    <code>&lt;sub&gt;.duckdns.org</code>) as the base - Polaris keeps its IP updated
                    automatically. Set the token in the DuckDNS card below.
                </p>
            </GuidanceNote>
        );
    }
    if (effective === "tunnel") {
        return (
            <GuidanceNote>
                Public access runs through a Cloudflare/ngrok tunnel - no open ports or public IP
                needed. Set one up in{" "}
                <a className="text-primary hover:underline" href="/integrations">
                    Integrations
                </a>
                , or use the per-service <b>Public tunnel</b> button. Auto subdomains stay LAN-only.
            </GuidanceNote>
        );
    }
    return (
        <GuidanceNote>
            Free subdomains resolve to your LAN IP ({status.subdomainIp ?? "unknown"}) and work only
            on your local network, served with the internal CA (a one-time browser warning). Pick a
            wildcard domain or a tunnel to expose services publicly.
        </GuidanceNote>
    );
}

function GuidanceNote({ children, ok }: { children: ReactNode; ok?: boolean }) {
    return (
        <div
            className={`rounded-md border px-3 py-2 text-xs text-muted-foreground ${
                ok ? "border-success/30 bg-success/5" : "border-border/60 bg-surface/40"
            }`}
        >
            {children}
        </div>
    );
}
