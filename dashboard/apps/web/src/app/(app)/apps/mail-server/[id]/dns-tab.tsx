"use client";

/**
 * The server's domains, the records each needs, and whether the world sees them.
 *
 * The records are the engine's own - its DKIM key, SPF, DMARC with reports to
 * its report mailbox, MTA-STS and TLS reporting, the service records - read from
 * the zone it publishes for each domain. "Check DNS" asks public resolvers what
 * is actually published and grades every record. "Publish with Cloudflare"
 * shows the plan first: what would be created, what would be changed and why,
 * and what is somebody else's and stays unless replacing it is asked for.
 */

import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { Field, forgetPanelData, Mono, PanelError, usePanelData, VerdictBadge } from "../ui-bits";
import { MAIL_RECORD_LABELS, mailDomainSchema, type MailRecordPurpose } from "@polaris/core";
import {
    addDomainAction,
    applyDnsAction,
    listDomainsAction,
    planDnsAction,
    removeDomainAction,
    scanDnsAction,
    setCatchAllAction,
    storedHealthAction
} from "../actions";
import {
    Badge,
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Skeleton
} from "@polaris/ui";

type Domain = Extract<Awaited<ReturnType<typeof listDomainsAction>>, { domains: unknown }>["domains"][number];
type Reports = Extract<Awaited<ReturnType<typeof scanDnsAction>>, { reports: unknown }>["reports"];
type Plan = Extract<Awaited<ReturnType<typeof planDnsAction>>, { plan: unknown }>["plan"];
type Applied = Extract<Awaited<ReturnType<typeof applyDnsAction>>, { results: unknown }>["results"];

