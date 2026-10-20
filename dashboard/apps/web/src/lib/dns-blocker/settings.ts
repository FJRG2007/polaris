/**
 * What the network ad blocker is told to do, as the operator chose it.
 *
 * Pure and client-safe: the settings screen validates against the same schema
 * the save path does, and the configuration renderer (`render.ts`) reads only
 * this shape. Stored as one JSON value on the app's install row, and read back
 * through `readDnsSettings`, which accepts anything - a row written by an older
 * screen, or by hand - and returns a whole, valid value.
 */

import { z } from "zod";

/** The app that puts the Ad blocker screen here. Runs nothing itself. */
export const DNS_BLOCKER_APP = "dns-blocker";
/** The DNS server it starts when blocking is turned on. */
export const DNS_ENGINE_APP = "dns-blocker-engine";

/** The kinds of list a source belongs to. Each is its own group in the engine,
 *  so a category is switched on or off as a whole. */
export const DNS_CATEGORIES = [
    "ads",
    "trackers",
    "malware",
    "adult",
    "gambling",
    "social"
] as const;
export type DnsCategory = (typeof DNS_CATEGORIES)[number];

/** A blocklist Polaris offers by name. */
export interface DnsListSource {
    readonly id: string;
    readonly name: string;
    readonly category: DnsCategory;
    readonly url: string;
    /** On for a fresh install. */
    readonly recommended: boolean;
}

/**
 * The lists offered without typing an address. Each address was checked to
 * answer before it was written here; all are domain lists (one name, or
 * `*.name`, per line) or hosts files, the two formats the engine reads.
 */
export const DNS_LIST_SOURCES: readonly DnsListSource[] = [
    {
        id: "hagezi-pro",
        name: "HaGeZi Pro",
        category: "ads",
        url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro-onlydomains.txt",
        recommended: true
    },
    {
        id: "stevenblack",
        name: "StevenBlack hosts",
        category: "ads",
        url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
        recommended: false
    },
    {
        id: "oisd-big",
        name: "OISD big",
        category: "ads",
        url: "https://big.oisd.nl/domainswild",
        recommended: false
    },
    {
        id: "hagezi-popupads",
        name: "HaGeZi pop-up ads",
        category: "ads",
        url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/popupads-onlydomains.txt",
        recommended: false
    },
    {
        id: "hagezi-native-windows",
        name: "HaGeZi Windows and Office telemetry",
        category: "trackers",
        url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/native.winoffice-onlydomains.txt",
        recommended: false
    },
    {
        id: "hagezi-tif",
        name: "HaGeZi threat intelligence",
        category: "malware",
        url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif-onlydomains.txt",
        recommended: true
    },
    {
        id: "hagezi-nsfw",
        name: "HaGeZi adult",
        category: "adult",
        url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw-onlydomains.txt",
        recommended: false
    },
    {
        id: "oisd-nsfw",
        name: "OISD adult",
        category: "adult",
        url: "https://nsfw.oisd.nl/domainswild",
        recommended: false
    },
    {
        id: "hagezi-gambling",
        name: "HaGeZi gambling",
        category: "gambling",
        url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/gambling-onlydomains.txt",
        recommended: false
    },
    {
        id: "hagezi-social",
        name: "HaGeZi social networks",
        category: "social",
        url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/social-onlydomains.txt",
        recommended: false
    }
];

/** A resolver the blocker forwards allowed names to. */
export interface DnsUpstreamPreset {
    readonly id: string;
    readonly name: string;
    /** In the engine's own resolver syntax: plain, `tcp-tls:` (DoT) or `https://` (DoH). */
    readonly servers: readonly string[];
    /** Plain addresses used once, to find the encrypted resolvers' own addresses. */
    readonly bootstrap: readonly string[];
}

