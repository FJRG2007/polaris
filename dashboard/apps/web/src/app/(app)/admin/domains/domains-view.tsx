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
 * The panel reads its own data once the page is on screen, and every section is drawn
 * before that read lands: the titles, the certificate section and the Advanced toggle do
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
import { DnsRecordsCard } from "./dns-records-card";
import { AddressList } from "@/components/address-list";
import { OwnerDomainsCard } from "./owner-domains-card";
import { CertificateContactCard } from "./certificate-contact-card";
import { PageSection } from "@/components/page-section";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DomainConfig } from "@/lib/domain-service";
import type { CheckedAddress } from "@/lib/address-health";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { DOMAINS_OVERVIEW_URL, type DomainsOverview } from "./overview";
import type { NetworkMode, NetworkStatus } from "@/lib/network-service";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { domainSuggestions, type DomainSuggestions } from "@/lib/domain-suggestions";
import { Badge, Button, DnsRecordTable, Input, Select, Skeleton } from "@polaris/ui";
import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Download,
    Link2,
    Loader2,
    RefreshCw,
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
    const t = useTranslations("admin");
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
        <div className="flex w-full flex-col gap-6">
            {unread && !overview ? (
                <div className="flex flex-col items-start gap-2">
                    <ErrorNote message={unread} />
                    <Button size="sm" variant="secondary" onClick={() => void load()}>
                        <RefreshCw className="size-4" /> {t("domains.tryAgain")}
                    </Button>
                </div>
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
                <PendingCard title={t("domains.own.title")}>
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
                <PendingCard title={t("domains.answers.title")} wide>
                    <AddressesSkeleton />
                    <div className="max-w-2xl">
                        <FieldSkeleton />
                    </div>
                </PendingCard>
            )}

            <LocalCertificate />

            {/* Beside the other certificate, and read on its own: it asks the host
                daemon about the edge, which the overview above does not wait on. */}
            <CertificateContactCard />

            <DnsRecordsCard />

            <div className="flex flex-col gap-6 border-t border-border pt-6">
                <button
                    type="button"
                    aria-expanded={advanced}
                    onClick={() => setAdvanced((value) => !value)}
                    className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                    {advanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    {t("domains.advancedToggle")}
                </button>
                {advanced && (
                    <>
                        <NetworkExposure nonce={setupNonce} />
                        {overview ? (
                            <DuckDns config={overview.config} onConfig={(config) => apply({ config })} />
                        ) : (
                            // i18n-ignore: a brand name
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
                <PendingCard title={t("domains.owner.title")}>
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
 * A section whose heading is on screen before its contents are.
 *
 * The title is the real one rather than a block: it does not depend on the read, and
 * a page an operator can already navigate by is the entire point of painting before
 * the data lands. Only what is genuinely waiting pulses, in the shape it will take.
 */
function PendingCard({ title, wide, children }: { title: ReactNode; wide?: boolean; children: ReactNode }) {
    return (
        <PageSection title={title} wide={wide}>
            {children}
        </PageSection>
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
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    // The guided setup moves the dashboard onto the Polaris zone once it resolves, so
    // the app domain can change without this card being touched.
    const appDomain = useStoredField(config.appDomain);
    const sharingDomain = useStoredField(config.sharingDomain);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Nothing to save until a field differs from what is stored. */
    const changed =
        appDomain.value.trim() !== config.appDomain || sharingDomain.value.trim() !== config.sharingDomain;

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
            setError(caught instanceof Error ? caught.message : t("domains.own.saveFailed"));
        } finally {
            setSaving(false);
        }
    }

    return (
        <PageSection title={t("domains.own.title")}>
            <label className="flex flex-col gap-1 text-sm">
                {t("domains.own.appDomain")}
                <Input
                    value={appDomain.value}
                    onChange={(event) => appDomain.setValue(event.target.value)}
                    placeholder={suggestions.app ?? "polaris.example.com"}
                    autoComplete="off"
                />
                <span className="text-xs text-muted-foreground">
                    {t("domains.own.appDomainHint", { url: effectiveAppUrl })}
                </span>
                <Suggestion value={appDomain.value} suggestion={suggestions.app} onUse={appDomain.setValue} />
            </label>

            <label className="flex flex-col gap-1 text-sm">
                <span className="flex items-center gap-1.5">
                    <Link2 className="size-3.5 text-muted-foreground" />
                    {t("domains.own.sharingDomain")}
                </span>
                <Input
                    value={sharingDomain.value}
                    onChange={(event) => sharingDomain.setValue(event.target.value)}
                    placeholder={suggestions.sharing ?? "share.example.com"}
                    autoComplete="off"
                />
                <span className="text-xs text-muted-foreground">{t("domains.own.sharingDomainHint")}</span>
                <Suggestion
                    value={sharingDomain.value}
                    suggestion={suggestions.sharing}
                    onUse={sharingDomain.setValue}
                />
            </label>

            {error ? <ErrorNote message={error} /> : null}

            <div className="flex items-center justify-end gap-3">
                {saved && !changed ? <span className="text-sm text-success">{t("domains.saved")}</span> : null}
                <Button onClick={save} disabled={saving || !changed}>
                    {saving ? tc("actions.saving") : tc("actions.save")}
                </Button>
            </div>
        </PageSection>
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
    const t = useTranslations("admin");
    const [draft, setDraft] = useState("");
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const candidate = draft.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const known = addresses.some((address) => address.host === candidate);
    const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(candidate);

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
            setError(caught instanceof Error ? caught.message : t("domains.answers.addFailed"));
        } finally {
            setAdding(false);
        }
    }

    return (
        <PageSection title={t("domains.answers.title")} wide>
            <AddressList addresses={addresses} onChanged={onAddresses} />

            <div className="flex max-w-2xl flex-col gap-1 text-sm">
                {t("domains.answers.addLabel")}
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
                        {adding ? <Loader2 className="size-4 animate-spin" /> : null} {t("domains.answers.add")}
                    </Button>
                </div>
                <span className="text-xs text-muted-foreground">{t("domains.answers.addHint")}</span>
                {draft.trim() !== "" && !valid ? (
                    <span className="text-xs text-danger">{t("domains.answers.notADomain")}</span>
                ) : null}
                {known ? <span className="text-xs text-muted-foreground">{t("domains.answers.known")}</span> : null}
            </div>

            {error ? <ErrorNote message={error} /> : null}
        </PageSection>
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
    const t = useTranslations("admin");
    if (!suggestion || value.trim()) return null;
    return (
        <button
            type="button"
            onClick={() => onUse(suggestion)}
            className="w-fit text-xs text-primary underline-offset-2 hover:underline"
        >
            {t("domains.own.use", { suggestion })}
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
        <p className="flex items-start gap-2 rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-xs text-danger-ink">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {message}
        </p>
    );
}

/** The root certificate that makes the LAN hostname trusted, once, per device. */
function LocalCertificate() {
    const t = useTranslations("admin");
    return (
        <PageSection title={t("domains.certificate.title")}>
            <p className="text-xs text-muted-foreground">{t.rich("domains.certificate.body", { code })}</p>
            <a
                href="/api/system/local-ca"
                className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
                <Download className="size-3.5" /> {t("domains.certificate.download")}
            </a>
        </PageSection>
    );
}

/**
 * DuckDNS on its own terms: the guided setup asks for the same pair when DuckDNS is
 * the chosen strategy, and this is where an operator who uses it for something else -
 * or who only wants to replace the token - edits it.
 */
function DuckDns({ config, onConfig }: { config: DomainConfig; onConfig: (next: DomainConfig) => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
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
            setError(caught instanceof Error ? caught.message : t("domains.duckdns.saveFailed"));
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
            setSyncResult({ ok: false, detail: caught instanceof Error ? caught.message : t("domains.duckdns.syncFailed") });
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
            setError(caught instanceof Error ? caught.message : t("domains.duckdns.removeFailed"));
        }
    }

    return (
        <PageSection
            title={
                <>
                    {/* i18n-ignore: a brand name */}
                    DuckDNS
                    {config.hasDuckdnsToken ? <Badge variant="success">{t("domains.duckdns.configured")}</Badge> : null}
                </>
            }
            actions={
                <Button size="sm" variant="secondary" onClick={sync} disabled={syncing || !config.hasDuckdnsToken}>
                    <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
                    {syncing ? t("domains.duckdns.syncing") : t("domains.duckdns.sync")}
                </Button>
            }
        >
            <p className="text-xs text-muted-foreground">
                {t.rich("domains.duckdns.description", {
                    base: <code key="base">{DUCKDNS_BASE}</code>,
                    wildcard: <code key="wildcard">*.{DUCKDNS_BASE}</code>
                })}
            </p>
            <label className="flex flex-col gap-1 text-sm">
                {t("domains.duckdns.subdomain")}
                <Input
                    value={duckSub.value}
                    onChange={(event) => duckSub.setValue(event.target.value)}
                    placeholder="mypolaris"
                    autoComplete="off"
                />
                <span className="text-xs text-muted-foreground">{t.rich("domains.duckdns.subdomainHint", { code })}</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
                {t("domains.duckdns.token")}
                <Input
                    type="password"
                    value={duckToken}
                    onChange={(event) => setDuckToken(event.target.value)}
                    placeholder={config.hasDuckdnsToken ? t("domains.duckdns.tokenSaved") : t("domains.duckdns.tokenPlaceholder")}
                    autoComplete="off"
                />
            </label>
            {config.hasDuckdnsToken ? (
                <button
                    type="button"
                    onClick={clearToken}
                    className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                    {t("domains.duckdns.removeToken")}
                </button>
            ) : null}
            {syncResult ? (
                <p className={`flex items-center gap-1.5 text-sm ${syncResult.ok ? "text-success" : "text-danger"}`}>
                    {syncResult.ok ? <CheckCircle2 className="size-4" /> : <TriangleAlert className="size-4" />}
                    {syncResult.ok ? t("domains.duckdns.updated") : syncResult.detail}
                </p>
            ) : null}
            {error ? <ErrorNote message={error} /> : null}

            <div className="flex items-center justify-end gap-3">
                {saved && !changed ? <span className="text-sm text-success">{t("domains.saved")}</span> : null}
                <Button onClick={save} disabled={saving || !changed}>
                    {saving ? tc("actions.saving") : tc("actions.save")}
                </Button>
            </div>
        </PageSection>
    );
}

/** The DuckDNS name as the help writes it: a placeholder, not a hostname. */
const DUCKDNS_BASE = "<sub>.duckdns.org";

const MODES: readonly NetworkMode[] = ["auto", "lan", "public", "wildcard", "tunnel"];

function modeOptions(t: NamespaceTranslator<"admin">) {
    return MODES.map((value) => ({ value, label: t(`domains.network.modes.${value}`) }));
}

/**
 * Network topology + exposure control: the manual view behind the guided setup.
 * Shows whether the box is publicly reachable or behind NAT, lets the operator
 * override how auto domains are exposed, and explains what each mode needs, so a
 * free subdomain that would only work on the LAN is never handed out as if it
 * worked everywhere.
 */
function NetworkExposure({ nonce }: { nonce: number }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
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
                setWildcard((current) => (current === previous.wildcard ? next.wildcardDomain : current));
            })
            .catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : t("domains.network.readFailed"));
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
            setError(caught instanceof Error ? caught.message : t("domains.network.redetectFailed"));
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
            setError(caught instanceof Error ? caught.message : t("domains.network.saveFailed"));
        } finally {
            setBusy(false);
        }
    }

    if (loading) {
        return (
            <PendingCard title={t("domains.network.title")}>
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
            <PageSection title={t("domains.network.title")}>
                <ErrorNote message={error ?? t("domains.network.readFailed")} />
                <Button size="sm" variant="secondary" className="w-fit" onClick={load}>
                    <RefreshCw className="size-4" /> {t("domains.tryAgain")}
                </Button>
            </PageSection>
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
        <PageSection
            title={t("domains.network.title")}
            actions={
                <Button size="sm" variant="secondary" onClick={redetect} disabled={busy}>
                    <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> {t("domains.network.redetect")}
                </Button>
            }
        >
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-border/60 p-3 text-xs">
                <StatusRow
                    label={t("domains.network.status.hosting")}
                    value={
                        status.placement === "cloud"
                            ? t("domains.network.status.cloud")
                            : status.placement === "home"
                              ? t("domains.network.status.home")
                              : t("domains.network.status.unknownPlacement")
                    }
                />
                <StatusRow
                    label={t("domains.network.status.publicIp")}
                    value={status.publicIp ?? t("domains.network.status.notDetected")}
                />
                <StatusRow
                    label={t("domains.network.status.serverIp")}
                    value={status.subdomainIp ?? t("domains.network.status.unknown")}
                />
                <StatusRow
                    label={t("domains.network.status.behindNat")}
                    value={status.natted ? t("domains.network.status.yes") : t("domains.network.status.no")}
                    tone={status.natted ? "warn" : "ok"}
                />
                <StatusRow
                    label={t("domains.network.status.activeMode")}
                    value={effective}
                    tone={publiclyReachable ? "ok" : "warn"}
                />
                <StatusRow
                    // i18n-ignore: a brand name
                    label="DuckDNS"
                    value={status.duckdns ? t("domains.network.status.configured") : t("domains.network.status.notSet")}
                    tone={status.duckdns ? "ok" : undefined}
                />
            </div>

            {status.natted && status.mode === "auto" && (
                <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    {t("domains.network.natWarning", { ip: status.subdomainIp ?? "" })}
                </p>
            )}

            {status.placement === "home" && !status.duckdns && status.effectiveMode !== "wildcard" && (
                <p className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <span>{t.rich("domains.network.homeAdvice", { base: DUCKDNS_BASE, b: bold, code })}</span>
                </p>
            )}

            <label className="flex flex-col gap-1 text-sm">
                {t("domains.network.exposureMode")}
                <Select value={mode} onValueChange={(value) => setMode(value as NetworkMode)} options={modeOptions(t)} />
            </label>

            {mode === "wildcard" && (
                <label className="flex flex-col gap-1 text-sm">
                    {t("domains.network.wildcardBase")}
                    <Input
                        value={wildcard}
                        onChange={(event) => setWildcard(event.target.value)}
                        placeholder="apps.example.com"
                        autoComplete="off"
                        disabled={status.wildcardManaged}
                    />
                    {status.wildcardManaged && (
                        <span className="text-xs text-muted-foreground">{t("domains.network.wildcardManaged")}</span>
                    )}
                    {status.wildcardManaged && !status.wildcardReady && (
                        <span className="text-xs text-warning">{t("domains.network.wildcardNotReady")}</span>
                    )}
                </label>
            )}

            <ExposureGuidance status={status} mode={mode} wildcard={wildcard} />

            {error ? <ErrorNote message={error} /> : null}

            <div className="flex items-center justify-end gap-3">
                {saved && !changed ? <span className="text-sm text-success">{t("domains.saved")}</span> : null}
                <Button onClick={save} disabled={busy || !changed}>
                    {busy ? tc("actions.saving") : t("domains.network.saveExposure")}
                </Button>
            </div>
        </PageSection>
    );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
    const color = tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-foreground";
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className={`font-mono ${color}`}>{value}</span>
        </div>
    );
}

