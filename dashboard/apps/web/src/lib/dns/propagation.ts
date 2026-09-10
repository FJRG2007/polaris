/**
 * Whether a record has reached the resolvers the rest of the internet asks.
 *
 * Asked over DNS-over-HTTPS rather than through this machine's own resolver, for
 * two reasons. The machine's resolver is one opinion, usually a cache in front of
 * the others, and what somebody wants to know after changing a record is whether
 * the big public resolvers see it yet. And the machine's resolver is not always
 * there at all - a container can have a broken one and still reach HTTPS.
 *
 * Three resolvers, each asked in the RFC 8484 wire format at the endpoint its
 * operator publishes, so one small parser reads all three. A resolver that does
 * not answer is reported as unreachable, never as "the record is missing".
 */

import { txtText } from "./record-schema";

export const RESOLVERS = [
    { id: "cloudflare", label: "Cloudflare (1.1.1.1)", url: "https://cloudflare-dns.com/dns-query" },
    { id: "google", label: "Google (8.8.8.8)", url: "https://dns.google/dns-query" },
    { id: "quad9", label: "Quad9 (9.9.9.9)", url: "https://dns.quad9.net/dns-query" }
] as const;

export type ResolverId = (typeof RESOLVERS)[number]["id"];

/** The record types this reads, with their numbers on the wire. */
export const QUERY_TYPES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 } as const;
export type QueryType = keyof typeof QUERY_TYPES;

const TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------

/** A query for one name and type, as the bytes a resolver takes. The id is zero,
 *  as RFC 8484 recommends, so the same question is the same cacheable URL. */
export function encodeQuery(name: string, type: QueryType): Uint8Array {
    const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
    const question: number[] = [];
    for (const label of labels) {
        const bytes = new TextEncoder().encode(label);
        if (bytes.length > 63) throw new Error("A label is longer than DNS allows");
        question.push(bytes.length, ...bytes);
    }
    question.push(0);
    const code = QUERY_TYPES[type];
    // Header: id 0, flags 0x0100 (recursion desired), one question, no answers.
    return new Uint8Array([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...question, code >> 8, code & 0xff, 0, 1]);
}

/** Base64url with no padding, the form RFC 8484 puts a query in a URL as. */
export function base64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read a possibly compressed name starting at `offset`, answering it and where
 *  the bytes after it begin. */
function readName(message: Uint8Array, offset: number): { name: string; next: number } {
    const labels: string[] = [];
    let position = offset;
    let next = -1;
    // Bounded, so a pointer loop in a hostile answer cannot spin forever.
    for (let hops = 0; hops < 128; hops += 1) {
        if (position >= message.length) throw new Error("A name runs past the end of the answer");
        const length = message[position]!;
        if (length === 0) {
            return { name: labels.join("."), next: next === -1 ? position + 1 : next };
        }
        if ((length & 0xc0) === 0xc0) {
            if (position + 1 >= message.length) throw new Error("A name pointer runs past the end");
            if (next === -1) next = position + 2;
            position = ((length & 0x3f) << 8) | message[position + 1]!;
            continue;
        }
        const end = position + 1 + length;
        if (end > message.length) throw new Error("A label runs past the end of the answer");
        labels.push(new TextDecoder().decode(message.subarray(position + 1, end)));
        position = end;
    }
    throw new Error("A name in the answer points in a circle");
}