export const DNS_UPSTREAM_PRESETS: readonly DnsUpstreamPreset[] = [
    {
        id: "cloudflare",
        name: "Cloudflare",
        servers: ["https://cloudflare-dns.com/dns-query", "tcp-tls:one.one.one.one:853"],
        bootstrap: ["1.1.1.1", "1.0.0.1"]
    },
    {
        id: "quad9",
        name: "Quad9",
        servers: ["https://dns.quad9.net/dns-query", "tcp-tls:dns.quad9.net:853"],
        bootstrap: ["9.9.9.9", "149.112.112.112"]
    },
    {
        id: "google",
        name: "Google",
        servers: ["https://dns.google/dns-query", "tcp-tls:dns.google:853"],
        bootstrap: ["8.8.8.8", "8.8.4.4"]
    },
    {
        id: "plain-cloudflare",
        name: "Cloudflare (unencrypted)",
        servers: ["1.1.1.1", "1.0.0.1"],
        bootstrap: []
    }
];

/** Ceilings that keep the rendered configuration inside one environment value. */
export const DNS_LIMITS = {
    rules: 1000,
    customLists: 30,
    records: 200,
    upstreams: 8,
    clientGroups: 20,
    devices: 200,
    forwards: 50,
    groupClients: 50,
    /** Days of lookups the engine keeps, which is as far back as the screen reads. */
    logDays: 30
} as const;

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** Lower-cased, trimmed, with a trailing dot and any scheme or path taken off,
 *  so `https://Example.com/x` and `example.com.` are the same rule. */
export function normalizeDnsName(text: string): string {
    let value = text.trim().toLowerCase();
    value = value.replace(/^[a-z]+:\/\//, "");
    value = value.split("/")[0] ?? "";
    return value.replace(/\.$/, "");
}

/** Rules are written one per line, so a rule cannot hold a line break of its own. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Constructs the engine's regular expressions (Go RE2) do not have. */
const NOT_RE2 = /\(\?[=!<]|\\[1-9]/;

/**
 * One allow or block rule, normalized, or null when it is not one.
 *
 * Three shapes, the ones the engine reads: an exact name (`ads.example.com`),
 * a name with everything under it (`*.example.com`), or a regular expression
 * between slashes (`/^ads?[0-9]*\./`).
 */
export function normalizeDnsRule(text: string): string | null {
    const trimmed = text.trim();
    if (CONTROL.test(trimmed)) return null;
    if (trimmed.length > 2 && trimmed.startsWith("/") && trimmed.endsWith("/")) {
        const body = trimmed.slice(1, -1);
        if (body.length > 253 || NOT_RE2.test(body)) return null;
        try {
            new RegExp(body);
        } catch {
            return null;
        }
        return trimmed;
    }
    const name = normalizeDnsName(trimmed);
    if (name.startsWith("*.")) return HOSTNAME.test(name.slice(2)) ? name : null;
    return HOSTNAME.test(name) ? name : null;
}

/** A resolver typed by hand, or null when the engine would not read it. */
export function normalizeUpstream(text: string): string | null {
    const value = text.trim();
    if (value.length === 0 || value.length > 253) return null;
    if (/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(value)) {
        try {
            const url = new URL(value);
            return url.protocol === "https:" ? value : null;
        } catch {
            return null;
        }
    }
    const tls = /^tcp-tls:([^\s:]+)(:(\d{1,5}))?$/i.exec(value);
    const tlsHost = tls?.[1];
    if (tlsHost) return HOSTNAME.test(tlsHost.toLowerCase()) || IPV4.test(tlsHost) ? value : null;
    const plain = /^([^\s:]+)(:(\d{1,5}))?$/.exec(value);
    if (plain?.[1] && IPV4.test(plain[1])) {
        const port = plain[3] ? Number(plain[3]) : 53;
        return port > 0 && port < 65536 ? value : null;
    }
    return null;
}

const ruleSchema = z.string().transform((value, ctx) => {
    const rule = normalizeDnsRule(value);
    if (!rule) {
        ctx.addIssue({ code: "custom", message: "invalidRule" }); // i18n-ignore a key the screen says
        return z.NEVER;
    }
    return rule;
});

const listUrlSchema = z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
        try {
            const url = new URL(value);
            return url.protocol === "https:" || url.protocol === "http:";
        } catch {
            return false;
        }
    }, "invalidUrl");

