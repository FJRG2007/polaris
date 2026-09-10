/**
 * What a DNS record may be, written once for the editor and for the server.
 *
 * The form validates as it is typed against this, and the action validates the
 * same input against the same schema before anything reaches Cloudflare - so a
 * record the screen accepted is never refused for a reason the screen could have
 * said, and one the screen refused cannot be sent anyway. Pure: it runs in the
 * browser.
 *
 * Both sides run `normalizeDraft` first and check what it returns. Nothing is
 * patched into validity: a name with a space in it stays wrong, it is only the
 * case, the surrounding space and a final dot that are taken off.
 */

import { z } from "zod";
import { isIpAddress } from "@polaris/core";

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/** The types Cloudflare can put its proxy in front of. */
export const PROXIABLE_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];

export const CAA_TAGS = ["issue", "issuewild", "iodef"] as const;

/** Cloudflare's "Auto" TTL, and the range it takes otherwise. */
export const TTL_AUTO = 1;
export const TTL_MIN = 60;
export const TTL_MAX = 86400;

/** Cloudflare's limits on TXT content: one record, and every TXT record at one
 *  name added together. */
export const TXT_MAX = 2048;
export const TXT_NAME_MAX = 8192;

/** What the editor's form holds. Every field is a string or a flag, the way a
 *  form keeps them; `recordFields` turns them into a record. */
export interface DnsRecordDraft {
    type: DnsRecordType;
    /** `@` for the zone itself, a label under it, or the full name. */
    name: string;
    /** A, AAAA, CNAME, TXT and NS: the value. MX: the mail server. */
    content: string;
    ttl: string;
    proxied: boolean;
    priority: string;
    weight: string;
    port: string;
    /** SRV: the host the service runs on. */
    target: string;
    flags: string;
    tag: string;
    /** CAA: the certificate authority, or the address to report to. */
    value: string;
}

export function emptyDraft(type: DnsRecordType = "A"): DnsRecordDraft {
    return {
        type,
        name: "",
        content: "",
        ttl: String(TTL_AUTO),
        proxied: false,
        priority: type === "MX" ? "10" : "0",
        weight: "5",
        port: "",
        target: "",
        flags: "0",
        tag: "issue",
        value: ""
    };
}

/** A hostname as it is compared and stored: trimmed, lower case, no final dot. */
export function normalizeHostname(value: string): string {
    return value.trim().toLowerCase().replace(/\.+$/, "");
}

/** The types whose content is a hostname. */
const HOSTNAME_CONTENT: readonly DnsRecordType[] = ["CNAME", "MX", "NS"];

/** The root itself as a target: an MX that takes no mail (RFC 7505), or an SRV
 *  service that is not offered here (RFC 2782). */
export const NO_TARGET = ".";

/** A target as it is stored: a hostname normalized, or the root kept as `.`. */
function normalizeTarget(value: string): string {
    return value.trim() === NO_TARGET ? NO_TARGET : normalizeHostname(value);
}

/**
 * A draft in the form it is checked and stored in: every field trimmed, names
 * and hostnames in lower case with no final dot (a target that is only `.` stays
 * `.`), TXT text left as typed inside. The one normalizer the form (as a field is
 * left) and the server (before checking) both run.
 */
export function normalizeDraft(draft: DnsRecordDraft): DnsRecordDraft {
    const content = draft.content.trim();
    return {
        ...draft,
        name: normalizeHostname(draft.name),
        content: HOSTNAME_CONTENT.includes(draft.type)
            ? normalizeTarget(content)
            : draft.type === "TXT"
              ? content
              : content.toLowerCase(),
        ttl: draft.ttl.trim(),
        priority: draft.priority.trim(),
        weight: draft.weight.trim(),
        port: draft.port.trim(),
        target: normalizeTarget(draft.target),
        flags: draft.flags.trim(),
        tag: draft.tag.trim().toLowerCase(),
        value: draft.value.trim()
    };
}

/**
 * The full name a record lives at, from what was typed: `@` or nothing is the
 * zone itself, a bare label is under it, and a name already ending in the zone is
 * kept as it is.
 */
export function absoluteName(typed: string, zone: string): string {
    const name = normalizeHostname(typed);
    const apex = normalizeHostname(zone);
    if (name === "" || name === "@") return apex;
    if (name === apex || name.endsWith(`.${apex}`)) return name;
    return `${name}.${apex}`;
}