function ExposureGuidance({ status, mode, wildcard }: { status: NetworkStatus; mode: NetworkMode; wildcard: string }) {
    const t = useTranslations("admin");
    const effective = mode === "auto" ? status.effectiveMode : mode;
    const base = wildcard.trim() || "apps.example.com";

    if (effective === "public") {
        return (
            <GuidanceNote ok>{t("domains.guidance.public", { ip: status.publicIp ?? status.subdomainIp ?? "" })}</GuidanceNote>
        );
    }
    if (effective === "wildcard") {
        return (
            <GuidanceNote>
                <b>{t("domains.guidance.wildcardTitle")}</b>
                <ol className="mt-1 list-decimal space-y-1 pl-4">
                    <li>
                        {t("domains.guidance.wildcardRecord")}
                        <DnsRecordTable
                            records={[
                                {
                                    type: "A",
                                    name: `*.${base}`,
                                    value: status.publicIp,
                                    valueFallback: t("domains.guidance.yourPublicIp")
                                }
                            ]}
                            className="mt-1.5"
                        />
                    </li>
                    <li>
                        {status.subdomainIp
                            ? t.rich("domains.guidance.wildcardForwardIp", { ip: status.subdomainIp, code })
                            : t.rich("domains.guidance.wildcardForward", { code })}
                    </li>
                    <li>{t.rich("domains.guidance.wildcardSave", { host: `<app>.${base}`, code })}</li>
                </ol>
                <p className="mt-2">{t.rich("domains.guidance.wildcardNoDomain", { base: DUCKDNS_BASE, b: bold, code })}</p>
            </GuidanceNote>
        );
    }
    if (effective === "tunnel") {
        return (
            <GuidanceNote>
                {t.rich("domains.guidance.tunnel", {
                    link: (chunks) => (
                        <a key="link" className="text-primary hover:underline" href="/admin/integrations">
                            {chunks}
                        </a>
                    ),
                    b: bold
                })}
            </GuidanceNote>
        );
    }
    return (
        <GuidanceNote>
            {t("domains.guidance.lan", { ip: status.subdomainIp ?? t("domains.network.status.unknown") })}
        </GuidanceNote>
    );
}

/** The `<code>` and `<b>` tags in a translated sentence. */
function code(chunks: ReactNode[]) {
    return <code key="code">{chunks}</code>;
}

function bold(chunks: ReactNode[]) {
    return <b key="b">{chunks}</b>;
}

function GuidanceNote({ children, ok }: { children: ReactNode; ok?: boolean }) {
    return (
        <div
            className={`rounded-md border px-3 py-2 text-xs text-muted-foreground ${
                ok ? "border-success-edge bg-success-soft" : "border-border/60 bg-surface/40"
            }`}
        >
            {children}
        </div>
    );
}
