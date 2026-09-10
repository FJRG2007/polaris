"use client";

/**
 * The domains one owner has brought, and the two records each one needs.
 *
 * Shared by the account screen and an organization's, because the thing being
 * managed is the same and only the owner differs. That matters beyond saving a
 * file: the DNS instructions are the part people get wrong, and two copies of
 * them would eventually disagree about what to publish.
 *
 * A domain in progress shows exactly the records that are missing, with the
 * values copyable, because the next thing whoever added it does is paste them
 * into a registrar's form in another tab. "Not verified" on its own sends people
 * back here to guess.
 */

import { runAction } from "@/lib/run-action";
import { useEffect, useRef, useState } from "react";
import { PageSection } from "@/components/page-section";
import type { OwnerDomainView } from "@/lib/owner-domains";
import { useDisplayFormat } from "@/components/display-format";
import { DnsZoneEditor } from "@/components/dns/dns-zone-editor";
import { domainProblem, instanceDomainConflict } from "@/lib/owner-domains-policy";
import { Badge, Button, ConfirmDeleteDialog, DnsRecordTable, EmptyState, Input } from "@polaris/ui";
import { AlertTriangle, CheckCircle2, Clock, Globe, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
    addOwnerDomainAction,
    checkOwnerDomainAction,
    readOwnerDomainAction,
    removeOwnerDomainAction,
    retryOwnerDomainCertificateAction,
    setOwnerDomainDnsTokenAction,
    type DomainOwnerRef
} from "@/app/(app)/account/domains/actions";

/** How long a domain waiting on DNS goes between checks on its own. Records take
 *  minutes to appear, so a tighter loop only spends lookups. */
const RECHECK_SECONDS = 30;
/** How often a certificate being ordered is asked about. An order waits on DNS
 *  and Let's Encrypt and usually lands inside a minute. */
const ORDER_POLL_MS = 10_000;

