"use client";

/**
 * A zone's DNS records, edited in place, and whether each one has reached the
 * public resolvers yet.
 *
 * Each record is a card laid out the way a registrar's form asks for it - type,
 * name, value, TTL - with every value copyable, because the other half of DNS work
 * is pasting one of them somewhere else. The type sits in an inverted chip so a
 * long list reads by type at a glance.
 *
 * Used for a zone an administrator reaches through this Polaris's Cloudflare
 * token and for a domain somebody brought with a token of its own; the actions
 * decide which records each may see and touch.
 */

import { CopyButton } from "@/components/copy-button";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import type { PropagationReport } from "@/lib/dns/propagation";
import type { DnsRecordView, ZoneRecords } from "@/lib/dns/zone-records";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    deleteDnsRecordAction,
    dnsPropagationAction,
    saveDnsRecordAction,
    zoneRecordsAction,
    type DnsScopeRef
} from "@/app/(app)/account/domains/dns-actions";
import {
    AlertTriangle,
    CheckCircle2,
    CircleSlash,
    Loader2,
    Pencil,
    Plus,
    Radar,
    RefreshCw,
    Search,
    Trash2,
    XCircle
} from "lucide-react";
import {
    CAA_TAGS,
    DNS_RECORD_TYPES,
    PROXIABLE_TYPES,
    TTL_AUTO,
    absoluteName,
    emptyDraft,
    recordFields,
    type DnsRecordDraft,
    type DnsRecordType
} from "@/lib/dns/record-schema";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";

/** How long a zone's records are reused before they are read again, so switching
 *  between zones and back does not ask Cloudflare every time. Dropped on a write. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; zone: ZoneRecords }>();

/** How long a record that has not settled waits between checks, and how many
 *  checks it gets before it stops asking on its own. */
const PROPAGATION_SECONDS = 15;
const PROPAGATION_ATTEMPTS = 40;

const TTL_OPTIONS = [
    { value: String(TTL_AUTO), label: "Auto" },
    { value: "60", label: "1 min" },
    { value: "300", label: "5 min" },
    { value: "3600", label: "1 hour" },
    { value: "86400", label: "1 day" }
];

function scopeKey(scope: DnsScopeRef): string {
    return JSON.stringify(scope);
}

function ttlLabel(ttl: number): string {
    if (ttl === TTL_AUTO) return "Auto";
    return TTL_OPTIONS.find((option) => option.value === String(ttl))?.label ?? `${ttl} s`;
}

