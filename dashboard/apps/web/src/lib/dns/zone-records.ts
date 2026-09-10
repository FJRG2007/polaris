/**
 * Editing a zone's DNS records through Cloudflare, for two kinds of reader.
 *
 * - Whoever runs this Polaris edits any zone its connected Cloudflare token
 *   reaches - the same token the guided setup and the certificates write with.
 * - The owner of a domain they brought edits that domain's records with the
 *   token they gave it, and only names at or under that domain: the token may
 *   reach the whole zone, and the rest of the zone is not what they proved.
 *
 * Authorization is the caller's (the actions check the admin or the owner); this
 * turns a scope into the token and zone to use and refuses anything outside it.
 */

import { prisma } from "@polaris/db";
import type { DomainOwner } from "@/lib/owner-domains";
import { openText } from "@/lib/tls/managed-certificates";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import { checkPropagation, type PropagationReport, type QueryType } from "./propagation";
import {
    DNS_RECORD_TYPES,
    emptyDraft,
    isWithin,
    normalizeHostname,
    recordFields,
    relativeName,
    type DnsRecordDraft,
    type DnsRecordType,
    type DraftProblems
} from "./record-schema";
import {
    deleteDnsRecord,
    getDnsRecord,
    listDnsRecords,
    listZones,
    resolveZoneForHostname,
    saveDnsRecord,
    type CfEditableRecord
} from "@/lib/integrations/cloudflare-api";

export type DnsScope =
    | { readonly kind: "instance"; readonly zoneId: string }
    | { readonly kind: "owner"; readonly owner: DomainOwner; readonly domainId: string };

export class DnsEditError extends Error {
    constructor(
        message: string,
        readonly problems: DraftProblems = {}
    ) {
        super(message);
        this.name = "DnsEditError";
    }
}

/** Cloudflare's zone and record ids: 32 hexadecimal characters. Checked before
 *  one is put in a request path. */
const CF_ID = /^[a-f0-9]{32}$/;

interface Zone {
    readonly token: string;
    readonly id: string;
    readonly name: string;
    /** The one domain this scope may touch names under, or null for the zone. */
    readonly within: string | null;
}

async function zoneFor(scope: DnsScope): Promise<Zone> {
    if (scope.kind === "instance") {
        if (!CF_ID.test(scope.zoneId))
            throw new DnsEditError("That zone is not one this Polaris can edit");
        const token = await loadCloudflareToken();
        if (!token) throw new DnsEditError("Connect a Cloudflare token under Integrations first");
        const zone = (await listZones(token)).find((entry) => entry.id === scope.zoneId);
        if (!zone)
            throw new DnsEditError("That zone is not one this Polaris's Cloudflare token can edit");
        return { token, id: zone.id, name: zone.name, within: null };
    }
    const row = await prisma.ownerDomain.findFirst({
        where: {
            id: scope.domainId,
            ...(scope.owner.kind === "user"
                ? { userId: scope.owner.id }
                : { orgId: scope.owner.id }),
            verifiedAt: { not: null }
        },
        select: { domain: true, dnsToken: true }
    });
    if (!row) throw new DnsEditError("That domain is not one of yours, or it is not verified yet");
    const token = openText(row.dnsToken);
    if (!token) throw new DnsEditError("Add this domain's Cloudflare token first");
    const zone = await resolveZoneForHostname(token, row.domain);
    return { token, id: zone.id, name: zone.name, within: row.domain };
}

/** The owners whose proven domains count for somebody acting on a name. */
export interface TokenCaller {
    readonly isAdmin: boolean;
    readonly owners: readonly DomainOwner[];
}

/**
 * The closest domain at or above `hostname` that one of these owners has proven,
 * or null when there is none.
 */