export function OwnerDomainsView({
    owner,
    domains: initial,
    canAdd,
    blockedReason,
    publicIp,
    instanceDomains
}: {
    owner: DomainOwnerRef;
    domains: OwnerDomainView[];
    canAdd: boolean;
    /** Why the form is not offered, when it is not. */
    blockedReason: string;
    /** The address the wildcard has to point at. Null when this Polaris has not
     *  worked out its own public address, in which case the record is described
     *  rather than given - a wrong address pasted into a registrar is worse than
     *  a sentence saying to look it up. */
    publicIp: string | null;
    /** What this Polaris itself answers on. Sent down so the field refuses as it
     *  is typed rather than after a round trip; the service refuses the same
     *  input for the same reason, which is what actually enforces it. */
    instanceDomains: string[];
}) {
    const [domains, setDomains] = useState(initial);
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    // Empty until something has been typed: a field nobody has filled in yet is
    // incomplete, not wrong.
    // Two different refusals and they are answered in order: what was typed has
    // to be a domain before there is any point asking whether it is one Polaris
    // already occupies.
    const malformed = domainProblem(value);
    const reserved = !malformed && value.trim() ? instanceDomainConflict(value, instanceDomains) : null;
    // What stops the Add button. A single letter is not a domain, and a button
    // that offers itself for input it will refuse has to be pressed before it
    // can be understood.
    const refusal = malformed ?? (reserved ? `${reserved}. Pick a domain of your own.` : null);

    // The list is kept here rather than re-read from the server on every check,
    // so pressing Check on one domain does not blank the others while a DNS
    // lookup that can take seconds is in flight.
    const replace = (next: OwnerDomainView) =>
        setDomains((current) => current.map((entry) => (entry.id === next.id ? next : entry)));

    return (
        <div className="flex flex-col gap-6">
            {error && (
                <p role="alert" className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm">
                    {error}
                </p>
            )}

            {domains.length === 0 ? (
                <EmptyState
                    icon={<Globe />}
                    title="No domain of your own yet"
                    description="Add one you already own and Polaris will give services here hostnames under it. Until then they take this Polaris's own domains."
                />
            ) : (
                domains.map((entry) => (
                    <DomainSection
                        key={entry.id}
                        owner={owner}
                        domain={entry}
                        publicIp={publicIp}
                        onChecked={replace}
                        onRemoved={(id) => setDomains((current) => current.filter((row) => row.id !== id))}
                        onError={setError}
                    />
                ))
            )}

            {canAdd ? (
                <PageSection title="Add a domain">
                    <form
                        className="flex flex-wrap items-end gap-2"
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (!value.trim() || refusal) return;
                            setBusy(true);
                            setError("");
                            const result = await runAction(
                                () => addOwnerDomainAction(owner, value.trim()),
                                setError
                            );
                            setBusy(false);
                            if (!result || result.error) {
                                if (result?.error) setError(result.error);
                                return;
                            }
                            if (result.domain) setDomains((current) => [...current, result.domain!]);
                            setValue("");
                        }}
                    >
                        <label className="text-muted-foreground flex min-w-56 flex-1 flex-col gap-1 text-xs">
                            Domain
                            <Input
                                value={value}
                                placeholder="example.com"
                                className="h-9"
                                aria-invalid={refusal ? true : undefined}
                                aria-describedby={refusal ? "owner-domain-refusal" : undefined}
                                onChange={(event) => setValue(event.target.value)}
                            />
                        </label>
                        <Button
                            type="submit"
                            size="sm"
                            aria-disabled={busy || !value.trim() || refusal !== null}
                            disabled={busy || !value.trim() || refusal !== null}
                        >
                            <Plus className="size-4 shrink-0" /> Add
                        </Button>
                        {refusal ? (
                            <p id="owner-domain-refusal" className="text-danger w-full text-xs">
                                {refusal}
                            </p>
                        ) : (
                            <p className="text-muted-foreground w-full text-xs">
                                A domain or a subdomain you have delegated - `example.com` or
                                `apps.example.com`. Polaris will show you the two records to publish.
                            </p>
                        )}
                    </form>
                </PageSection>
            ) : (
                <p className="text-muted-foreground text-sm">{blockedReason}</p>
            )}
        </div>
    );
}

/** One domain: whether it is ready, the records it still needs, its certificate,
 *  and - with a DNS token of its own - its zone's records. */
