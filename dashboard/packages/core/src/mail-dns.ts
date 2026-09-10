/**
 * The DNS a mail domain needs, read from what the mail server says it expects,
 * and compared with what is actually published.
 *
 * The records are not built here. The engine generates them - its DKIM key, its
 * SPF, its DMARC, its MTA-STS and TLS reporting, the service records a mail client
 * looks up - and hands them over as a zone file (`dnsZoneFile` on the domain).
 * Deriving them from that one text is what keeps the published DKIM key and the
 * key the server signs with the same key, which is the thing that silently breaks
 * when a panel generates its own copy.
 *
 * So this is a zone-file reader, a classifier that says what each record is for
 * and whether mail works without it, and the grading that compares an expected
 * record with the answers a public resolver gave.
 */

/** One record from a zone. Names are absolute, lower case, with no trailing dot. */
export interface ZoneRecord {
    readonly name: string;
    readonly type: string;
    readonly ttl: number | null;
    /** The record's data as one string: a TXT's strings joined, an MX's host. */
    readonly value: string;
    /** An MX's preference, or null for everything else. */
    readonly priority: number | null;
}

const CLASSES = new Set(["IN", "CH", "HS", "CS"]);

/** Split one logical line into tokens, keeping quoted strings whole and
 *  honouring backslash escapes inside them. */
function tokenize(line: string): string[] {
    const tokens: string[] = [];
    let index = 0;
    while (index < line.length) {
        const char = line[index];
        if (char === " " || char === "\t") {
            index += 1;
            continue;
        }
        if (char === ";") break;
        if (char === '"') {
            let value = "";
            index += 1;
            while (index < line.length && line[index] !== '"') {
                if (line[index] === "\\" && index + 1 < line.length) {
                    value += line[index + 1];
                    index += 2;
                    continue;
                }
                value += line[index];
                index += 1;
            }
            index += 1;
            tokens.push(value);
            continue;
        }
        let value = "";
        while (index < line.length && line[index] !== " " && line[index] !== "\t" && line[index] !== ";") {
            value += line[index];
            index += 1;
        }
        tokens.push(value);
    }
    return tokens;
}

/** Join lines held open by parentheses, dropping comments outside quotes. */
function logicalLines(text: string): { line: string; indented: boolean }[] {
    const out: { line: string; indented: boolean }[] = [];
    let buffer = "";
    let depth = 0;
    let indented = false;
    for (const raw of text.split(/\r?\n/)) {
        let inQuote = false;
        let kept = "";
        for (let index = 0; index < raw.length; index += 1) {
            const char = raw[index];
            if (char === "\\" && inQuote) {
                kept += raw.slice(index, index + 2);
                index += 1;
                continue;
            }
            if (char === '"') inQuote = !inQuote;
            if (!inQuote && char === ";") break;
            if (!inQuote && char === "(") {
                depth += 1;
                kept += " ";
                continue;
            }
            if (!inQuote && char === ")") {
                depth = Math.max(0, depth - 1);
                kept += " ";
                continue;
            }
            kept += char;
        }
        if (buffer === "") indented = /^[ \t]/.test(raw);
        buffer += `${kept} `;
        if (depth === 0) {
            if (buffer.trim()) out.push({ line: buffer, indented });
            buffer = "";
        }
    }
    if (buffer.trim()) out.push({ line: buffer, indented });
    return out;
}

/** An owner name made absolute against the origin. */
function absolute(name: string, origin: string): string {
    if (name === "@") return origin;
    if (name.endsWith(".")) return name.slice(0, -1).toLowerCase();
    return (origin ? `${name}.${origin}` : name).toLowerCase();
}

/**
 * Read a zone file into records.
 *
 * The subset of RFC 1035 a generated zone uses, done properly: `$ORIGIN` and
 * `$TTL`, relative and `@` names, an owner carried over from the line before when
 * a line starts with whitespace, parenthesised records spanning lines, comments,
 * and TXT data as quoted strings that are joined into one value.
 */
