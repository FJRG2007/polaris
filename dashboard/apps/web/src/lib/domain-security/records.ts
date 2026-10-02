/**
 * Reading the records a domain's mail security is published in: SPF (RFC 7208),
 * DMARC (RFC 7489), DKIM keys (RFC 6376), an MTA-STS policy (RFC 8461) and a
 * security.txt (RFC 9116). Pure: each takes the text a resolver or a server gave
 * and answers what it says, or exactly what is wrong with it.
 */

// ---------------------------------------------------------------------------
// Tag lists (DMARC, DKIM, MTA-STS and TLS-RPT TXT records)
// ---------------------------------------------------------------------------

/** `k=v; k=v` as a map, keys lower case, or null when a part is not a tag. */
export function parseTags(text: string): Map<string, string> | null {
    const tags = new Map<string, string>();
    for (const part of text.split(";")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const at = trimmed.indexOf("=");
        if (at <= 0) return null;
        const key = trimmed.slice(0, at).trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]*$/.test(key)) return null;
        // The first one wins, as receivers read it.
        if (!tags.has(key)) tags.set(key, trimmed.slice(at + 1).trim());
    }
    return tags;
}

// ---------------------------------------------------------------------------
// SPF
// ---------------------------------------------------------------------------

export type SpfQualifier = "+" | "-" | "~" | "?";

export interface SpfTerm {
    readonly qualifier: SpfQualifier;
    readonly mechanism: "all" | "include" | "a" | "mx" | "ptr" | "ip4" | "ip6" | "exists";
    /** The domain or address after the colon, without the CIDR length. */
    readonly value: string | null;
}

export type SpfParse =
    | { readonly ok: true; readonly terms: readonly SpfTerm[]; readonly redirect: string | null; readonly all: SpfQualifier | null }
    | { readonly ok: false; readonly bad: string };

/** Whether a TXT string is an SPF record at all: the version, then a space or nothing. */
export function isSpf(text: string): boolean {
    return /^v=spf1(\s|$)/i.test(text.trim());
}

const MECHANISM = /^([+\-~?]?)(all|include|a|mx|ptr|ip4|ip6|exists)(?::([^/\s]+))?(\/\/?\d{1,3}(?:\/\/\d{1,3})?)?$/i;
const MODIFIER = /^([a-z][a-z0-9_.-]*)=(\S*)$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** Mechanisms that take a domain after a colon, and the ones that must. */
const NEEDS_DOMAIN = new Set(["include", "exists"]);
const TAKES_DOMAIN = new Set(["include", "exists", "a", "mx", "ptr"]);

export function parseSpf(record: string): SpfParse {
    const [version, ...parts] = record.trim().split(/\s+/);
    if (!version || version.toLowerCase() !== "v=spf1") return { ok: false, bad: version ?? "" };
    const terms: SpfTerm[] = [];
    let redirect: string | null = null;
    let all: SpfQualifier | null = null;
    for (const part of parts) {
        const mechanism = MECHANISM.exec(part);
        if (mechanism) {
            const name = mechanism[2]!.toLowerCase() as SpfTerm["mechanism"];
            const value = mechanism[3] ?? null;
            const qualifier = (mechanism[1] || "+") as SpfQualifier;
            if (name === "all" && (value !== null || mechanism[4])) return { ok: false, bad: part };
            if (NEEDS_DOMAIN.has(name) && !value) return { ok: false, bad: part };
            if (value && TAKES_DOMAIN.has(name) && !/^[a-z0-9%{}_.+-]+$/i.test(value)) return { ok: false, bad: part };
            if (name === "ip4" && !(value && IPV4.test(value))) return { ok: false, bad: part };
            if (name === "ip6" && !(value && value.includes(":"))) return { ok: false, bad: part };
            terms.push({ qualifier, mechanism: name, value });
            if (name === "all") all = qualifier;
            continue;
        }
        const modifier = MODIFIER.exec(part);
        if (modifier) {
            if (modifier[1]!.toLowerCase() === "redirect") {
                if (!modifier[2]) return { ok: false, bad: part };
                redirect = modifier[2];
            }
            // exp= and unknown modifiers are allowed and ignored (RFC 7208 6).
            continue;
        }
        return { ok: false, bad: part };
    }
    return { ok: true, terms, redirect, all };
}