export const dnsRecordSchema = z.object({
    name: z
        .string()
        .transform((value) => normalizeDnsName(value))
        .refine((value) => HOSTNAME.test(value), "invalidName"),
    address: z
        .string()
        .trim()
        .refine(
            (value) => IPV4.test(value) || (value.includes(":") && IPV6.test(value)),
            "invalidAddress"
        )
});

/** One name pointing at another (a CNAME), answered on this network. */
export const dnsAliasSchema = z.object({
    name: z
        .string()
        .transform((value) => normalizeDnsName(value))
        .refine((value) => HOSTNAME.test(value), "invalidName"),
    target: z
        .string()
        .transform((value) => normalizeDnsName(value))
        .refine((value) => HOSTNAME.test(value), "invalidName")
});

/**
 * Who a client group holds: an address (`192.168.1.20`), a range
 * (`192.168.1.0/24`), or a device name as the router reports it, with `*` for
 * any run of characters (`kids-*`). Normalized, or null when it is none of them.
 */
export function normalizeDnsClient(text: string): string | null {
    const value = text.trim().toLowerCase();
    if (value.length === 0 || value.length > 64 || CONTROL.test(value)) return null;
    const cidr = /^([^/]+)\/(\d{1,3})$/.exec(value);
    if (cidr?.[1] && cidr[2]) {
        const bits = Number(cidr[2]);
        if (IPV4.test(cidr[1])) return bits <= 32 ? value : null;
        return cidr[1].includes(":") && IPV6.test(cidr[1]) && bits <= 128 ? value : null;
    }
    if (IPV4.test(value) || (value.includes(":") && IPV6.test(value))) return value;
    if (value === "default") return null;
    return /^[a-z0-9*](?:[a-z0-9*._-]{0,62})$/.test(value) ? value : null;
}

/** A domain answered by another server, such as the router for `home.lan`. */
export const dnsForwardSchema = z.object({
    domain: z
        .string()
        .transform((value) => normalizeDnsName(value))
        .refine((value) => HOSTNAME.test(value), "invalidName"),
    server: z
        .string()
        .transform((value) => normalizeUpstream(value) ?? "")
        .refine((value) => value !== "", "invalidUpstream")
});

/** A device named by hand: the name the log shows and a group can hold. */
export const dnsDeviceSchema = z.object({
    name: z
        .string()
        .trim()
        .toLowerCase()
        .refine((value) => /^[a-z0-9](?:[a-z0-9._-]{0,62})$/.test(value), "invalidDeviceName"),
    address: z
        .string()
        .trim()
        .toLowerCase()
        .refine(
            (value) => IPV4.test(value) || (value.includes(":") && IPV6.test(value)),
            "invalidAddress"
        )
});

const clientSchema = z.string().transform((value, ctx) => {
    const client = normalizeDnsClient(value);
    if (!client) {
        ctx.addIssue({ code: "custom", message: "invalidClient" }); // i18n-ignore a key the screen says
        return z.NEVER;
    }
    return client;
});

/** Some devices that block a different set of categories from everybody else. */
export const dnsClientGroupSchema = z.object({
    name: z.string().trim().min(1).max(40),
    clients: z.array(clientSchema).min(1).max(DNS_LIMITS.groupClients),
    categories: z.array(z.enum(DNS_CATEGORIES)).max(DNS_CATEGORIES.length)
});

export const dnsCustomListSchema = z.object({
    url: listUrlSchema,
    category: z.enum(DNS_CATEGORIES)
});

const upstreamSchema = z.string().transform((value, ctx) => {
    const upstream = normalizeUpstream(value);
    if (!upstream) {
        ctx.addIssue({ code: "custom", message: "invalidUpstream" }); // i18n-ignore a key the screen says
        return z.NEVER;
    }
    return upstream;
});