export function parseZoneFile(text: string, defaultOrigin = ""): ZoneRecord[] {
    const records: ZoneRecord[] = [];
    let origin = defaultOrigin.replace(/\.$/, "").toLowerCase();
    let defaultTtl: number | null = null;
    let previousOwner = origin;

    for (const { line, indented } of logicalLines(text)) {
        const tokens = tokenize(line);
        if (tokens.length === 0) continue;
        const first = tokens[0] ?? "";
        if (first.toUpperCase() === "$ORIGIN") {
            origin = (tokens[1] ?? "").replace(/\.$/, "").toLowerCase();
            continue;
        }
        if (first.toUpperCase() === "$TTL") {
            const ttl = Number(tokens[1]);
            defaultTtl = Number.isFinite(ttl) ? ttl : defaultTtl;
            continue;
        }
        if (first.startsWith("$")) continue;

        let cursor = 0;
        let owner = previousOwner;
        if (!indented) {
            owner = absolute(first, origin);
            cursor = 1;
        }
        let ttl = defaultTtl;
        // TTL and class may come in either order, both optional.
        for (let guard = 0; guard < 2; guard += 1) {
            const token = tokens[cursor] ?? "";
            if (/^\d+$/.test(token)) {
                ttl = Number(token);
                cursor += 1;
            } else if (CLASSES.has(token.toUpperCase())) {
                cursor += 1;
            }
        }
        const type = (tokens[cursor] ?? "").toUpperCase();
        cursor += 1;
        if (!/^[A-Z0-9]+$/.test(type)) continue;
        previousOwner = owner;
        const data = tokens.slice(cursor);

        if (type === "MX") {
            const priority = Number(data[0]);
            records.push({
                name: owner,
                type,
                ttl,
                value: absolute(data[1] ?? "", origin),
                priority: Number.isFinite(priority) ? priority : null
            });
            continue;
        }
        if (type === "TXT") {
            // A TXT's character-strings are one value joined with nothing between
            // them, which is how a long DKIM key split across strings reads back.
            records.push({ name: owner, type, ttl, value: data.join(""), priority: null });
            continue;
        }
        if (type === "CNAME" || type === "NS" || type === "PTR") {
            records.push({ name: owner, type, ttl, value: absolute(data[0] ?? "", origin), priority: null });
            continue;
        }
        if (type === "SRV") {
            // priority weight port target - the target made absolute like any name.
            const [priority, weight, port, target] = data;
            records.push({
                name: owner,
                type,
                ttl,
                value: `${priority ?? "0"} ${weight ?? "0"} ${port ?? "0"} ${absolute(target ?? "", origin)}`,
                priority: null
            });
            continue;
        }
        records.push({ name: owner, type, ttl, value: data.join(" "), priority: null });
    }
    return records;
}

/** What a mail record is for. */
export type MailRecordPurpose =
    | "mx"
    | "spf"
    | "dkim"
    | "dmarc"
    | "mta-sts"
    | "tls-rpt"
    | "service"
    | "autoconfig"
    | "caa"
    | "tlsa"
    | "address"
    | "other";

export const MAIL_RECORD_LABELS: Readonly<Record<MailRecordPurpose, string>> = {
    mx: "Where mail for the domain is delivered",
    spf: "Which servers may send as the domain",
    dkim: "The key that signs outgoing mail",
    dmarc: "What receivers do with mail that fails the checks",
    "mta-sts": "Tells senders to insist on TLS",
    "tls-rpt": "Where TLS failure reports are sent",
    service: "Lets mail apps find the server",
    autoconfig: "Lets mail apps set themselves up",
    caa: "Which authority may issue the certificate",
    tlsa: "Pins the certificate for DANE",
    address: "The mail server's address",
    other: "Published by the mail server"
};

/** Mail does not work, or does not arrive, without these. */
const REQUIRED: ReadonlySet<MailRecordPurpose> = new Set(["mx", "spf", "dkim", "dmarc"]);

export interface ExpectedMailRecord extends ZoneRecord {
    readonly purpose: MailRecordPurpose;
    readonly required: boolean;
}

/** What one record is for, from its name, type and content. */
export function purposeOf(record: ZoneRecord): MailRecordPurpose {
    const value = record.value.toLowerCase();
    if (record.type === "MX") return "mx";
    if (record.type === "TXT" && value.startsWith("v=spf1")) return "spf";
    if (record.type === "TXT" && record.name.includes("._domainkey.")) return "dkim";
    if (record.type === "TXT" && record.name.startsWith("_dmarc.")) return "dmarc";
    if (record.type === "TXT" && record.name.startsWith("_mta-sts.")) return "mta-sts";
    if (record.type === "TXT" && record.name.startsWith("_smtp._tls.")) return "tls-rpt";
    if (record.type === "CNAME" && record.name.startsWith("mta-sts.")) return "mta-sts";
    if (record.type === "SRV") return "service";
    if (record.type === "CNAME" && /^(autoconfig|autodiscover)\./.test(record.name)) return "autoconfig";
    if (record.type === "CAA") return "caa";
    if (record.type === "TLSA") return "tlsa";
    if (record.type === "A" || record.type === "AAAA") return "address";
    return "other";
}