export function DnsZoneEditor({ scope }: { scope: DnsScopeRef }) {
    const key = scopeKey(scope);
    const [zone, setZone] = useState<ZoneRecords | null>(() => cache.get(key)?.zone ?? null);
    const [loading, setLoading] = useState(zone === null);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState("");
    const [editing, setEditing] = useState<{
        id: string | null;
        draft: DnsRecordDraft;
        original: string;
    } | null>(null);
    const [checking, setChecking] = useState<string | null>(null);
    const [confirm, confirmElement] = useConfirm();
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    const load = useCallback(
        async (fresh: boolean) => {
            const cached = cache.get(key);
            if (!fresh && cached && Date.now() - cached.at < CACHE_MS) {
                setZone(cached.zone);
                setLoading(false);
                return;
            }
            setLoading(true);
            const result = await zoneRecordsAction(scopeRef.current).catch(() => ({
                error: "Could not read the records",
                zone: undefined
            }));
            setLoading(false);
            if (result.zone) {
                cache.set(key, { at: Date.now(), zone: result.zone });
                setZone(result.zone);
                setError("");
            } else setError(result.error ?? "Could not read the records");
        },
        [key]
    );

    useEffect(() => {
        void load(false);
    }, [load]);

    const records = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const all = zone?.records ?? [];
        if (!needle) return all;
        return all.filter(
            (record) =>
                record.type.toLowerCase() === needle ||
                record.name.includes(needle) ||
                record.content.toLowerCase().includes(needle)
        );
    }, [zone, filter]);

    async function remove(record: DnsRecordView) {
        const ok = await confirm({
            title: `Remove the ${record.type} record for ${record.relative}?`,
            description: "Resolvers keep answering with it until their cached copy expires.",
            confirmLabel: "Remove",
            danger: true
        });
        if (!ok || !zone) return;
        // Taken off the list at once, and put back if Cloudflare refuses.
        const before = zone;
        setZone({ ...zone, records: zone.records.filter((entry) => entry.id !== record.id) });
        const result = await deleteDnsRecordAction(scope, record.id).catch(() => ({
            error: "Could not remove the record"
        }));
        if (result.error) {
            setZone(before);
            setError(result.error);
            return;
        }
        cache.delete(key);
        if (checking === record.id) setChecking(null);
    }

    function openEditor(record: DnsRecordView | null) {
        const draft = record?.draft ?? emptyDraft("A");
        setEditing({ id: record?.id ?? null, draft, original: JSON.stringify(draft) });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-48 flex-1">
                    <Search className="text-foreground-subtle pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                    <Input
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder="Filter by name, type or value"
                        aria-label="Filter records"
                        className="h-8 pl-8"
                    />
                </label>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void load(true)}
                    disabled={loading}
                    aria-label="Reload records"
                    title="Reload"
                >
                    <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                </Button>
                <Button size="sm" onClick={() => openEditor(null)} disabled={!zone}>
                    <Plus className="size-4" /> Add record
                </Button>
            </div>

            {error && (
                <p
                    role="alert"
                    className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                >
                    {error}
                </p>
            )}
            {zone?.within && (
                <p className="text-muted-foreground text-xs">
                    Showing the records at and under {zone.within}, in the {zone.zone.name} zone.
                </p>
            )}

            {loading && !zone ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    {[0, 1, 2].map((index) => (
                        <Skeleton key={index} className="h-24 w-full rounded-lg" />
                    ))}
                </div>
            ) : zone && records.length === 0 ? (
                <EmptyState
                    title={filter ? "No record matches that" : "No records yet"}
                    description={
                        filter
                            ? undefined
                            : `Add the first record for ${zone.within ?? zone.zone.name}.`
                    }
                    action={
                        filter ? undefined : (
                            <Button size="sm" onClick={() => openEditor(null)}>
                                <Plus className="size-4" /> Add record
                            </Button>
                        )
                    }
                />
            ) : zone ? (
                <div className="flex max-h-[36rem] flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
                    {records.map((record) => (
                        <RecordCard
                            key={record.id}
                            record={record}
                            checking={checking === record.id}
                            onCheck={() => setChecking(checking === record.id ? null : record.id)}
                            onEdit={() => openEditor(record)}
                            onRemove={() => void remove(record)}
                            scope={scope}
                        />
                    ))}
                </div>
            ) : null}

            {zone && editing && (
                <RecordDialog
                    zone={zone}
                    editing={editing}
                    scope={scope}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        cache.delete(key);
                        void load(true);
                    }}
                />
            )}
            {confirmElement}
        </div>
    );
}