export async function provenDomainOf(
    hostname: string,
    owners: readonly DomainOwner[]
): Promise<string | null> {
    const labels = normalizeHostname(hostname).replace(/^\*\./, "").split(".");
    const candidates = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
    if (candidates.length === 0 || owners.length === 0) return null;
    const rows = await prisma.ownerDomain.findMany({
        where: {
            domain: { in: candidates },
            verifiedAt: { not: null },
            OR: owners.map((owner) =>
                owner.kind === "user" ? { userId: owner.id } : { orgId: owner.id }
            )
        },
        select: { domain: true }
    });
    return rows.map((row) => row.domain).sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Whether the instance's connected token may write at `hostname` for this caller.
 * The same line the editor draws between its two scopes: whoever runs this Polaris
 * edits any zone the token reaches, and anybody else only names at or under a
 * domain they - or the organization they act for - have proven.
 */
export async function instanceTokenAllowed(
    hostname: string,
    caller: TokenCaller
): Promise<boolean> {
    if (caller.isAdmin) return true;
    return (await provenDomainOf(hostname, caller.owners)) !== null;
}

function inside(zone: Zone, name: string): boolean {
    return isWithin(name, zone.within ?? zone.name);
}

export interface DnsRecordView {
    readonly id: string;
    readonly type: string;
    /** The full name. */
    readonly name: string;
    /** The name within the zone, `@` for the apex. */
    readonly relative: string;
    readonly content: string;
    readonly ttl: number;
    readonly proxied: boolean;
    readonly proxiable: boolean;
    readonly priority: number | null;
    /** The record as the editor's form holds it, or null for a type it does not edit. */
    readonly draft: DnsRecordDraft | null;
}

function numberOf(value: unknown): string {
    return typeof value === "number" ? String(value) : "";
}

/** The form a stored record is edited in. */
function draftOf(record: CfEditableRecord, zone: string): DnsRecordDraft | null {
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(record.type)) return null;
    const type = record.type as DnsRecordType;
    const draft: DnsRecordDraft = {
        ...emptyDraft(type),
        name: relativeName(record.name, zone),
        ttl: String(record.ttl),
        proxied: record.proxied
    };
    switch (type) {
        case "SRV":
            return {
                ...draft,
                priority: numberOf(record.data?.priority),
                weight: numberOf(record.data?.weight),
                port: numberOf(record.data?.port),
                target: typeof record.data?.target === "string" ? record.data.target : ""
            };
        case "CAA":
            return {
                ...draft,
                flags: numberOf(record.data?.flags) || "0",
                tag: typeof record.data?.tag === "string" ? record.data.tag : "issue",
                value: typeof record.data?.value === "string" ? record.data.value : ""
            };
        case "MX":
            return {
                ...draft,
                content: record.content,
                priority: record.priority === null ? "" : String(record.priority)
            };
        default:
            return { ...draft, content: record.content };
    }
}

function viewOf(record: CfEditableRecord, zone: string): DnsRecordView {
    return {
        id: record.id,
        type: record.type,
        name: record.name,
        relative: relativeName(record.name, zone),
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
        proxiable: record.proxiable,
        priority: record.priority,
        draft: draftOf(record, zone)
    };
}

export interface ZoneRecords {
    readonly zone: { readonly id: string; readonly name: string };
    readonly within: string | null;
    readonly records: DnsRecordView[];
}

