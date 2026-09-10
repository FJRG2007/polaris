/**
 * What a DNS record may be, written once for the editor and for the server.
 *
 * The form validates as it is typed against this, and the action validates the
 * same input against the same schema before anything reaches Cloudflare - so a
 * record the screen accepted is never refused for a reason the screen could have
 * said, and one the screen refused cannot be sent anyway. Pure: it runs in the
 * browser.
 */

import { z } from "zod";
import { isIpAddress } from "@polaris/core";

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/** The types Cloudflare can put its proxy in front of. */
export const PROXIABLE_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];

export const CAA_TAGS = ["issue", "issuewild", "iodef"] as const;

/** Cloudflare's "Auto" TTL, and the range it takes otherwise. */
export const TTL_AUTO = 1;
export const TTL_MIN = 60;
export const TTL_MAX = 86400;

/** What the editor's form holds. Every field is a string or a flag, the way a
 *  form keeps them; `recordFields` turns them into a record. */
export interface DnsRecordDraft {
    type: DnsRecordType;
    /** `@` for the zone itself, a label under it, or the full name. */
    name: string;
    /** A, AAAA, CNAME and TXT: the value. MX: the mail server. */
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

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function integer(value: string, min: number, max: number): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const parsed = Number(value.trim());
    return parsed >= min && parsed <= max ? parsed : null;
}

/** A record in the shape Cloudflare's API takes it. */
export type DnsRecordFields =
    | { type: "A" | "AAAA" | "CNAME"; name: string; content: string; ttl: number; proxied: boolean }
    | { type: "TXT"; name: string; content: string; ttl: number }
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

/**
 * Check a draft and, when it is right, turn it into a record for `zone`.
 *
 * A field nobody has filled in yet is reported as missing rather than wrong, so
 * the form can hold its complaint until there is something to complain about.
 */
export function recordFields(
    draft: DnsRecordDraft,
    zone: string
): { ok: true; record: DnsRecordFields } | { ok: false; problems: DraftProblems; missing: (keyof DnsRecordDraft)[] } {
    const problems: DraftProblems = {};
    const missing: (keyof DnsRecordDraft)[] = [];
    const need = (field: keyof DnsRecordDraft, value: string): boolean => {
        if (value.trim() !== "") return true;
        missing.push(field);
        return false;
    };

    if (!DNS_RECORD_TYPES.includes(draft.type)) problems.type = "Pick one of the offered types";
    const name = absoluteName(draft.name, zone);
    if (!isRecordName(name)) problems.name = "Use letters, digits and hyphens, like www or @ for the domain itself";
    if (draft.type === "SRV" && !/^_[a-z0-9-]+\._(?:tcp|udp|tls)\./.test(name)) {
        problems.name = "A service record is named _service._protocol, like _minecraft._tcp";
    }

    const proxiable = PROXIABLE_TYPES.includes(draft.type);
    const proxied = proxiable && draft.proxied;
    // A proxied record's TTL is Cloudflare's to set; it is written as Auto.
    const ttl = proxied ? TTL_AUTO : Number(draft.ttl.trim());
    if (!proxied && ttl !== TTL_AUTO && integer(draft.ttl, TTL_MIN, TTL_MAX) === null) {
        problems.ttl = `Auto, or ${TTL_MIN} to ${TTL_MAX} seconds`;
    }

    const content = draft.type === "TXT" ? draft.content.trim() : normalizeHostname(draft.content);
    switch (draft.type) {
        case "A":
            if (need("content", draft.content) && !IPV4.test(content)) problems.content = "An IPv4 address, like 203.0.113.10";
            break;
        case "AAAA":
            if (need("content", draft.content) && !(content.includes(":") && isIpAddress(content))) {
                problems.content = "An IPv6 address, like 2001:db8::10";
            }
            break;
        case "CNAME":
            if (need("content", draft.content) && !isTargetHostname(content)) {
                problems.content = "A hostname, like app.example.com";
            } else if (content === name) problems.content = "A name cannot point at itself";
            break;
        case "TXT":
            if (need("content", draft.content) && content.length > 4096) problems.content = "At most 4096 characters";
            break;
        case "MX":
            if (need("content", draft.content) && !isTargetHostname(content)) {
                problems.content = "The mail server's hostname, like mx.example.com";
            }
            if (need("priority", draft.priority) && integer(draft.priority, 0, 65535) === null) {
                problems.priority = "0 to 65535";
            }
            break;
        case "SRV":
            if (need("target", draft.target) && !isTargetHostname(normalizeHostname(draft.target))) {
                problems.target = "The hostname the service runs on";
            }
            for (const field of ["priority", "weight", "port"] as const) {
                if (need(field, draft[field]) && integer(draft[field], 0, 65535) === null) problems[field] = "0 to 65535";
            }
            break;
        case "CAA":
            if (integer(draft.flags, 0, 255) === null) problems.flags = "0 to 255";
            if (!(CAA_TAGS as readonly string[]).includes(draft.tag)) problems.tag = "Pick one of the offered tags";
            if (need("value", draft.value) && /\s/.test(draft.value.trim())) {
                problems.value = draft.tag === "iodef" ? "An address like mailto:security@example.com" : "A domain, like letsencrypt.org";
            }
            break;
    }

    if (Object.keys(problems).length > 0 || missing.length > 0) return { ok: false, problems, missing };

    switch (draft.type) {
        case "A":
        case "AAAA":
        case "CNAME":
            return { ok: true, record: { type: draft.type, name, content, ttl, proxied } };
        case "TXT":
            return { ok: true, record: { type: "TXT", name, content, ttl } };
        case "MX":
            return { ok: true, record: { type: "MX", name, content, priority: Number(draft.priority), ttl } };
        case "SRV":
            return {
                ok: true,
                record: {
                    type: "SRV",
                    name,
                    ttl,
                    data: {
                        priority: Number(draft.priority),
                        weight: Number(draft.weight),
                        port: Number(draft.port),
                        target: normalizeHostname(draft.target)
                    }
                }
            };
        case "CAA":
            return {
                ok: true,
                record: {
                    type: "CAA",
                    name,
                    ttl,
                    data: { flags: Number(draft.flags), tag: draft.tag, value: draft.value.trim() }
                }
            };
    }
}

/** What the server accepts from the editor: a draft, in the shape a form sends. */
export const dnsRecordDraftSchema = z.object({
    type: z.enum(DNS_RECORD_TYPES),
    name: z.string().max(253),
    content: z.string().max(4096),
    ttl: z.string().max(8),
    proxied: z.boolean(),
    priority: z.string().max(8),
    weight: z.string().max(8),
    port: z.string().max(8),
    target: z.string().max(253),
    flags: z.string().max(8),
    tag: z.string().max(16),
    value: z.string().max(1024)
});
