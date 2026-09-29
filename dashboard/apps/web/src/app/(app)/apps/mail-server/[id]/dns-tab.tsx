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
import { mailDomainSchema, type MailRecordPurpose } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { mailNoteText, mailSchemaText } from "@/lib/mail-server/words";
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
    const t = useTranslations("mailServer");
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
                    {shown?.at ? t("dns.lastChecked", { when: format.dateTime(shown.at) }) : t("dns.notChecked")}
                </p>
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void runScan()} disabled={scanning}>
                        <RefreshCw className={scanning ? "animate-spin" : undefined} />
                        {scanning ? t("dns.checking") : t("dns.check")}
                    </Button>
                    <Button size="sm" onClick={() => setAdding(true)}>
                        <Plus />
                        {t("dns.addDomain")}
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
                <EmptyState icon={<Globe />} title={t("dns.noDomains")} description={t("dns.noDomainsBody")} />
            ) : null}
            {list.map((domain) => {
                const report = shown?.reports.find((entry) => entry.domain === domain.name) ?? null;
                return (
                    <section key={domain.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-foreground">{domain.name}</h3>
                            {domain.primary ? <Badge>{t("dns.firstDomain")}</Badge> : null}
                            {report ? <VerdictBadge verdict={report.verdict} /> : null}
                            <div className="ml-auto flex flex-wrap items-center gap-2">
                                <Button size="sm" variant="outline" onClick={() => setCatchAll(domain)}>
                                    {domain.catchAll ? t("dns.catchAllTo", { address: domain.catchAll }) : t("dns.catchAll")}
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setPublishing(domain)}>
                                    {t("dns.publish")}
                                </Button>
                                {!domain.primary ? (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("dns.removeNamed", { name: domain.name })}
                                        title={t("dns.removeNamed", { name: domain.name })}
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
                kind={t("dns.kind")}
                requireTyping={false}
                description={t("dns.removeBody")}
                error={removeError}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

/** The records a domain needs, graded when a check has run. */
function RecordTable({ domain, report }: { domain: Domain; report: Reports[number] | null }) {
    const t = useTranslations("mailServer");
    if (!domain.zoneFile.trim()) {
        return <p className="text-xs text-muted-foreground">{t("dns.noRecords")}</p>;
    }
    const rows = report?.records ?? null;
    if (!rows) {
        return <p className="text-xs text-muted-foreground">{t("dns.runCheck")}</p>;
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[0.8125rem]">
                <thead>
                    <tr className="text-left">
                        <th className="py-1.5 pr-3">{t("dns.columns.record")}</th>
                        <th className="py-1.5 pr-3">{t("dns.columns.nameValue")}</th>
                        <th className="py-1.5 pr-3">{t("dns.columns.status")}</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((entry, index) => (
                        <tr key={`${entry.record.type}-${entry.record.name}-${index}`} className="align-top">
                            <td className="py-2 pr-3">
                                <div className="flex flex-col">
                                    <span className="font-mono text-xs text-foreground">{entry.record.type}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {purposeLabel(t, entry.record.purpose)}
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
                                    {entry.note ? <span className="text-xs text-muted-foreground">{mailNoteText(t, entry.note)}</span> : null}
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
    const t = useTranslations("mailServer");
    const tcommon = useTranslations("common");
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const parsed = mailDomainSchema.safeParse({ serverId, name });
    const fieldError = !parsed.success && name.trim() ? mailSchemaText(t, parsed.error.issues[0]?.message) : null;

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
                    <DialogTitle>{t("dns.addTitle")}</DialogTitle>
                    <DialogDescription>{t("dns.addBody")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <Field label={t("dns.domain")} required error={fieldError}>
                        {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder="example.org" />}
                    </Field>
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {tcommon("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={!parsed.success || pending}>
                            {pending ? t("dns.adding") : t("dns.add")}
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
    const t = useTranslations("mailServer");
    const tcommon = useTranslations("common");
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
                    <DialogTitle>{t("dns.catchAllTitle", { domain: domain?.name ?? "" })}</DialogTitle>
                    <DialogDescription>{t("dns.catchAllBody")}</DialogDescription>
                </DialogHeader>
                <Field label={t("dns.deliverTo")} hint={t("dns.catchAllHint")}>
                    {(id) => (
                        <Input id={id} value={address} onChange={(event) => setAddress(event.target.value)} placeholder={t("dns.catchAllPlaceholder", { domain: domain?.name ?? "" })} />
                    )}
                </Field>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
                <DialogFooter>
                    {domain?.catchAll ? (
                        <Button type="button" variant="ghost" onClick={() => void save(null)} disabled={pending}>
                            {t("dns.stopCatching")}
                        </Button>
                    ) : null}
                    <Button type="button" onClick={() => void save(address.trim() || null)} disabled={pending || unchanged}>
                        {tcommon("actions.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** What a record is for, in the reader's words. */
function purposeLabel(t: NamespaceTranslator<"mailServer">, purpose: string): string {
    const key = purpose === "mta-sts" ? "mtaSts" : purpose === "tls-rpt" ? "tlsRpt" : purpose;
    return PURPOSES.has(purpose as MailRecordPurpose) ? t(`dns.purposes.${key}` as NamespaceKey<"mailServer">) : "";
}

const PURPOSES = new Set<MailRecordPurpose>([
    "mx",
    "spf",
    "dkim",
    "dmarc",
    "mta-sts",
    "tls-rpt",
    "service",
    "autoconfig",
    "caa",
    "tlsa",
    "address",
    "other"
]);

function PublishDialog({ serverId, domain, onClose }: { serverId: string; domain: Domain | null; onClose: () => void }) {
    const t = useTranslations("mailServer");
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
                    <DialogTitle>{t("dns.publishTitle", { domain: domain?.name ?? "" })}</DialogTitle>
                    <DialogDescription>{t("dns.publishBody")}</DialogDescription>
                </DialogHeader>
                {planning ? <Skeleton className="h-40 w-full" /> : null}
                {error ? <PanelError message={error} /> : null}
                {plan && !results ? (
                    <div className="max-h-[50vh] overflow-auto overscroll-contain">
                        <table className="w-full text-[0.8125rem]">
                            <thead>
                                <tr className="text-left">
                                    <th className="py-1.5 pr-3">{t("dns.columns.record")}</th>
                                    <th className="py-1.5 pr-3">{t("dns.columns.value")}</th>
                                    <th className="py-1.5 pr-3">{t("dns.columns.plan")}</th>
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
                                                <p className="mt-1 text-xs text-muted-foreground">{t("dns.now", { values: entry.existing.join(", ") })}</p>
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
                                                {t(`dns.plan.${entry.action}`)}
                                            </Badge>
                                            {entry.note ? <p className="mt-1 text-xs text-muted-foreground">{mailNoteText(t, entry.note)}</p> : null}
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
                                    {t(`dns.outcomes.${result.outcome}`)}
                                </Badge>
                                <span className="font-mono text-xs">{result.type}</span>
                                <Mono className="text-muted-foreground">{result.name}</Mono>
                                {result.note ? <span className="text-xs text-muted-foreground">{mailNoteText(t, result.note)}</span> : null}
                            </li>
                        ))}
                    </ul>
                ) : null}
                <DialogFooter className="flex-wrap items-center gap-3">
                    {plan && !results && conflicts > 0 ? (
                        <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                            <Checkbox checked={replace} onChange={(event) => setReplace(event.target.checked)} />
                            {t("dns.replace", { count: conflicts })}
                        </label>
                    ) : null}
                    {results ? (
                        <Button type="button" onClick={onClose}>
                            {t("dns.done")}
                        </Button>
                    ) : (
                        <Button type="button" onClick={() => void apply()} disabled={!plan || applying || (changes === 0 && !(replace && conflicts > 0))}>
                            {applying ? t("dns.applying") : t("dns.apply")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