/** Whether a parsed SPF lets anybody send at all, beside an `all` that says so. */
export function spfAuthorizesSenders(spf: Extract<SpfParse, { ok: true }>): boolean {
    return spf.redirect !== null || spf.terms.some((term) => term.mechanism !== "all");
}

/** What one name's SPF walk found: RFC 7208 4.6.4 counts these against limits. */
export interface SpfWalk {
    /** Mechanisms and modifiers that cost a DNS lookup, including nested ones. */
    readonly lookups: number;
    /** Lookups that found nothing (no such name, or no answer). */
    readonly voids: number;
    /** Includes (or a redirect) whose target publishes no SPF: a permanent error. */
    readonly missing: readonly string[];
    /** A nested record that does not parse. */
    readonly broken: readonly string[];
}

/** What the walk asks DNS. Injected, so the walk is tested without a network. */
export interface SpfResolver {
    /** The TXT strings at a name; [] when the name has none or does not exist. */
    txt(name: string): Promise<string[]>;
    /** Whether a name has any address (A or AAAA) - or, for `mx`, any MX. */
    exists(name: string, kind: "a" | "mx"): Promise<boolean>;
}

/** Past this many lookups the walk stops asking; ten is already a failure. */
const WALK_BUDGET = 20;

/**
 * Count the lookups an SPF costs, following includes and redirects. Bounded: it
 * stops after `WALK_BUDGET` lookups, never visits a name twice (a loop is just
 * more lookups), and a resolver failure counts as nothing found.
 */
export async function walkSpf(domain: string, spf: Extract<SpfParse, { ok: true }>, resolver: SpfResolver): Promise<SpfWalk> {
    let lookups = 0;
    let voids = 0;
    const missing: string[] = [];
    const broken: string[] = [];
    const visited = new Set<string>([domain.toLowerCase()]);

    async function visit(name: string, record: Extract<SpfParse, { ok: true }>): Promise<void> {
        const steps: { kind: "include" | "a" | "mx" | "exists" | "ptr" | "redirect"; target: string }[] = [];
        for (const term of record.terms) {
            if (term.mechanism === "include" || term.mechanism === "exists") steps.push({ kind: term.mechanism, target: term.value! });
            else if (term.mechanism === "a" || term.mechanism === "mx" || term.mechanism === "ptr") {
                steps.push({ kind: term.mechanism, target: term.value ?? name });
            }
        }
        // A redirect is only read when there is no `all` (RFC 7208 6.1).
        if (record.redirect && record.all === null) steps.push({ kind: "redirect", target: record.redirect });

        for (const step of steps) {
            if (lookups >= WALK_BUDGET) return;
            lookups += 1;
            // A macro is only known at the moment of a real message; it costs
            // the lookup and nothing more can be said.
            if (step.target.includes("%")) continue;
            const target = step.target.toLowerCase().replace(/\.$/, "");
            if (step.kind === "ptr") continue;
            if (step.kind === "a" || step.kind === "mx" || step.kind === "exists") {
                const found = await resolver.exists(target, step.kind === "mx" ? "mx" : "a").catch(() => false);
                if (!found) voids += 1;
                continue;
            }
            if (visited.has(target)) continue;
            visited.add(target);
            const texts = await resolver.txt(target).catch(() => [] as string[]);
            const records = texts.filter(isSpf);
            if (texts.length === 0) voids += 1;
            if (records.length !== 1) {
                missing.push(target);
                continue;
            }
            const nested = parseSpf(records[0]!);
            if (!nested.ok) {
                broken.push(target);
                continue;
            }
            await visit(target, nested);
        }
    }

    await visit(domain.toLowerCase(), spf);
    return { lookups, voids, missing, broken };
}

/**
 * One SPF with every mechanism of `extra` added that `existing` lacks, the `all`
 * of `existing` kept (or `fallbackAll` when it had none). The same record when
 * nothing is missing. What merging a second SPF into the first means: one record,
 * since two is a permanent error for every receiver.
 */
export function mergeSpfRecords(existing: string, extra: string, fallbackAll: SpfQualifier = "~"): string {
    const keep = existing.trim().split(/\s+/).slice(1);
    const add = extra.trim().split(/\s+/).slice(1);
    const isAll = (part: string) => /^[+\-~?]?all$/i.test(part);
    const allPart = keep.find(isAll) ?? add.find(isAll) ?? `${fallbackAll}all`;
    const terms: string[] = [];
    for (const part of [...keep, ...add]) {
        if (isAll(part)) continue;
        if (!terms.some((present) => present.toLowerCase() === part.toLowerCase())) terms.push(part);
    }
    return ["v=spf1", ...terms, allPart].join(" ");
}