function DomainSection({
    owner,
    domain,
    publicIp,
    onChecked,
    onRemoved,
    onError
}: {
    owner: DomainOwnerRef;
    domain: OwnerDomainView;
    publicIp: string | null;
    onChecked: (domain: OwnerDomainView) => void;
    onRemoved: (id: string) => void;
    onError: (message: string) => void;
}) {
    const format = useDisplayFormat();
    const [busy, setBusy] = useState(false);
    const [removing, setRemoving] = useState(false);

    const ready = domain.verified && domain.wildcardOk;

    async function remove() {
        setRemoving(false);
        setBusy(true);
        const result = await runAction(() => removeOwnerDomainAction(owner, domain.id), onError);
        setBusy(false);
        if (result && !result.error) onRemoved(domain.id);
        else if (result?.error) onError(result.error);
    }

    async function check() {
        setBusy(true);
        onError("");
        const result = await runAction(() => checkOwnerDomainAction(owner, domain.id), onError);
        setBusy(false);
        if (result?.domain) onChecked(result.domain);
        else if (result?.error) onError(result.error);
    }

    // A domain waiting on DNS checks itself on a timer, so whoever is adding the
    // records at their registrar in another tab sees it turn ready without coming
    // back to press anything. Paused while the tab is hidden.
    const secondsLeft = useRecheck(!ready && !busy, check);

    return (
        <PageSection
            wide
            title={
                <>
                    <span className="min-w-0 break-all">{domain.domain}</span>
                    {ready ? (
                        <Badge variant="success">
                            <CheckCircle2 className="size-3 shrink-0" /> Ready
                        </Badge>
                    ) : (
                        <Badge variant="neutral">
                            <Clock className="size-3 shrink-0" /> Waiting on DNS
                        </Badge>
                    )}
                </>
            }
            description={
                <span aria-live="polite">
                    {domain.checkedAt ? `Last checked ${format.dateTime(domain.checkedAt)}.` : "Not checked yet."}
                    {!ready && secondsLeft !== null && ` Checking again in ${secondsLeft}s.`}
                </span>
            }
            actions={
                <>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Check ${domain.domain}`}
                        title="Check DNS now"
                        onClick={() => void check()}
                    >
                        <RefreshCw className={busy ? "size-4 shrink-0 animate-spin" : "size-4 shrink-0"} />
                        Check
                    </Button>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Remove ${domain.domain}`}
                        title="Remove"
                        onClick={() => setRemoving(true)}
                    >
                        <Trash2 className="size-4 shrink-0" />
                    </Button>
                </>
            }
        >
            {domain.detail && <p className="text-muted-foreground text-sm">{domain.detail}</p>}

            {!ready && (
                <DnsRecordTable
                    records={[
                        {
                            type: "TXT",
                            name: domain.txtName,
                            value: domain.txtValue,
                            status: domain.verified ? "done" : "waiting",
                            note: "Proves the domain is yours."
                        },
                        {
                            type: "A",
                            name: domain.wildcard,
                            value: publicIp,
                            valueFallback: "this server's public address, once it is detected",
                            status: domain.wildcardOk ? "done" : "waiting",
                            note: "Makes every hostname Polaris mints under it arrive here."
                        }
                    ]}
                />
            )}

            {domain.verified && (
                <CertificatePanel owner={owner} domain={domain} onChanged={onChecked} onError={onError} />
            )}

            {/* Editing records takes the domain's own token: this Polaris's
                token may reach the zone, but it was never handed over for this. */}
            {domain.verified && domain.hasDnsToken && (
                <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">DNS records</h3>
                    <DnsZoneEditor scope={{ kind: "owner", ref: owner, domainId: domain.id }} />
                </div>
            )}

            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                kind="domain"
                name={domain.domain}
                requireTyping={false}
                title="Remove domain"
                question={
                    <>
                        Remove <span className="font-medium text-foreground">{domain.domain}</span>?
                    </>
                }
                description="New services stop being offered hostnames under it. Anything already deployed on one keeps its address until you change it."
                confirmLabel="Remove"
                onConfirm={() => void remove()}
            />
        </PageSection>
    );
}

/**
 * Count down to the next check and run it, while `active`. Answers the seconds
 * left, or null when it is not counting.
 */
