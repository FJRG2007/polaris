"use client";

/**
 * Adding a record, or changing one, in a dialog over the records table.
 *
 * Every field is checked as it is typed, with the schema the server checks with
 * and against the records already in the zone - so an address that is not one,
 * a second copy of a record, or a CNAME beside another record is said here, in
 * the field it is about, instead of coming back from Cloudflare. A field still
 * empty is incomplete rather than wrong: it carries a `*` and holds the button,
 * and only says "Required" once somebody has tried to save without it.
 *
 * Leaving a field puts it in the form it is stored in (`normalizeDraft`), so
 * what is on screen is what is saved.
 *
 * It does not write: saving hands the checked record to the editor, which puts
 * it in the table at once and sends it. A refusal reopens this with the reason.
 */

import * as dns from "@/lib/dns/record-schema";
import { useState, type ReactNode } from "react";
import { ttlLabel } from "@/lib/dns/records-view";
import type { ZoneRecords } from "@/lib/dns/zone-records";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch
} from "@polaris/ui";

/** What the dialog opens with: the record being changed (null for a new one), the
 *  draft, and - when a save was refused - why. */
export interface RecordEditing {
    readonly id: string | null;
    readonly draft: dns.DnsRecordDraft;
    /** The draft as it was loaded, so an unchanged edit is not offered a save. */
    readonly original: string;
    readonly error?: string;
    readonly problems?: Record<string, string>;
}

const TTL_OPTIONS = [String(dns.TTL_AUTO), "60", "300", "3600", "86400"].map((value) => ({
    value,
    label: ttlLabel(Number(value))
}));
const TYPE_OPTIONS = dns.DNS_RECORD_TYPES.map((type) => ({ value: type, label: type }));
const TAG_OPTIONS = dns.CAA_TAGS.map((tag) => ({ value: tag, label: tag }));

type NumberKey = "priority" | "weight" | "port" | "flags";

const CONTENT_LABELS: Partial<Record<dns.DnsRecordType, string>> = {
    A: "IPv4 address",
    AAAA: "IPv6 address",
    CNAME: "Target",
    TXT: "Content",
    MX: "Mail server",
    NS: "Nameserver"
};

const CONTENT_PLACEHOLDERS: Partial<Record<dns.DnsRecordType, string>> = {
    A: "203.0.113.10",
    AAAA: "2001:db8::10",
    CNAME: "app.example.com",
    TXT: "v=spf1 include:example.com ~all",
    MX: "mx.example.com",
    NS: "ns1.example.com"
};