export const dnsSettingsSchema = z.object({
    /** Ids from `DNS_LIST_SOURCES` that are on. Unknown ids are dropped on read. */
    sources: z.array(z.string().max(64)).max(DNS_LIST_SOURCES.length),
    customLists: z.array(dnsCustomListSchema).max(DNS_LIMITS.customLists),
    /** Names never blocked, whatever a list says. */
    allow: z.array(ruleSchema).max(DNS_LIMITS.rules),
    /** Names always blocked, whatever a list says. */
    deny: z.array(ruleSchema).max(DNS_LIMITS.rules),
    /** A preset id, or "custom" for `customUpstreams`. */
    upstream: z.string().max(64),
    customUpstreams: z.array(upstreamSchema).max(DNS_LIMITS.upstreams),
    /** Names this network answers itself, like `nas.home`. */
    records: z.array(dnsRecordSchema).max(DNS_LIMITS.records),
    /** How often the lists are downloaded again. */
    refreshHours: z.number().int().min(1).max(168),
    /** Names that point at another name (CNAME records). */
    aliases: z.array(dnsAliasSchema).max(DNS_LIMITS.records),
    /** Devices that block other categories than the rest of the network. */
    clientGroups: z.array(dnsClientGroupSchema).max(DNS_LIMITS.clientGroups),
    /** How many days of lookups are kept. */
    logDays: z.number().int().min(1).max(DNS_LIMITS.logDays),
    /** Domains sent to another server instead of the resolvers above. */
    forwards: z.array(dnsForwardSchema).max(DNS_LIMITS.forwards),
    /** Devices named by hand, which win over a name the router reports. */
    devices: z.array(dnsDeviceSchema).max(DNS_LIMITS.devices),
    /** The router asked for device names (reverse lookups), or "" for none. */
    namesFrom: z
        .string()
        .trim()
        .refine((value) => value === "" || IPV4.test(value), "invalidAddress")
});

export type DnsSettings = z.infer<typeof dnsSettingsSchema>;
export type DnsRecord = z.infer<typeof dnsRecordSchema>;
export type DnsCustomList = z.infer<typeof dnsCustomListSchema>;
export type DnsAlias = z.infer<typeof dnsAliasSchema>;
export type DnsClientGroup = z.infer<typeof dnsClientGroupSchema>;
export type DnsDevice = z.infer<typeof dnsDeviceSchema>;
export type DnsForward = z.infer<typeof dnsForwardSchema>;

export const DEFAULT_DNS_SETTINGS: DnsSettings = {
    sources: DNS_LIST_SOURCES.filter((source) => source.recommended).map((source) => source.id),
    customLists: [],
    allow: [],
    deny: [],
    upstream: "cloudflare",
    customUpstreams: [],
    records: [],
    refreshHours: 24,
    aliases: [],
    clientGroups: [],
    logDays: 7,
    devices: [],
    forwards: [],
    namesFrom: ""
};

/**
 * Settings read back from storage, whole whatever was stored.
 *
 * Field by field: one bad field (a rule an older screen let through) falls back
 * to its default instead of throwing the operator's whole configuration away.
 */
export function readDnsSettings(raw: unknown): DnsSettings {
    const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const shape = dnsSettingsSchema.shape;
    const field = <K extends keyof DnsSettings>(key: K): DnsSettings[K] => {
        const parsed = shape[key].safeParse(value[key]);
        return parsed.success ? (parsed.data as DnsSettings[K]) : DEFAULT_DNS_SETTINGS[key];
    };
    const known = new Set(DNS_LIST_SOURCES.map((source) => source.id));
    const upstream = field("upstream");
    const customUpstreams = field("customUpstreams");
    const presetKnown = DNS_UPSTREAM_PRESETS.some((preset) => preset.id === upstream);
    return {
        sources: field("sources").filter((id) => known.has(id)),
        customLists: field("customLists"),
        allow: field("allow"),
        deny: field("deny"),
        upstream:
            presetKnown || (upstream === "custom" && customUpstreams.length > 0)
                ? upstream
                : DEFAULT_DNS_SETTINGS.upstream,
        customUpstreams,
        records: field("records"),
        refreshHours: field("refreshHours"),
        aliases: field("aliases"),
        clientGroups: field("clientGroups"),
        logDays: field("logDays"),
        devices: field("devices"),
        forwards: field("forwards"),
        namesFrom: field("namesFrom")
    };
}