export function DnsTab({ serverId }: { serverId: string }) {
    const format = useDisplayFormat();
    const domains = usePanelData(`domains:${serverId}`, () => listDomainsAction(serverId));
    const stored = usePanelData(`stored-health:${serverId}`, () => storedHealthAction(serverId));
    const [scan, setScan] = useState<{ reports: Reports; at: string } | null>(null);
    const [scanning, setScanning] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<Domain | null>(null);
    const [removeError, setRemoveError] = useState<string | null>(null);
    const [publishing, setPublishing] = useState<Domain | null>(null);
    const [catchAll, setCatchAll] = useState<Domain | null>(null);

    const shown = scan ?? stored.data?.dns ?? null;

    async function runScan(): Promise<void> {
        setScanning(true);
        setScanError(null);
        const answer = await scanDnsAction(serverId);
        setScanning(false);
        if (answer.error) setScanError(answer.error);
        else if ("reports" in answer) {
            setScan({ reports: answer.reports, at: answer.at });
            forgetPanelData(`stored-health:${serverId}`);
        }
    }

    async function remove(): Promise<void> {
        if (!removing) return;
        setRemoveError(null);
        const answer = await removeDomainAction({ serverId, domainId: removing.id });
        if (answer.error) {
            setRemoveError(answer.error);
            return;
        }
        setRemoving(null);
        await domains.reload();
    }

    const list = domains.data?.domains ?? [];

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {shown?.at ? `Last checked ${format.dateTime(shown.at)} against public resolvers.` : "Not checked yet."}
                </p>
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void runScan()} disabled={scanning}>
                        <RefreshCw className={scanning ? "animate-spin" : undefined} />
                        {scanning ? "Checking..." : "Check DNS"}
                    </Button>
                    <Button size="sm" onClick={() => setAdding(true)}>
                        <Plus />
                        Add domain
                    </Button>
                </div>
            </div>
            {scanError ? <PanelError message={scanError} /> : null}
            {!domains.data ? (
                domains.error ? (
                    <PanelError message={domains.error} onRetry={() => void domains.reload()} />
                ) : (
                    <Skeleton className="h-40 w-full" />
                )
            ) : list.length === 0 ? (
                <EmptyState icon={<Globe />} title="No domains" description="Add the domain this server receives mail for." />
            ) : null}
            {list.map((domain) => {
                const report = shown?.reports.find((entry) => entry.domain === domain.name) ?? null;
                return (
                    <section key={domain.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-foreground">{domain.name}</h3>
                            {domain.primary ? <Badge>First domain</Badge> : null}
                            {report ? <VerdictBadge verdict={report.verdict} /> : null}
                            <div className="ml-auto flex flex-wrap items-center gap-2">
                                <Button size="sm" variant="outline" onClick={() => setCatchAll(domain)}>
                                    {domain.catchAll ? `Catch-all: ${domain.catchAll}` : "Catch-all"}
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setPublishing(domain)}>
                                    Publish with Cloudflare
                                </Button>
                                {!domain.primary ? (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={`Remove ${domain.name}`}
                                        title={`Remove ${domain.name}`}
                                        onClick={() => setRemoving(domain)}
                                    >
                                        <Trash2 />
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                        <RecordTable domain={domain} report={report} />
                    </section>
                );
            })}
            <AddDomainDialog serverId={serverId} open={adding} onOpenChange={setAdding} onAdded={() => void domains.reload()} />
            <CatchAllDialog serverId={serverId} domain={catchAll} onClose={() => setCatchAll(null)} onSaved={() => void domains.reload()} />
            <PublishDialog serverId={serverId} domain={publishing} onClose={() => setPublishing(null)} />
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (open ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind="domain"
                requireTyping={false}
                description="The server stops receiving mail for it. Its DNS records are left as they are."
                error={removeError}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

/** The records a domain needs, graded when a check has run. */
function RecordTable({ domain, report }: { domain: Domain; report: Reports[number] | null }) {
    if (!domain.zoneFile.trim()) {
        return <p className="text-xs text-muted-foreground">The mail server has not produced this domain's records yet.</p>;
    }
    const rows = report?.records ?? null;
    if (!rows) {
        return <p className="text-xs text-muted-foreground">Run "Check DNS" to see each record and whether it is published.</p>;
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[0.8125rem]">
                <thead>
                    <tr className="text-left">
                        <th className="py-1.5 pr-3">Record</th>
                        <th className="py-1.5 pr-3">Name and value</th>
                        <th className="py-1.5 pr-3">Status</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((entry, index) => (
                        <tr key={`${entry.record.type}-${entry.record.name}-${index}`} className="align-top">
                            <td className="py-2 pr-3">
                                <div className="flex flex-col">
                                    <span className="font-mono text-xs text-foreground">{entry.record.type}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {MAIL_RECORD_LABELS[entry.record.purpose as MailRecordPurpose] ?? ""}
                                    </span>
                                </div>
                            </td>
                            <td className="max-w-md py-2 pr-3">
                                <div className="flex items-start gap-1">
                                    <Mono>{entry.record.name}</Mono>
                                    <CopyButton value={entry.record.name} />
                                </div>
                                <div className="flex items-start gap-1">
                                    <Mono className="text-muted-foreground">
                                        {entry.record.priority !== null ? `${entry.record.priority} ` : ""}
                                        {entry.record.value}
                                    </Mono>
                                    <CopyButton value={entry.record.value} />
                                </div>
                            </td>
                            <td className="py-2 pr-3">
                                <div className="flex flex-col gap-1">
                                    <VerdictBadge verdict={entry.checkable ? entry.verdict : "unverified"} />
                                    {entry.note ? <span className="text-xs text-muted-foreground">{entry.note}</span> : null}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function AddDomainDialog({
    serverId,
    open,
    onOpenChange,
    onAdded
}: {
    serverId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: () => void;
}) {
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const parsed = mailDomainSchema.safeParse({ serverId, name });
    const fieldError = !parsed.success && name.trim() ? (parsed.error.issues[0]?.message ?? null) : null;

    async function submit(): Promise<void> {
        if (!parsed.success || pending) return;
        setPending(true);
        setError(null);
        const answer = await addDomainAction(parsed.data);
        setPending(false);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        setName("");
        onOpenChange(false);
        onAdded();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(28rem,95vw)] max-w-[min(28rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>Add a domain</DialogTitle>
                    <DialogDescription>The server generates its signing key; its records appear here to publish.</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <Field label="Domain" required error={fieldError}>
                        {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder="example.org" />}
                    </Field>
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!parsed.success || pending}>
                            {pending ? "Adding..." : "Add"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function CatchAllDialog({
    serverId,
    domain,
    onClose,
    onSaved
}: {
    serverId: string;
    domain: Domain | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [address, setAddress] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [seen, setSeen] = useState<string | null>(null);
    if (domain && seen !== domain.id) {
        setSeen(domain.id);
        setAddress(domain.catchAll ?? "");
        setError(null);
    }

    async function save(value: string | null): Promise<void> {
        if (!domain) return;
        setPending(true);
        setError(null);
        const answer = await setCatchAllAction({ serverId, domainId: domain.id, address: value });
        setPending(false);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        setSeen(null);
        onClose();
        onSaved();
    }

    const unchanged = address.trim().toLowerCase() === (domain?.catchAll ?? "");
    return (
        <Dialog
            open={domain !== null}
            onOpenChange={(open) => {
                if (open) return;
                setSeen(null);
                onClose();
            }}
        >
            <DialogContent className="w-[min(28rem,95vw)] max-w-[min(28rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>Catch-all for {domain?.name}</DialogTitle>
                    <DialogDescription>Mail to an address nobody has at this domain goes here instead of bouncing.</DialogDescription>
                </DialogHeader>
                <Field label="Deliver to" hint="Catch-alls attract spam; leave empty to let unknown addresses bounce.">
                    {(id) => (
                        <Input id={id} value={address} onChange={(event) => setAddress(event.target.value)} placeholder={`you@${domain?.name ?? ""}`} />
                    )}
                </Field>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
                <DialogFooter>
                    {domain?.catchAll ? (
                        <Button type="button" variant="ghost" onClick={() => void save(null)} disabled={pending}>
                            Stop catching
                        </Button>
                    ) : null}
                    <Button type="button" onClick={() => void save(address.trim() || null)} disabled={pending || unchanged}>
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

const ACTION_LABEL: Record<Plan["records"][number]["action"], string> = {
    create: "Create",
    update: "Update",
    unchanged: "Already right",
    conflict: "Someone else's",
    skip: "Not published"
};

function PublishDialog({ serverId, domain, onClose }: { serverId: string; domain: Domain | null; onClose: () => void }) {
    const [plan, setPlan] = useState<Plan | null>(null);
    const [planning, setPlanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [replace, setReplace] = useState(false);
    const [applying, setApplying] = useState(false);
    const [results, setResults] = useState<Applied | null>(null);
    const domainId = domain?.id ?? null;

    // A fresh plan every time the dialog opens: the zone may have changed since.
    useEffect(() => {
        if (!domainId) return;
        let stale = false;
        setPlan(null);
        setResults(null);
        setReplace(false);
        setError(null);
        setPlanning(true);
        void planDnsAction({ serverId, domainId }).then((answer) => {
            if (stale) return;
            setPlanning(false);
            if (answer.error) setError(answer.error);
            else if ("plan" in answer) setPlan(answer.plan);
        });
        return () => {
            stale = true;
        };
    }, [serverId, domainId]);

    async function apply(): Promise<void> {
        if (!domain) return;
        setApplying(true);
        setError(null);
        const answer = await applyDnsAction({ serverId, domainId: domain.id, replaceConflicts: replace });
        setApplying(false);
        if (answer.error) setError(answer.error);
        else if ("results" in answer) setResults(answer.results);
    }

    const changes = plan?.records.filter((entry) => entry.action === "create" || entry.action === "update").length ?? 0;
    const conflicts = plan?.records.filter((entry) => entry.action === "conflict").length ?? 0;
    return (
        <Dialog open={domain !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="w-[min(48rem,95vw)] max-w-[min(48rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>Publish {domain?.name} with Cloudflare</DialogTitle>
                    <DialogDescription>Nothing is changed until you apply. Records that are someone else's stay unless you replace them.</DialogDescription>
                </DialogHeader>
                {planning ? <Skeleton className="h-40 w-full" /> : null}
                {error ? <PanelError message={error} /> : null}
                {plan && !results ? (
                    <div className="max-h-[50vh] overflow-auto overscroll-contain">
                        <table className="w-full text-[0.8125rem]">
                            <thead>
                                <tr className="text-left">
                                    <th className="py-1.5 pr-3">Record</th>
                                    <th className="py-1.5 pr-3">Value</th>
                                    <th className="py-1.5 pr-3">Plan</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {plan.records.map((entry, index) => (
                                    <tr key={`${entry.record.type}-${entry.record.name}-${index}`} className="align-top">
                                        <td className="py-2 pr-3">
                                            <span className="font-mono text-xs">{entry.record.type}</span>{" "}
                                            <Mono className="text-muted-foreground">{entry.record.name}</Mono>
                                        </td>
                                        <td className="max-w-xs py-2 pr-3">
                                            <Mono>{entry.value}</Mono>
                                            {entry.existing.length > 0 && entry.action !== "unchanged" ? (
                                                <p className="mt-1 text-xs text-muted-foreground">Now: {entry.existing.join(", ")}</p>
                                            ) : null}
                                        </td>
                                        <td className="py-2 pr-3">
                                            <Badge
                                                variant={
                                                    entry.action === "conflict"
                                                        ? "warning"
                                                        : entry.action === "unchanged"
                                                          ? "success"
                                                          : entry.action === "skip"
                                                            ? "neutral"
                                                            : "primary"
                                                }
                                            >
                                                {ACTION_LABEL[entry.action]}
                                            </Badge>
                                            {entry.note ? <p className="mt-1 text-xs text-muted-foreground">{entry.note}</p> : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : null}
                {results ? (
                    <ul className="flex max-h-[50vh] flex-col gap-1 overflow-auto overscroll-contain text-[0.8125rem]">
                        {results.map((result, index) => (
                            <li key={`${result.type}-${result.name}-${index}`} className="flex flex-wrap items-center gap-2">
                                <Badge
                                    variant={
                                        result.outcome === "failed"
                                            ? "danger"
                                            : result.outcome === "left"
                                              ? "neutral"
                                              : "success"
                                    }
                                >
                                    {result.outcome === "created"
                                        ? "Created"
                                        : result.outcome === "updated"
                                          ? "Updated"
                                          : result.outcome === "unchanged"
                                            ? "Already right"
                                            : result.outcome === "left"
                                              ? "Left alone"
                                              : "Failed"}
                                </Badge>
                                <span className="font-mono text-xs">{result.type}</span>
                                <Mono className="text-muted-foreground">{result.name}</Mono>
                                {result.note ? <span className="text-xs text-muted-foreground">{result.note}</span> : null}
                            </li>
                        ))}
                    </ul>
                ) : null}
                <DialogFooter className="flex-wrap items-center gap-3">
                    {plan && !results && conflicts > 0 ? (
                        <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                            <Checkbox checked={replace} onChange={(event) => setReplace(event.target.checked)} />
                            Replace the {conflicts} record{conflicts === 1 ? "" : "s"} marked someone else's
                        </label>
                    ) : null}
                    {results ? (
                        <Button type="button" onClick={onClose}>
                            Done
                        </Button>
                    ) : (
                        <Button type="button" onClick={() => void apply()} disabled={!plan || applying || (changes === 0 && !(replace && conflicts > 0))}>
                            {applying ? "Applying..." : "Apply"}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