function RecordCard({
    record,
    checking,
    onCheck,
    onEdit,
    onRemove,
    scope
}: {
    record: DnsRecordView;
    checking: boolean;
    onCheck: () => void;
    onEdit: () => void;
    onRemove: () => void;
    scope: DnsScopeRef;
}) {
    const editable = record.draft !== null;
    return (
        <div className="border-border bg-card rounded-lg border">
            <div className="flex items-start gap-2.5 px-3 pt-3">
                <span className="bg-foreground text-background mt-px shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold tracking-wide">
                    {record.type}
                </span>
                <p className="min-w-0 flex-1 truncate text-sm font-medium" title={record.name}>
                    {record.relative}
                </p>
                <div className="flex shrink-0 items-center gap-0.5">
                    {editable && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={onCheck}
                            aria-label={`Check where the ${record.type} record for ${record.relative} has reached`}
                            aria-pressed={checking}
                            title="Check propagation"
                        >
                            <Radar className="size-4" />
                        </Button>
                    )}
                    {editable && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={onEdit}
                            aria-label={`Edit the ${record.type} record for ${record.relative}`}
                            title="Edit"
                        >
                            <Pencil className="size-4" />
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onRemove}
                        aria-label={`Remove the ${record.type} record for ${record.relative}`}
                        title="Remove"
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            </div>
            <dl className="flex flex-col gap-1 px-3 py-2.5">
                <Field label="Name" value={record.name} copy />
                <Field
                    label={record.type === "MX" ? "Server" : "Value"}
                    value={record.content}
                    copy
                    wrap={record.type === "TXT"}
                />
                {record.priority !== null && record.type === "MX" && (
                    <Field label="Priority" value={String(record.priority)} />
                )}
                <Field label="TTL" value={ttlLabel(record.ttl)} muted />
                {record.proxiable && (
                    <Field
                        label="Proxy"
                        value={record.proxied ? "Proxied through Cloudflare" : "DNS only"}
                        muted
                    />
                )}
            </dl>
            {checking && <PropagationPanel scope={scope} recordId={record.id} />}
        </div>
    );
}

/** One labelled value, the way a registrar's form lays its fields out. */
function Field({
    label,
    value,
    copy,
    wrap,
    muted
}: {
    label: string;
    value: string;
    copy?: boolean;
    wrap?: boolean;
    muted?: boolean;
}) {
    return (
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2">
            <dt className="text-foreground-subtle pt-1 text-[0.6875rem] font-semibold uppercase tracking-wider">
                {label}
            </dt>
            <dd
                className={`flex min-w-0 items-start gap-2 rounded-md px-2 py-1 ${muted ? "" : "bg-surface"}`}
            >
                <code
                    className={`min-w-0 flex-1 text-xs ${muted ? "text-muted-foreground" : "text-foreground"} ${
                        wrap ? "break-all" : "truncate"
                    }`}
                    title={value}
                >
                    {value || "-"}
                </code>
                {copy && value ? (
                    <CopyButton
                        value={value}
                        label={`${label.toLowerCase()} ${value}`}
                        className="mt-0.5 shrink-0"
                    />
                ) : null}
            </dd>
        </div>
    );
}

/**
 * What each public resolver answers for a record, against what the zone holds.
 * Checks again on its own until they all agree, so a change can be watched
 * arriving instead of being refreshed for.
 */