// ---------------------------------------------------------------------------
// DMARC
// ---------------------------------------------------------------------------

export type DmarcPolicy = "none" | "quarantine" | "reject";

export interface DmarcRecord {
    readonly p: DmarcPolicy;
    /** The subdomain policy, which is `p` when the record does not say. */
    readonly sp: DmarcPolicy;
    readonly spSet: boolean;
    readonly pct: number;
    readonly adkim: "r" | "s";
    readonly aspf: "r" | "s";
    /** The report addresses, as `mailto:` URIs. */
    readonly rua: readonly string[];
    readonly ruf: readonly string[];
}

export type DmarcParse = { readonly ok: true; readonly record: DmarcRecord } | { readonly ok: false; readonly bad: string };

export function isDmarc(text: string): boolean {
    return /^v\s*=\s*DMARC1\s*(;|$)/i.test(text.trim());
}

const POLICIES: readonly DmarcPolicy[] = ["none", "quarantine", "reject"];

function uriList(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        // A size limit (`!10m`) is part of the URI on the wire, not the address.
        .map((part) => part.replace(/!\d+[kmgt]?$/i, ""));
}

export function parseDmarc(text: string): DmarcParse {
    const tags = parseTags(text);
    if (!tags) return { ok: false, bad: text.slice(0, 80) };
    if (tags.get("v")?.toUpperCase() !== "DMARC1") return { ok: false, bad: "v" };
    const p = tags.get("p")?.toLowerCase();
    if (!p || !POLICIES.includes(p as DmarcPolicy)) return { ok: false, bad: `p=${p ?? ""}` };
    const spRaw = tags.get("sp")?.toLowerCase();
    if (spRaw !== undefined && !POLICIES.includes(spRaw as DmarcPolicy)) return { ok: false, bad: `sp=${spRaw}` };
    const pctRaw = tags.get("pct");
    const pct = pctRaw === undefined ? 100 : /^\d{1,3}$/.test(pctRaw) && Number(pctRaw) <= 100 ? Number(pctRaw) : NaN;
    if (Number.isNaN(pct)) return { ok: false, bad: `pct=${pctRaw}` };
    const alignment = (key: "adkim" | "aspf"): "r" | "s" | null => {
        const value = tags.get(key)?.toLowerCase() ?? "r";
        return value === "r" || value === "s" ? value : null;
    };
    const adkim = alignment("adkim");
    const aspf = alignment("aspf");
    if (!adkim) return { ok: false, bad: `adkim=${tags.get("adkim")}` };
    if (!aspf) return { ok: false, bad: `aspf=${tags.get("aspf")}` };
    const rua = uriList(tags.get("rua"));
    const ruf = uriList(tags.get("ruf"));
    const badUri = [...rua, ...ruf].find((uri) => !/^mailto:[^\s@]+@[^\s@]+$/i.test(uri) && !/^https?:\/\//i.test(uri));
    if (badUri) return { ok: false, bad: badUri };
    return {
        ok: true,
        record: { p: p as DmarcPolicy, sp: (spRaw as DmarcPolicy | undefined) ?? (p as DmarcPolicy), spSet: spRaw !== undefined, pct, adkim, aspf, rua, ruf }
    };
}

/** The host a `mailto:` report address delivers to, lower case. */
export function reportHost(uri: string): string | null {
    const match = /^mailto:[^\s@]+@([^\s@]+)$/i.exec(uri.trim());
    return match ? match[1]!.toLowerCase().replace(/\.$/, "") : null;
}

/** A DMARC record written the way this module reads it back. */
export function formatDmarc(record: {
    p: DmarcPolicy;
    sp?: DmarcPolicy | null;
    adkim?: "r" | "s";
    aspf?: "r" | "s";
    pct?: number;
    rua?: readonly string[];
}): string {
    const parts = ["v=DMARC1", `p=${record.p}`];
    if (record.sp) parts.push(`sp=${record.sp}`);
    if (record.pct !== undefined && record.pct !== 100) parts.push(`pct=${record.pct}`);
    if (record.adkim === "s") parts.push("adkim=s");
    if (record.aspf === "s") parts.push("aspf=s");
    if (record.rua && record.rua.length > 0) parts.push(`rua=${record.rua.join(",")}`);
    return parts.join("; ");
}

/** A published DMARC record with only the policy changed, every other tag kept as
 *  it was written. */
export function withPolicy(text: string, policy: DmarcPolicy): string {
    const parts = text
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    let seen = false;
    const next = parts.map((part) => {
        if (/^p\s*=/i.test(part)) {
            seen = true;
            return `p=${policy}`;
        }
        return part;
    });
    if (!seen) next.splice(1, 0, `p=${policy}`);
    return next.join("; ");
}

/** The same DMARC record with a report address added, every other tag kept. */
export function withRua(text: string, address: string): string {
    const parts = text
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    const at = parts.findIndex((part) => /^rua\s*=/i.test(part));
    if (at === -1) return [...parts, `rua=${address}`].join("; ");
    const current = parts[at]!.replace(/^rua\s*=\s*/i, "");
    if (current.toLowerCase().split(",").map((part) => part.trim()).includes(address.toLowerCase())) return parts.join("; ");
    parts[at] = `rua=${current},${address}`;
    return parts.join("; ");
}

// ---------------------------------------------------------------------------
// DKIM
// ---------------------------------------------------------------------------

export interface DkimKey {
    readonly keyType: "rsa" | "ed25519" | string;
    /** The public key as base64, "" when the key is revoked. */
    readonly publicKey: string;
    readonly testing: boolean;
}

export function parseDkim(text: string): DkimKey | null {
    const tags = parseTags(text);
    if (!tags || !tags.has("p")) return null;
    const version = tags.get("v");
    if (version !== undefined && version.toUpperCase() !== "DKIM1") return null;
    const flags = (tags.get("t") ?? "").split(":").map((flag) => flag.trim().toLowerCase());
    return {
        keyType: (tags.get("k") ?? "rsa").toLowerCase(),
        publicKey: (tags.get("p") ?? "").replace(/\s+/g, ""),
        testing: flags.includes("y")
    };
}

// ---------------------------------------------------------------------------
// MTA-STS and TLS-RPT
// ---------------------------------------------------------------------------

export interface MtaStsPolicy {
    readonly mode: "enforce" | "testing" | "none";
    readonly mx: readonly string[];
    readonly maxAge: number;
}

/** An MTA-STS policy file, or null when it is not one (RFC 8461 3.2). */
export function parseMtaStsPolicy(text: string): MtaStsPolicy | null {
    const fields: [string, string][] = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const at = line.indexOf(":");
            return at > 0 ? ([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()] as [string, string]) : (["", ""] as [string, string]);
        });
    const one = (key: string) => fields.find(([name]) => name === key)?.[1];
    if (one("version") !== "STSv1") return null;
    const mode = one("mode");
    if (mode !== "enforce" && mode !== "testing" && mode !== "none") return null;
    const maxAge = Number(one("max_age"));
    if (!Number.isInteger(maxAge) || maxAge < 0) return null;
    const mx = fields.filter(([name]) => name === "mx").map(([, value]) => value.toLowerCase());
    if (mode !== "none" && mx.length === 0) return null;
    return { mode, mx, maxAge };
}