/** What the zone's own name is shortened to in the list, `@` for the apex. */
export function relativeName(name: string, zone: string): string {
    const full = normalizeHostname(name);
    const apex = normalizeHostname(zone);
    if (full === apex) return "@";
    return full.endsWith(`.${apex}`) ? full.slice(0, -(apex.length + 1)) : full;
}

/** Whether a full name is `root` or under it, a wildcard counting as its parent. */
export function isWithin(name: string, root: string): boolean {
    const full = normalizeHostname(name);
    const bare = full.startsWith("*.") ? full.slice(2) : full;
    const base = normalizeHostname(root);
    return bare === base || bare.endsWith(`.${base}`);
}

/** A label: letters, digits and hyphens, or an underscore label (`_dmarc`,
 *  `_sip._tcp`), or a leading `*` for a wildcard. */
const LABEL = /^(?:\*|_?[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)$/;

export function isRecordName(name: string): boolean {
    if (name.length === 0 || name.length > 253) return false;
    const labels = name.split(".");
    return labels.every((label, index) => LABEL.test(label) && (label !== "*" || index === 0));
}

/** A hostname a record may point at: no wildcard, no underscore. */
export function isTargetHostname(value: string): boolean {
    if (value.length === 0 || value.length > 253) return false;
    return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** What a CNAME may point at: a hostname, or a name with underscore labels such
 *  as a DKIM key (`selector1._domainkey.example.com`) or a certificate
 *  validation (`_x1.acm-validations.aws`). No wildcard. */
export function isAliasTarget(value: string): boolean {
    return isRecordName(value) && !value.split(".").includes("*");
}

/** The text of a TXT value: a value written quoted, or as several quoted strings
 *  side by side, is the text inside them, joined. */
export function txtText(value: string): string {
    const trimmed = value.trim();
    return /^".*"$/s.test(trimmed) ? trimmed.slice(1, -1).replace(/"\s+"/g, "") : trimmed;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const SERVICE_NAME = /^_[a-z0-9-]+\._(?:tcp|udp|tls)\./;

/** Whether text holds a line break or another control character. */
function hasControl(value: string): boolean {
    return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function integer(value: string, min: number, max: number): number | null {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return parsed >= min && parsed <= max ? parsed : null;
}

/** A CAA issue value: `;` to allow no one, or a certificate authority's domain,
 *  optionally followed by `; parameters`. */
function isCaaIssuer(value: string): boolean {
    if (value === ";") return true;
    const [domain = "", ...parameters] = value.split(";");
    return isTargetHostname(normalizeHostname(domain)) && parameters.every((part) => !hasControl(part));
}

/** A record in the shape Cloudflare's API takes it. */
export type DnsRecordFields =
    | { type: "A" | "AAAA" | "CNAME"; name: string; content: string; ttl: number; proxied: boolean }
    | { type: "TXT" | "NS"; name: string; content: string; ttl: number }
    | { type: "MX"; name: string; content: string; priority: number; ttl: number }
    | {
          type: "SRV";
          name: string;
          ttl: number;
          data: { priority: number; weight: number; port: number; target: string };
      }
    | { type: "CAA"; name: string; ttl: number; data: { flags: number; tag: string; value: string } };

/** Every field that is wrong, keyed by the field, with the sentence to show. */
export type DraftProblems = Partial<Record<keyof DnsRecordDraft, string>>;

/** A record already in the zone, as much of it as a new one is compared with. */
export interface ExistingRecord {
    readonly id: string;
    readonly type: string;
    /** The full name. */
    readonly name: string;
    readonly content: string;
    /** The record as the form holds it, or null for a type the editor does not write. */
    readonly draft: DnsRecordDraft | null;
}

/** What a record is checked against besides its own fields. */
export interface RecordChecks {
    /** The one domain names must stay at or under, or null for the whole zone. */
    readonly within?: string | null;
    /** The records already in the zone, for duplicates and CNAME exclusivity. */
    readonly existing?: readonly ExistingRecord[];
    /** The record being edited, which is not a duplicate of itself. */
    readonly editingId?: string | null;
}

/** The field a record's value is typed into, where a duplicate is reported. */
function valueField(type: DnsRecordType): keyof DnsRecordDraft {
    return type === "SRV" ? "target" : type === "CAA" ? "value" : "content";
}

/** What makes a record the record it is, beside its type and name. Priority, TTL
 *  and the proxy are settings of one record rather than a second one. */
function identityOf(draft: DnsRecordDraft): string {
    switch (draft.type) {
        case "SRV":
            return `${Number(draft.priority)} ${Number(draft.weight)} ${Number(draft.port)} ${draft.target}`;
        case "CAA":
            return `${Number(draft.flags)} ${draft.tag} ${draft.value}`;
        case "TXT":
            return txtText(draft.content);
        default:
            return draft.content;
    }
}

function existingIdentity(record: ExistingRecord): string {
    return record.draft ? identityOf(normalizeDraft(record.draft)) : record.content.trim();
}

/** The draft's shape, as a form sends it. What the server accepts from the editor. */
export const dnsRecordDraftSchema = z.object({
    type: z.enum(DNS_RECORD_TYPES),
    name: z.string().max(253, "At most 253 characters"),
    content: z.string().max(4096, `At most ${TXT_MAX} characters`),
    ttl: z.string().max(8),
    proxied: z.boolean(),
    priority: z.string().max(8, "0 to 65535"),
    weight: z.string().max(8, "0 to 65535"),
    port: z.string().max(8, "0 to 65535"),
    target: z.string().max(253, "At most 253 characters"),
    flags: z.string().max(8, "0 to 255"),
    tag: z.string().max(16),
    value: z.string().max(1024, "At most 1024 characters")
});

/**
 * The schema for a record in `zone`: the draft's shape, every rule its type has,
 * and the checks against the records already there. It expects a normalized
 * draft and parses it into the record Cloudflare takes.
 *
 * A required field that is still empty is reported with `params.missing`, so the
 * form can hold its complaint until there is something to complain about.
 */
export function dnsRecordSchema(zone: string, checks: RecordChecks = {}) {
    return dnsRecordDraftSchema
        .superRefine((draft, context) => {
            let clean = true;
            const fail = (field: keyof DnsRecordDraft, message: string) => {
                clean = false;
                context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
            };
            const need = (field: keyof DnsRecordDraft): boolean => {
                if (draft[field] !== "") return true;
                clean = false;
                context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Required", params: { missing: true } });
                return false;
            };
            const port = (field: "priority" | "weight" | "port") => {
                if (need(field) && integer(draft[field], 0, 65535) === null) fail(field, "0 to 65535");
            };

            const apex = normalizeHostname(zone);
            const name = absoluteName(draft.name, zone);
            const root = normalizeHostname(checks.within ?? zone);
            if (need("name")) {
                if (!isRecordName(name)) fail("name", "Letters, digits and hyphens, like www, or @ for the domain itself");
                else if (!isWithin(name, root)) fail("name", `Must be at or under ${root}`);
                else if (draft.type === "SRV" && !SERVICE_NAME.test(name)) {
                    fail("name", "A service record is named _service._protocol, like _minecraft._tcp");
                } else if (draft.type === "NS" && name === apex) {
                    fail("name", "The domain's own nameservers are set by Cloudflare");
                }
            }

            const proxied = PROXIABLE_TYPES.includes(draft.type) && draft.proxied;
            // A proxied record's TTL is Cloudflare's to set; it is written as Auto.
            if (!proxied && draft.ttl !== String(TTL_AUTO) && integer(draft.ttl, TTL_MIN, TTL_MAX) === null) {
                fail("ttl", `Auto, or ${TTL_MIN} to ${TTL_MAX} seconds`);
            }

            switch (draft.type) {
                case "A":
                    if (need("content") && !IPV4.test(draft.content)) fail("content", "An IPv4 address, like 203.0.113.10");
                    break;
                case "AAAA":
                    if (need("content") && !(draft.content.includes(":") && !draft.content.includes("%") && isIpAddress(draft.content))) {
                        fail("content", "An IPv6 address, like 2001:db8::10");
                    }
                    break;
                case "CNAME":
                    if (!need("content")) break;
                    if (!isAliasTarget(draft.content)) fail("content", "A hostname, like app.example.com");
                    else if (draft.content === name) fail("content", "A name cannot point at itself");
                    break;
                case "NS":
                    if (need("content") && !isTargetHostname(draft.content)) fail("content", "A nameserver's hostname, like ns1.example.com");
                    break;
                case "TXT":
                    if (!need("content")) break;
                    if (hasControl(draft.content)) fail("content", "No line breaks or control characters");
                    else if (draft.content.length > TXT_MAX) fail("content", `At most ${TXT_MAX} characters`);
                    break;
                case "MX":
                    if (need("content") && draft.content !== NO_TARGET && !isTargetHostname(draft.content)) {
                        fail("content", "The mail server's hostname, like mx.example.com");
                    }
                    port("priority");
                    break;
                case "SRV":
                    if (need("target") && draft.target !== NO_TARGET && !isTargetHostname(draft.target)) {
                        fail("target", "The hostname the service runs on");
                    }
                    port("priority");
                    port("weight");
                    port("port");
                    break;
                case "CAA":
                    if (integer(draft.flags, 0, 255) === null) fail("flags", "0 to 255");
                    if (!(CAA_TAGS as readonly string[]).includes(draft.tag)) fail("tag", "Pick one of the offered tags");
                    else if (need("value")) {
                        if (draft.tag === "iodef" && !/^(?:mailto:[^\s@]+@[^\s@]+|https?:\/\/\S+)$/.test(draft.value)) {
                            fail("value", "An address like mailto:security@example.com");
                        } else if (draft.tag !== "iodef" && !isCaaIssuer(draft.value)) {
                            fail("value", "A domain, like letsencrypt.org, or ; to allow none");
                        }
                    }
                    break;
            }

            // Compared with the zone only once the record itself is right: a
            // half-typed value matching nothing says nothing.
            if (!clean) return;
            const others = (checks.existing ?? []).filter(
                (record) => record.id !== checks.editingId && normalizeHostname(record.name) === name
            );
            const label = relativeName(name, zone);
            const alias = others.find((record) => record.type === "CNAME");
            if (draft.type === "CNAME" && others.length > 0) {
                const other = others[0]!.type;
                // Read letter by letter: "an A record", "an MX record", "a CNAME record".
                const article = /^[AEFHILMNORSX]/.test(other) ? "an" : "a";
                fail("name", `${label} already has ${article} ${other} record, and a CNAME cannot share its name`);
                return;
            }
            if (draft.type !== "CNAME" && alias) {
                fail("name", `${label} is a CNAME, which cannot share its name with other records`);
                return;
            }
            const identity = identityOf(draft);
            const sameType = others.filter((record) => record.type === draft.type);
            if (sameType.some((record) => existingIdentity(record) === identity)) {
                fail(valueField(draft.type), `This ${draft.type} record is already in the zone`);
                return;
            }
            if (draft.type === "TXT") {
                const total = sameType.reduce((sum, record) => sum + existingIdentity(record).length, identity.length);
                if (total > TXT_NAME_MAX) fail("content", `The TXT records at ${label} add up to more than ${TXT_NAME_MAX} characters`);
            }
        })
        .transform((draft): DnsRecordFields => toFields(draft, zone));
}

/** A checked draft as the record Cloudflare takes. */
function toFields(draft: DnsRecordDraft, zone: string): DnsRecordFields {
    const name = absoluteName(draft.name, zone);
    const proxied = PROXIABLE_TYPES.includes(draft.type) && draft.proxied;
    const ttl = proxied ? TTL_AUTO : Number(draft.ttl);
    switch (draft.type) {
        case "A":
        case "AAAA":
        case "CNAME":
            return { type: draft.type, name, content: draft.content, ttl, proxied };
        case "TXT":
        case "NS":
            return { type: draft.type, name, content: draft.content, ttl };
        case "MX":
            return { type: "MX", name, content: draft.content, priority: Number(draft.priority), ttl };
        case "SRV":
            return {
                type: "SRV",
                name,
                ttl,
                data: {
                    priority: Number(draft.priority),
                    weight: Number(draft.weight),
                    port: Number(draft.port),
                    target: draft.target
                }
            };
        case "CAA":
            return {
                type: "CAA",
                name,
                ttl,
                data: { flags: Number(draft.flags), tag: draft.tag, value: draft.value }
            };
    }
}

/**
 * Check a draft and, when it is right, turn it into a record for `zone`: the
 * draft is normalized and parsed with `dnsRecordSchema`, and its issues are read
 * back as one sentence per field.
 */
export function recordFields(
    draft: DnsRecordDraft,
    zone: string,
    checks: RecordChecks = {}
): { ok: true; record: DnsRecordFields } | { ok: false; problems: DraftProblems; missing: (keyof DnsRecordDraft)[] } {
    const parsed = dnsRecordSchema(zone, checks).safeParse(normalizeDraft(draft));
    if (parsed.success) return { ok: true, record: parsed.data };
    const problems: DraftProblems = {};
    const missing: (keyof DnsRecordDraft)[] = [];
    for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof DnsRecordDraft;
        if (issue.code === z.ZodIssueCode.custom && issue.params?.missing === true) {
            if (!missing.includes(field)) missing.push(field);
        } else problems[field] ??= issue.message;
    }
    return { ok: false, problems, missing };
}