export function DnsRecordDialog({
    zone,
    editing,
    onClose,
    onSubmit
}: {
    zone: ZoneRecords;
    editing: RecordEditing;
    onClose: () => void;
    /** A record the schema accepted: the draft as typed, and the record it makes. */
    onSubmit: (draft: dns.DnsRecordDraft, record: dns.DnsRecordFields) => void;
}) {
    const [draft, setDraft] = useState(editing.draft);
    const [attempted, setAttempted] = useState(Boolean(editing.error));
    const [serverProblems, setServerProblems] = useState<Record<string, string>>(editing.problems ?? {});
    const apex = zone.zone.name;

    const checked = dns.recordFields(draft, apex, { within: zone.within, existing: zone.records, editingId: editing.id });
    const problems: Record<string, string> = checked.ok ? {} : { ...checked.problems };
    const missing = new Set<string>(checked.ok ? [] : checked.missing);
    const shown = (field: keyof dns.DnsRecordDraft): string | undefined =>
        serverProblems[field] ?? problems[field] ?? (attempted && missing.has(field) ? "Required" : undefined);
    const unchanged = editing.id !== null && JSON.stringify(dns.normalizeDraft(draft)) === editing.original;
    const blocked = !checked.ok || unchanged;

    function set<K extends keyof dns.DnsRecordDraft>(field: K, value: dns.DnsRecordDraft[K]) {
        setDraft((current) => ({ ...current, [field]: value }));
        setServerProblems((current) => {
            const next = { ...current };
            delete next[field];
            return next;
        });
    }
    /** A field left is put in its stored form. */
    const leave = (field: keyof dns.DnsRecordDraft) =>
        setDraft((current) => ({ ...current, [field]: dns.normalizeDraft(current)[field] }));

    function save() {
        if (!checked.ok) {
            setAttempted(true);
            return;
        }
        if (unchanged) return;
        onSubmit(draft, checked.record);
    }

    const type = draft.type;
    const proxiable = dns.PROXIABLE_TYPES.includes(type);
    const field = (key: keyof dns.DnsRecordDraft, placeholder: string, extra?: { inputMode?: "numeric" }) => (
        <Input
            value={String(draft[key])}
            placeholder={placeholder}
            inputMode={extra?.inputMode}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={shown(key) ? true : undefined}
            onChange={(event) => set(key, event.target.value)}
            onBlur={() => leave(key)}
        />
    );
    const numberField = (key: NumberKey, label: string) => (
        <FormField label={label} problem={shown(key)} required>
            {field(key, "0", { inputMode: "numeric" })}
        </FormField>
    );

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{editing.id ? "Edit record" : "Add record"}</DialogTitle>
                    <DialogDescription>
                        In {apex}. Changes reach resolvers as their cached copies expire.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    noValidate
                    onSubmit={(event) => {
                        event.preventDefault();
                        save();
                    }}
                >
                    <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                        <FormField label="Type">
                            <Select
                                value={type}
                                disabled={editing.id !== null}
                                onValueChange={(value) => {
                                    const next = value as dns.DnsRecordType;
                                    setDraft((current) => ({ ...dns.emptyDraft(next), name: current.name, ttl: current.ttl }));
                                    setAttempted(false);
                                    setServerProblems({});
                                }}
                                options={TYPE_OPTIONS}
                                aria-label="Record type"
                            />
                        </FormField>
                        <FormField
                            label="Name"
                            required
                            problem={shown("name")}
                            hint={
                                draft.name.trim()
                                    ? `Full name: ${dns.absoluteName(draft.name, apex)}`
                                    : `@ for ${apex} itself`
                            }
                        >
                            {field("name", type === "SRV" ? "_service._tcp" : "@ or www")}
                        </FormField>
                    </div>

                    {CONTENT_LABELS[type] && (
                        <FormField label={CONTENT_LABELS[type]!} problem={shown("content")} required>
                            {field("content", CONTENT_PLACEHOLDERS[type] ?? "")}
                        </FormField>
                    )}

                    {type === "SRV" && (
                        <FormField label="Target" problem={shown("target")} required>
                            {field("target", "host.example.com")}
                        </FormField>
                    )}

                    {(type === "MX" || type === "SRV") && (
                        <div className="grid gap-3 sm:grid-cols-3">
                            {numberField("priority", "Priority")}
                            {type === "SRV" && numberField("weight", "Weight")}
                            {type === "SRV" && numberField("port", "Port")}
                        </div>
                    )}

                    {type === "CAA" && (
                        <div className="grid gap-3 sm:grid-cols-[5rem_8rem_minmax(0,1fr)]">
                            {numberField("flags", "Flags")}
                            <FormField label="Tag" problem={shown("tag")}>
                                <Select
                                    value={draft.tag}
                                    onValueChange={(value) => set("tag", value)}
                                    options={TAG_OPTIONS}
                                    aria-label="Tag"
                                />
                            </FormField>
                            <FormField label="Value" problem={shown("value")} required>
                                {field("value", draft.tag === "iodef" ? "mailto:security@example.com" : "letsencrypt.org")}
                            </FormField>
                        </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                        <FormField label="TTL" problem={shown("ttl")}>
                            <Select
                                value={draft.proxied && proxiable ? String(dns.TTL_AUTO) : draft.ttl}
                                disabled={draft.proxied && proxiable}
                                onValueChange={(value) => set("ttl", value)}
                                options={
                                    TTL_OPTIONS.some((option) => option.value === draft.ttl)
                                        ? TTL_OPTIONS
                                        : [...TTL_OPTIONS, { value: draft.ttl, label: ttlLabel(Number(draft.ttl)) }]
                                }
                                aria-label="TTL"
                            />
                        </FormField>
                        {proxiable && (
                            <div className="flex flex-col gap-1.5">
                                <span className="text-xs font-medium text-muted-foreground">Proxy status</span>
                                <div className="flex h-8 items-center gap-2 text-sm">
                                    <Switch
                                        checked={draft.proxied}
                                        onChange={(value) => set("proxied", value)}
                                        aria-label="Proxy through Cloudflare"
                                    />
                                    {draft.proxied ? "Proxied" : "DNS only"}
                                </div>
                            </div>
                        )}
                    </div>

                    {editing.error && (
                        <p role="alert" className="text-sm text-danger">
                            {editing.error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" aria-disabled={blocked} disabled={unchanged}>
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
    children: ReactNode;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
                {label}
                {required && <span aria-hidden="true"> *</span>}
            </span>
            {children}
            {problem ? (
                <span className="text-xs text-danger">{problem}</span>
            ) : hint ? (
                <span className="truncate text-xs text-foreground-subtle" title={hint}>
                    {hint}
                </span>
            ) : null}
        </label>
    );
}