/** The zones whoever runs this Polaris can edit, for the zone picker. */
export async function editableZones(): Promise<{ id: string; name: string }[]> {
    const token = await loadCloudflareToken();
    if (!token) return [];
    return (await listZones(token)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The records of a zone this scope may see, in the form the editor reads them. */
async function scopedRecords(zone: Zone): Promise<DnsRecordView[]> {
    return (await listDnsRecords(zone.token, zone.id))
        .filter((record) => inside(zone, record.name))
        .map((record) => viewOf(record, zone.name));
}

/** A zone's records, narrowed to what this scope may see. */
export async function zoneRecords(scope: DnsScope): Promise<ZoneRecords> {
    const zone = await zoneFor(scope);
    return {
        zone: { id: zone.id, name: zone.name },
        within: zone.within,
        records: await scopedRecords(zone)
    };
}

/**
 * Add a record, or replace one, from the editor's form, answering it as the zone
 * now holds it. Checked with the schema the form checks with, against the records
 * the zone holds now rather than the ones the form last saw - a record added in
 * another tab is still a duplicate.
 */
export async function saveZoneRecord(
    scope: DnsScope,
    recordId: string | null,
    draft: DnsRecordDraft
): Promise<DnsRecordView> {
    const zone = await zoneFor(scope);
    const existing = await scopedRecords(zone);
    if (
        recordId !== null &&
        !(CF_ID.test(recordId) && existing.some((record) => record.id === recordId))
    ) {
        throw new DnsEditError("That record is not in this zone");
    }
    const checked = recordFields(draft, zone.name, {
        within: zone.within,
        existing,
        editingId: recordId
    });
    if (!checked.ok) {
        const problems = { ...checked.problems };
        for (const field of checked.missing) problems[field] ??= "Required";
        throw new DnsEditError("Check the highlighted fields", problems);
    }
    return viewOf(await saveDnsRecord(zone.token, zone.id, recordId, checked.record), zone.name);
}

/** Refuse a record id that is not in this zone, or not within this scope. */
async function requireOwnRecord(
    zone: Zone,
    recordId: string
): Promise<{ type: string; name: string }> {
    if (!CF_ID.test(recordId)) throw new DnsEditError("That record is not in this zone");
    const current = await getDnsRecord(zone.token, zone.id, recordId);
    if (!current || !inside(zone, current.name))
        throw new DnsEditError("That record is not in this zone");
    return current;
}

export async function deleteZoneRecord(scope: DnsScope, recordId: string): Promise<void> {
    const zone = await zoneFor(scope);
    await requireOwnRecord(zone, recordId);
    await deleteDnsRecord(zone.token, zone.id, recordId);
}

/** The values a resolver should give for a record once the change has reached it,
 *  in the form it gives them - or null when there is nothing to expect: a proxied
 *  record answers with Cloudflare's own addresses rather than its content. */
export function expectedValues(
    record: Pick<CfEditableRecord, "type" | "content" | "proxied" | "priority" | "data">
): string[] | null {
    if (record.proxied) return null;
    switch (record.type) {
        case "MX":
            return [`${record.priority ?? 0} ${normalizeHostname(record.content)}`];
        case "SRV":
            return [
                `${numberOf(record.data?.priority)} ${numberOf(record.data?.weight)} ${numberOf(record.data?.port)} ${normalizeHostname(String(record.data?.target ?? ""))}`
            ];
        case "CAA":
            return [
                `${numberOf(record.data?.flags) || "0"} ${String(record.data?.tag ?? "")} "${String(record.data?.value ?? "")}"`
            ];
        default:
            return [record.content];
    }
}

/**
 * Where one record has got to: every record of its type at its name, as the zone
 * holds them, against what each public resolver answers. All of them rather than
 * the one, because a resolver answers with the whole set at a name.
 */
export async function recordPropagation(
    scope: DnsScope,
    recordId: string
): Promise<PropagationReport> {
    const zone = await zoneFor(scope);
    const current = await requireOwnRecord(zone, recordId);
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(current.type)) {
        throw new DnsEditError(`Propagation is checked for ${DNS_RECORD_TYPES.join(", ")} records`);
    }
    const siblings = (await listDnsRecords(zone.token, zone.id)).filter(
        (record) =>
            record.type === current.type &&
            normalizeHostname(record.name) === normalizeHostname(current.name)
    );
    const expected = siblings.some((record) => record.proxied)
        ? null
        : siblings.flatMap((record) => expectedValues(record) ?? []);
    return checkPropagation(current.name, current.type as QueryType, expected);
}