function useRecheck(active: boolean, run: () => Promise<void>): number | null {
    const [left, setLeft] = useState<number | null>(null);
    const runRef = useRef(run);
    runRef.current = run;
    useEffect(() => {
        if (!active) {
            setLeft(null);
            return;
        }
        let remaining = RECHECK_SECONDS;
        setLeft(remaining);
        const timer = window.setInterval(() => {
            if (document.visibilityState === "hidden") return;
            remaining -= 1;
            if (remaining <= 0) {
                remaining = RECHECK_SECONDS;
                void runRef.current();
            }
            setLeft(remaining);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return left;
}

/**
 * The wildcard certificate for a verified domain: what state it is in, and the
 * DNS token it is ordered with when this Polaris's own does not reach the zone.
 */
function CertificatePanel({
    owner,
    domain,
    onChanged,
    onError
}: {
    owner: DomainOwnerRef;
    domain: OwnerDomainView;
    onChanged: (domain: OwnerDomainView) => void;
    onError: (message: string) => void;
}) {
    const format = useDisplayFormat();
    const [token, setToken] = useState("");
    const [saving, setSaving] = useState(false);
    const certificate = domain.certificate;
    // Pending with no wait set is an order that is due or running now.
    const ordering = certificate?.status === "pending" && certificate.nextAttemptAt === null;
    const changedRef = useRef(onChanged);
    changedRef.current = onChanged;

    // While an order is in flight - or about to be, for a domain proven a moment
    // ago - read the row until it lands. Only the row: the order itself runs on
    // the server whether or not this screen is open.
    const waiting = ordering || certificate === null;
    useEffect(() => {
        if (!waiting) return;
        const timer = window.setInterval(async () => {
            const result = await readOwnerDomainAction(owner, domain.id).catch(() => null);
            if (result?.domain) changedRef.current(result.domain);
        }, ORDER_POLL_MS);
        return () => window.clearInterval(timer);
    }, [waiting, owner, domain.id]);

    async function saveToken(value: string) {
        setSaving(true);
        onError("");
        const result = await runAction(() => setOwnerDomainDnsTokenAction(owner, domain.id, value), onError);
        setSaving(false);
        if (result?.domain) {
            onChanged(result.domain);
            setToken("");
        } else if (result?.error) onError(result.error);
    }

    async function retry() {
        setSaving(true);
        onError("");
        const result = await runAction(() => retryOwnerDomainCertificateAction(owner, domain.id), onError);
        setSaving(false);
        if (result?.domain) onChanged(result.domain);
        else if (result?.error) onError(result.error);
    }

    const covered = `${domain.wildcard} and ${domain.domain}`;
    const summary =
        certificate?.status === "issued" && certificate.expiresAt
            ? `Covers ${covered} until ${format.date(certificate.expiresAt)}. Renewed automatically 30 days before it expires.`
            : ordering
              ? `Ordering for ${covered}. This usually takes under a minute.`
              : `Covers ${covered} once it is issued.`;

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <h3 className="font-medium">Wildcard certificate</h3>
                {certificate?.status === "issued" ? (
                    <Badge variant="success">Issued</Badge>
                ) : certificate?.status === "failed" ? (
                    <Badge variant="danger">Not issued</Badge>
                ) : (
                    <Badge variant="neutral">{ordering ? "Ordering" : "Waiting"}</Badge>
                )}
                {ordering && <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />}
            </div>
            <p className="text-muted-foreground text-xs">{summary}</p>
            {certificate?.detail && (
                <p className="text-warning flex items-start gap-1.5 text-xs">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    <span>
                        {certificate.detail}
                        {certificate.nextAttemptAt && ` Next try ${format.dateTime(certificate.nextAttemptAt)}.`}
                    </span>
                </p>
            )}
            {certificate?.nextAttemptAt && (
                <div>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => void retry()}>
                        <RefreshCw className="size-4 shrink-0" /> Try now
                    </Button>
                </div>
            )}
            {domain.hasDnsToken ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <KeyRound className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="text-muted-foreground">Ordered with this domain&rsquo;s own Cloudflare token.</span>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => void saveToken("")}>
                        Remove token
                    </Button>
                </div>
            ) : (
                <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (token.trim()) void saveToken(token.trim());
                    }}
                >
                    <label className="text-muted-foreground flex min-w-56 flex-1 flex-col gap-1 text-xs">
                        Cloudflare API token
                        <Input
                            type="password"
                            value={token}
                            autoComplete="off"
                            placeholder="Only if the domain is in your own Cloudflare account"
                            className="h-9"
                            onChange={(event) => setToken(event.target.value)}
                        />
                    </label>
                    <Button type="submit" size="sm" variant="secondary" disabled={saving || !token.trim()}>
                        {saving && <Loader2 className="size-4 shrink-0 animate-spin" />} Save token
                    </Button>
                    <p className="text-muted-foreground w-full text-xs">
                        Needs Zone: DNS: Edit and Zone: Read on {domain.domain}. Without one, the token this Polaris has
                        connected is used when it can edit this domain.
                    </p>
                </form>
            )}
        </div>
    );
}