function PropagationPanel({ scope, recordId }: { scope: DnsScopeRef; recordId: string }) {
    const format = useDisplayFormat();
    const [report, setReport] = useState<PropagationReport | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [attempts, setAttempts] = useState(0);
    const [left, setLeft] = useState(PROPAGATION_SECONDS);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    const check = useCallback(async () => {
        setBusy(true);
        const result = await dnsPropagationAction(scopeRef.current, recordId).catch(() => ({
            error: "Could not ask the resolvers",
            report: undefined
        }));
        setBusy(false);
        setAttempts((count) => count + 1);
        if (result.report) {
            setReport(result.report);
            setError("");
        } else setError(result.error ?? "Could not ask the resolvers");
    }, [recordId]);

    useEffect(() => {
        void check();
    }, [check]);

    const waiting = !busy && report !== null && !report.settled && attempts < PROPAGATION_ATTEMPTS;
    useEffect(() => {
        if (!waiting) return;
        let remaining = PROPAGATION_SECONDS;
        setLeft(remaining);
        const timer = window.setInterval(() => {
            if (document.visibilityState === "hidden") return;
            remaining -= 1;
            setLeft(remaining);
            if (remaining <= 0) {
                window.clearInterval(timer);
                void check();
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, [waiting, check]);

    return (
        <div className="border-border flex flex-col gap-2 border-t px-3 py-2.5" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">Propagation</span>
                {report?.settled ? (
                    <Badge variant="success">Every resolver agrees</Badge>
                ) : report ? (
                    <Badge variant="warning">Not everywhere yet</Badge>
                ) : null}
                <span className="text-muted-foreground">
                    {busy
                        ? "Asking the resolvers..."
                        : waiting
                          ? `Checking again in ${left}s.`
                          : report
                            ? `Checked ${format.time(report.checkedAt)}.`
                            : ""}
                </span>
                <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => void check()}
                >
                    {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <RefreshCw className="size-4" />
                    )}{" "}
                    Check now
                </Button>
            </div>
            {error && <p className="text-danger text-xs">{error}</p>}
            {report && report.expected === null && (
                <p className="text-muted-foreground text-xs">
                    Proxied through Cloudflare, so resolvers answer with Cloudflare&rsquo;s
                    addresses rather than the value here. Compared with each other instead.
                </p>
            )}
            {report && (
                <ul className="flex flex-col gap-1">
                    {report.resolvers.map((resolver) => (
                        <li
                            key={resolver.resolver}
                            className="flex flex-wrap items-start gap-2 text-xs"
                        >
                            {resolver.agrees === true ? (
                                <CheckCircle2 className="text-success mt-px size-3.5 shrink-0" />
                            ) : resolver.agrees === false ? (
                                <XCircle className="text-warning mt-px size-3.5 shrink-0" />
                            ) : (
                                <CircleSlash className="text-foreground-subtle mt-px size-3.5 shrink-0" />
                            )}
                            <span className="w-40 shrink-0">{resolver.label}</span>
                            <code className="text-muted-foreground min-w-0 flex-1 break-all">
                                {resolver.status === "unreachable"
                                    ? "Did not answer"
                                    : resolver.status === "missing"
                                      ? "No such name yet"
                                      : resolver.values.length > 0
                                        ? resolver.values.join(", ")
                                        : "No record of this type yet"}
                            </code>
                        </li>
                    ))}
                </ul>
            )}
            {!busy && report && !report.settled && attempts >= PROPAGATION_ATTEMPTS && (
                <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    Stopped checking on its own. A resolver keeps an old answer until its cached
                    copy expires, which can take as long as the old record&rsquo;s TTL.
                </p>
            )}
        </div>
    );
}

const TYPE_OPTIONS = DNS_RECORD_TYPES.map((type) => ({ value: type, label: type }));
const TAG_OPTIONS = CAA_TAGS.map((tag) => ({ value: tag, label: tag }));

function RecordDialog({
    zone,
    editing,
    scope,
    onClose,
    onSaved
}: {
    zone: ZoneRecords;
    editing: { id: string | null; draft: DnsRecordDraft; original: string };
    scope: DnsScopeRef;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [draft, setDraft] = useState(editing.draft);
    const [touched, setTouched] = useState<Set<keyof DnsRecordDraft>>(new Set());
    const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const root = zone.within ?? zone.zone.name;

    const checked = recordFields(draft, zone.zone.name);
    const problems: Record<string, string> = checked.ok ? {} : { ...checked.problems };
    // A field is complained about once it has been left, not while it is still
    // empty and nobody has reached it.
    const shown = (field: keyof DnsRecordDraft): string | undefined =>
        serverProblems[field] ?? (touched.has(field) ? problems[field] : undefined);
    const unchanged = editing.id !== null && JSON.stringify(draft) === editing.original;
    const blocked = !checked.ok || unchanged || saving;

    function set<K extends keyof DnsRecordDraft>(field: K, value: DnsRecordDraft[K]) {
        setDraft((current) => ({ ...current, [field]: value }));
        setServerProblems((current) => {
            const next = { ...current };
            delete next[field];
            return next;
        });
    }
    const leave = (field: keyof DnsRecordDraft) =>
        setTouched((current) => new Set(current).add(field));

    async function save() {
        if (blocked) {
            setTouched(new Set(Object.keys(draft) as (keyof DnsRecordDraft)[]));
            return;
        }
        setSaving(true);
        setError("");
        const result = await saveDnsRecordAction(scope, editing.id, draft).catch(() => ({
            error: "Could not save the record",
            problems: undefined
        }));
        setSaving(false);
        if (result.error) {
            setError(result.error);
            setServerProblems(result.problems ?? {});
            return;
        }
        onSaved();
    }

    const type = draft.type;
    const proxiable = PROXIABLE_TYPES.includes(type);
    const fullName = absoluteName(draft.name, zone.zone.name);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{editing.id ? "Edit record" : "Add record"}</DialogTitle>
                    <DialogDescription>
                        In {zone.zone.name}. Changes reach resolvers as their cached copies expire.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                        <FormField label="Type">
                            <Select
                                value={type}
                                disabled={editing.id !== null}
                                onValueChange={(value) => {
                                    const next = value as DnsRecordType;
                                    setDraft((current) => ({
                                        ...emptyDraft(next),
                                        name: current.name,
                                        ttl: current.ttl
                                    }));
                                    setTouched(new Set());
                                }}
                                options={TYPE_OPTIONS}
                                aria-label="Record type"
                            />
                        </FormField>
                        <FormField
                            label="Name"
                            problem={shown("name")}
                            hint={`@ for ${root} itself. Full name: ${fullName}`}
                        >
                            <Input
                                value={draft.name}
                                placeholder={type === "SRV" ? "_service._tcp" : "@ or www"}
                                aria-invalid={shown("name") ? true : undefined}
                                onChange={(event) => set("name", event.target.value)}
                                onBlur={() => leave("name")}
                            />
                        </FormField>
                    </div>

                    {(type === "A" ||
                        type === "AAAA" ||
                        type === "CNAME" ||
                        type === "TXT" ||
                        type === "MX") && (
                        <FormField
                            label={
                                type === "MX"
                                    ? "Mail server"
                                    : type === "CNAME"
                                      ? "Target"
                                      : type === "TXT"
                                        ? "Content"
                                        : "Address"
                            }
                            problem={shown("content")}
                            required
                        >
                            <Input
                                value={draft.content}
                                placeholder={
                                    type === "A"
                                        ? "203.0.113.10"
                                        : type === "AAAA"
                                          ? "2001:db8::10"
                                          : type === "TXT"
                                            ? "v=spf1 include:example.com ~all"
                                            : "host.example.com"
                                }
                                aria-invalid={shown("content") ? true : undefined}
                                onChange={(event) => set("content", event.target.value)}
                                onBlur={() => leave("content")}
                            />
                        </FormField>
                    )}

                    {type === "SRV" && (
                        <FormField label="Target" problem={shown("target")} required>
                            <Input
                                value={draft.target}
                                placeholder="host.example.com"
                                aria-invalid={shown("target") ? true : undefined}
                                onChange={(event) => set("target", event.target.value)}
                                onBlur={() => leave("target")}
                            />
                        </FormField>
                    )}

                    {(type === "MX" || type === "SRV") && (
                        <div className="grid gap-3 sm:grid-cols-3">
                            <NumberField
                                label="Priority"
                                field="priority"
                                draft={draft}
                                shown={shown}
                                set={set}
                                leave={leave}
                            />
                            {type === "SRV" && (
                                <>
                                    <NumberField
                                        label="Weight"
                                        field="weight"
                                        draft={draft}
                                        shown={shown}
                                        set={set}
                                        leave={leave}
                                    />
                                    <NumberField
                                        label="Port"
                                        field="port"
                                        draft={draft}
                                        shown={shown}
                                        set={set}
                                        leave={leave}
                                    />
                                </>
                            )}
                        </div>
                    )}

                    {type === "CAA" && (
                        <div className="grid gap-3 sm:grid-cols-[5rem_8rem_minmax(0,1fr)]">
                            <NumberField
                                label="Flags"
                                field="flags"
                                draft={draft}
                                shown={shown}
                                set={set}
                                leave={leave}
                            />
                            <FormField label="Tag" problem={shown("tag")}>
                                <Select
                                    value={draft.tag}
                                    onValueChange={(value) => set("tag", value)}
                                    options={TAG_OPTIONS}
                                    aria-label="Tag"
                                />
                            </FormField>
                            <FormField label="Value" problem={shown("value")} required>
                                <Input
                                    value={draft.value}
                                    placeholder={
                                        draft.tag === "iodef"
                                            ? "mailto:security@example.com"
                                            : "letsencrypt.org"
                                    }
                                    aria-invalid={shown("value") ? true : undefined}
                                    onChange={(event) => set("value", event.target.value)}
                                    onBlur={() => leave("value")}
                                />
                            </FormField>
                        </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                        <FormField label="TTL" problem={shown("ttl")}>
                            <Select
                                value={draft.proxied && proxiable ? String(TTL_AUTO) : draft.ttl}
                                disabled={draft.proxied && proxiable}
                                onValueChange={(value) => set("ttl", value)}
                                options={
                                    TTL_OPTIONS.some((option) => option.value === draft.ttl)
                                        ? TTL_OPTIONS
                                        : [
                                              ...TTL_OPTIONS,
                                              { value: draft.ttl, label: `${draft.ttl} s` }
                                          ]
                                }
                                aria-label="TTL"
                            />
                        </FormField>
                        {proxiable && (
                            <div className="flex flex-col gap-1.5">
                                <span className="text-muted-foreground text-xs font-medium">
                                    Proxy
                                </span>
                                <div className="flex h-8 items-center gap-2 text-sm">
                                    <Switch
                                        checked={draft.proxied}
                                        onChange={(value) => set("proxied", value)}
                                        aria-label="Proxy through Cloudflare"
                                    />
                                    {draft.proxied ? "Proxied through Cloudflare" : "DNS only"}
                                </div>
                            </div>
                        )}
                    </div>

                    {error && (
                        <p role="alert" className="text-danger text-sm">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={blocked}
                            disabled={saving || unchanged}
                        >
                            {saving && <Loader2 className="size-4 animate-spin" />}{" "}
                            {editing.id ? "Save" : "Add record"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function FormField({
    label,
    problem,
    hint,
    required,
    children
}: {
    label: string;
    problem?: string;
    hint?: string;
    required?: boolean;
    children: React.ReactNode;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted-foreground text-xs font-medium">
                {label}
                {required && <span aria-hidden="true"> *</span>}
            </span>
            {children}
            {problem ? (
                <span className="text-danger text-xs">{problem}</span>
            ) : hint ? (
                <span className="text-foreground-subtle truncate text-xs" title={hint}>
                    {hint}
                </span>
            ) : null}
        </label>
    );
}

function NumberField({
    label,
    field,
    draft,
    shown,
    set,
    leave
}: {
    label: string;
    field: "priority" | "weight" | "port" | "flags";
    draft: DnsRecordDraft;
    shown: (field: keyof DnsRecordDraft) => string | undefined;
    set: (field: "priority" | "weight" | "port" | "flags", value: string) => void;
    leave: (field: keyof DnsRecordDraft) => void;
}) {
    return (
        <FormField label={label} problem={shown(field)} required>
            <Input
                inputMode="numeric"
                value={draft[field]}
                aria-invalid={shown(field) ? true : undefined}
                onChange={(event) => set(field, event.target.value)}
                onBlur={() => leave(field)}
            />
        </FormField>
    );
}