function ipv6(bytes: Uint8Array): string {
    const groups: number[] = [];
    for (let index = 0; index < 16; index += 2) groups.push((bytes[index]! << 8) | bytes[index + 1]!);
    // The longest run of zero groups becomes "::", as addresses are written.
    let bestStart = -1;
    let bestLength = 0;
    for (let start = 0; start < 8; ) {
        if (groups[start] !== 0) {
            start += 1;
            continue;
        }
        let end = start;
        while (end < 8 && groups[end] === 0) end += 1;
        if (end - start > bestLength && end - start > 1) {
            bestStart = start;
            bestLength = end - start;
        }
        start = end;
    }
    const hex = groups.map((group) => group.toString(16));
    if (bestStart === -1) return hex.join(":");
    return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/** Character-strings as they sit in TXT and CAA data: a length, then that many bytes. */
function characterStrings(bytes: Uint8Array): string[] {
    const strings: string[] = [];
    let position = 0;
    while (position < bytes.length) {
        const length = bytes[position]!;
        strings.push(new TextDecoder().decode(bytes.subarray(position + 1, position + 1 + length)));
        position += 1 + length;
    }
    return strings;
}

/** One answer's data in the form a zone file writes it. */
function presentation(message: Uint8Array, type: number, start: number, length: number): string | null {
    const data = message.subarray(start, start + length);
    switch (type) {
        case QUERY_TYPES.A:
            return length === 4 ? Array.from(data).join(".") : null;
        case QUERY_TYPES.AAAA:
            return length === 16 ? ipv6(data) : null;
        case QUERY_TYPES.NS:
        case QUERY_TYPES.CNAME:
            return readName(message, start).name.toLowerCase();
        case QUERY_TYPES.TXT:
            // A long value is split into 255-byte strings by the protocol; the value
            // is them joined, which is how it was written.
            return characterStrings(data).join("");
        case QUERY_TYPES.MX:
            return `${(data[0]! << 8) | data[1]!} ${readName(message, start + 2).name.toLowerCase()}`;
        case QUERY_TYPES.SRV: {
            const priority = (data[0]! << 8) | data[1]!;
            const weight = (data[2]! << 8) | data[3]!;
            const port = (data[4]! << 8) | data[5]!;
            return `${priority} ${weight} ${port} ${readName(message, start + 6).name.toLowerCase()}`;
        }
        case QUERY_TYPES.CAA: {
            const tagLength = data[1]!;
            const tag = new TextDecoder().decode(data.subarray(2, 2 + tagLength));
            const value = new TextDecoder().decode(data.subarray(2 + tagLength));
            return `${data[0]} ${tag} "${value}"`;
        }
        default:
            return null;
    }
}

export interface DecodedAnswer {
    /** 0 is an answer, 3 is "no such name"; anything else is the resolver failing. */
    readonly rcode: number;
    /** The values of the asked type, in presentation form. */
    readonly values: string[];
}

/** Read a resolver's answer, keeping only the records of the type asked about -
 *  an address question about an alias answers the alias too. */
export function decodeResponse(message: Uint8Array, type: QueryType): DecodedAnswer {
    if (message.length < 12) throw new Error("The answer is shorter than a DNS header");
    const rcode = message[3]! & 0x0f;
    const questions = (message[4]! << 8) | message[5]!;
    const answers = (message[6]! << 8) | message[7]!;
    let position = 12;
    for (let index = 0; index < questions; index += 1) position = readName(message, position).next + 4;
    const values: string[] = [];
    for (let index = 0; index < answers; index += 1) {
        position = readName(message, position).next;
        if (position + 10 > message.length) throw new Error("An answer runs past the end");
        const answerType = (message[position]! << 8) | message[position + 1]!;
        const length = (message[position + 8]! << 8) | message[position + 9]!;
        const start = position + 10;
        if (start + length > message.length) throw new Error("An answer's data runs past the end");
        if (answerType === QUERY_TYPES[type]) {
            const value = presentation(message, answerType, start, length);
            if (value !== null) values.push(value);
        }
        position = start + length;
    }
    return { rcode, values };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

export interface ResolverAnswer {
    readonly resolver: ResolverId;
    readonly label: string;
    /** answered: it said something (possibly nothing of this type); missing: no such
     *  name; unreachable: it did not answer, or answered with a failure. */
    readonly status: "answered" | "missing" | "unreachable";
    readonly values: string[];
    /** Whether it gives the expected values, or agrees with the others when there
     *  is nothing to expect. Null when it could not be asked. */
    readonly agrees: boolean | null;
}

export interface PropagationReport {
    readonly name: string;
    readonly type: QueryType;
    readonly expected: string[] | null;
    readonly resolvers: ResolverAnswer[];
    /** Every resolver that answered agrees, and at least one did. */
    readonly settled: boolean;
    readonly checkedAt: string;
}

/** A value as two resolvers are compared on: hostnames without case or a final dot. */
export function comparable(value: string, type: QueryType): string {
    const trimmed = value.trim();
    if (type === "TXT") return txtText(trimmed);
    if (type === "CAA") return trimmed;
    if (type === "AAAA") return trimmed.toLowerCase();
    return trimmed.toLowerCase().replace(/\.$/, "");
}

function sameSet(a: readonly string[], b: readonly string[], type: QueryType): boolean {
    const left = [...new Set(a.map((value) => comparable(value, type)))].sort();
    const right = [...new Set(b.map((value) => comparable(value, type)))].sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function ask(url: string, name: string, type: QueryType, fetcher: typeof fetch): Promise<DecodedAnswer> {
    const response = await fetcher(`${url}?dns=${base64Url(encodeQuery(name, type))}`, {
        headers: { accept: "application/dns-message" },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return decodeResponse(new Uint8Array(await response.arrayBuffer()), type);
}

/**
 * Ask every resolver about one record and say which of them see it.
 *
 * `expected` is what the zone holds - the values a resolver should give once the
 * change has reached it. Without it (a proxied record answers with Cloudflare's
 * own addresses, not its content) the resolvers are compared with each other.
 */
export async function checkPropagation(
    name: string,
    type: QueryType,
    expected: readonly string[] | null,
    fetcher: typeof fetch = fetch
): Promise<PropagationReport> {
    const asked = await Promise.all(
        RESOLVERS.map(async (resolver) => {
            try {
                const answer = await ask(resolver.url, name, type, fetcher);
                if (answer.rcode === 3) return { resolver, status: "missing" as const, values: [] };
                if (answer.rcode !== 0) return { resolver, status: "unreachable" as const, values: [] };
                return { resolver, status: "answered" as const, values: answer.values };
            } catch {
                return { resolver, status: "unreachable" as const, values: [] };
            }
        })
    );
    const reached = asked.filter((entry) => entry.status !== "unreachable");
    // With nothing to expect, the answer most resolvers give is the reference.
    const reference =
        expected ??
        reached
            .map((entry) => entry.values)
            .sort(
                (a, b) =>
                    reached.filter((entry) => sameSet(entry.values, b, type)).length -
                    reached.filter((entry) => sameSet(entry.values, a, type)).length
            )[0] ??
        null;
    const resolvers: ResolverAnswer[] = asked.map((entry) => ({
        resolver: entry.resolver.id,
        label: entry.resolver.label,
        status: entry.status,
        values: entry.values,
        agrees: entry.status === "unreachable" || reference === null ? null : sameSet(entry.values, reference, type)
    }));
    const answered = resolvers.filter((entry) => entry.agrees !== null);
    return {
        name,
        type,
        expected: expected ? [...expected] : null,
        resolvers,
        settled: answered.length > 0 && answered.every((entry) => entry.agrees === true),
        checkedAt: new Date().toISOString()
    };
}