/** Whether an MX host is covered by a policy's `mx` patterns, a leading `*.`
 *  standing for exactly one label. */
export function mxCovered(host: string, patterns: readonly string[]): boolean {
    const bare = host.toLowerCase().replace(/\.$/, "");
    return patterns.some((pattern) => {
        const clean = pattern.replace(/\.$/, "");
        if (clean.startsWith("*.")) {
            const suffix = clean.slice(1);
            return bare.endsWith(suffix) && !bare.slice(0, -suffix.length).includes(".") && bare.length > suffix.length;
        }
        return bare === clean;
    });
}

// ---------------------------------------------------------------------------
// security.txt
// ---------------------------------------------------------------------------

/** The Contact and Expires of a security.txt, or null when it has no Contact. */
export function parseSecurityTxt(text: string): { contacts: string[]; expires: string | null } | null {
    const contacts: string[] = [];
    let expires: string | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const at = line.indexOf(":");
        if (at <= 0) continue;
        const field = line.slice(0, at).trim().toLowerCase();
        const value = line.slice(at + 1).trim();
        if (field === "contact" && value) contacts.push(value);
        if (field === "expires" && !expires && !Number.isNaN(Date.parse(value))) expires = new Date(value).toISOString();
    }
    return contacts.length > 0 ? { contacts, expires } : null;
}