/** The records a domain's zone says it needs, each with its purpose. */
export function expectedMailRecords(zone: readonly ZoneRecord[]): ExpectedMailRecord[] {
    return zone
        .filter((record) => record.type !== "SOA" && record.type !== "NS")
        .map((record) => {
            const purpose = purposeOf(record);
            return { ...record, purpose, required: REQUIRED.has(purpose) };
        });
}

/** How one expected record compares with what is published. */
export type RecordVerdict = "pass" | "warn" | "fail";

export interface GradedRecord {
    readonly record: ExpectedMailRecord;
    readonly verdict: RecordVerdict;
    /** What was found at the name, as the resolver answered. */
    readonly published: readonly string[];
    /** One sentence, only when the verdict is not a pass. */
    readonly note: string | null;
}

/** A value made comparable: case, trailing dots and runs of spaces do not matter
 *  in a host name, and TXT whitespace is not significant to any of these. */
function comparable(type: string, value: string): string {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (type === "TXT") return trimmed.replace(/;\s*/g, ";").replace(/;$/, "").toLowerCase();
    return trimmed.replace(/\.$/, "").toLowerCase();
}

/**
 * Grade one record against the published answers at its name.
 *
 * Exact where exactness is what matters (a DKIM key, an MX host), lenient where a
 * different but valid record still works (a DMARC with another policy, an SPF
 * that also includes the operator's other senders). A missing record fails only
 * when mail depends on it; an optional one warns.
 */
export function gradeRecord(record: ExpectedMailRecord, published: readonly string[]): GradedRecord {
    const want = comparable(record.type, record.value);
    const have = published.map((value) => comparable(record.type, value));
    const found = (verdict: RecordVerdict, note: string | null): GradedRecord => ({
        record,
        verdict,
        published,
        note
    });

    if (record.purpose === "spf") {
        const spf = have.filter((value) => value.startsWith("v=spf1"));
        if (spf.length > 1) return found("fail", "There are two SPF records, which makes both invalid. Keep one.");
        if (spf.length === 0) return found("fail", "No SPF record is published.");
        if (spf[0] === want) return found("pass", null);
        const mechanisms = want.split(" ").filter((part) => part !== "v=spf1" && !/^[~?+-]all$/.test(part));
        const covered = mechanisms.every((mechanism) => spf[0]?.split(" ").includes(mechanism));
        return covered
            ? found("warn", "An SPF record is published with more in it than this server needs. Mail still passes.")
            : found("fail", "The published SPF record does not include this server.");
    }
    if (record.purpose === "dmarc") {
        const dmarc = have.filter((value) => value.startsWith("v=dmarc1"));
        if (dmarc.length === 0) return found("fail", "No DMARC policy is published.");
        if (dmarc.includes(want)) return found("pass", null);
        return found("warn", "A different DMARC policy is published. It is valid; reports may go elsewhere.");
    }
    if (have.includes(want)) return found("pass", null);
    if (have.length === 0) {
        return record.required
            ? found("fail", "Nothing is published at this name yet.")
            : found("warn", "Not published. Mail works without it.");
    }
    return record.required
        ? found("fail", "Something else is published at this name.")
        : found("warn", "Something else is published at this name.");
}

/**
 * An existing SPF record with this server added to it.
 *
 * A domain that already sends through somebody (a workspace suite, a newsletter
 * service) has an SPF record saying so, and replacing it with the mail server's
 * own would make every one of those senders fail SPF the moment it published.
 * So the mechanisms the server needs are put in front of the existing ones and
 * the existing policy (`~all`, `-all`) is kept. Answers null when the existing
 * record already covers the server.
 */
export function mergeSpf(existing: string, ours: string): string | null {
    const have = existing.trim().split(/\s+/);
    const want = ours
        .trim()
        .split(/\s+/)
        .filter((part) => part.toLowerCase() !== "v=spf1" && !/^[~?+-]?all$/i.test(part));
    const missing = want.filter((part) => !have.some((present) => present.toLowerCase() === part.toLowerCase()));
    if (missing.length === 0) return null;
    const [version, ...rest] = have;
    return [version && version.toLowerCase() === "v=spf1" ? version : "v=spf1", ...missing, ...rest].join(" ");
}

/** The worst verdict in a set, for the one badge a domain gets. */
export function overallVerdict(graded: readonly GradedRecord[]): RecordVerdict {
    if (graded.some((entry) => entry.verdict === "fail")) return "fail";
    if (graded.some((entry) => entry.verdict === "warn")) return "warn";
    return "pass";
}
