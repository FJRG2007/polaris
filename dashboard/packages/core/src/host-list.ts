/**
 * A list of Polaris hosts carried from one device to another.
 *
 * The desktop app and the browser extension each keep the addresses somebody
 * opens Polaris at, with the names they gave them. Moving to a new computer, or
 * having the same list on a phone, meant typing every one again. This is the
 * one form that list travels in, so whatever one of them exports the other
 * reads, with no server in between: the whole list is inside the code, the
 * file or the QR, and reading it needs nothing but this module.
 *
 * Three shapes are read, all to the same list:
 * - a code, `polaris-hosts:1:` and the list base64url-encoded, short enough
 *   for a QR and for a paste;
 * - a link, `polaris://hosts?list=<code>`, which a QR can hold so a camera
 *   opens the desktop app on it;
 * - a file, JSON, readable by a person who opens it.
 *
 * Only addresses and names cross. No account, key or session is ever part of
 * it, so a list that leaks shows where somebody's Polaris is and nothing more.
 * Whatever is read is untrusted: every address is re-parsed and must be a bare
 * http(s) origin, names are trimmed and capped, and the list is capped.
 */

/** One host as both apps store it. */
export interface PortableHost {
    readonly origin: string;
    /** Null when nobody named it; the host is shown instead. */
    readonly name: string | null;
}

export const HOST_LIST_PREFIX = "polaris-hosts:1:";
export const HOST_LIST_LINK = "polaris://hosts";

/** The most hosts one list carries - more than either app keeps. */
export const HOST_LIST_MAX = 50;

/** The longest name kept; a longer one is cut, the host is never dropped for it. */
export const HOST_NAME_MAX = 40;

/** The most text read: a list at its cap is well under this. */
const INPUT_MAX = 64 * 1024;

const FILE_KIND = "polaris-hosts";

/** An address as it is stored, or null when it is not a bare http(s) origin. */
function originOf(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 2048) return null;
    // A bare host in the compact form is https, the only scheme left out of it.
    const typed = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    try {
        const url = new URL(typed);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (url.username || url.password) return null;
        if (url.pathname !== "/" || url.search || url.hash) return null;
        return url.origin;
    } catch {
        return null;
    }
}

function nameOf(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const name = value.replace(/\s+/g, " ").trim().slice(0, HOST_NAME_MAX).trim();
    return name === "" ? null : name;
}

/** The rows of a list as read, with duplicates and unusable rows dropped. */
function settle(rows: readonly { origin: unknown; name: unknown }[]): PortableHost[] {
    const hosts: PortableHost[] = [];
    for (const row of rows) {
        if (hosts.length === HOST_LIST_MAX) break;
        const origin = originOf(row.origin);
        if (!origin || hosts.some((one) => one.origin === origin)) continue;
        hosts.push({ origin, name: nameOf(row.name) });
    }
    return hosts;
}

function toBase64Url(text: string): string {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code: string): string | null {
    if (!/^[A-Za-z0-9_-]*$/.test(code)) return null;
    try {
        const binary = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

/** The list as a code. https is left out of each address to keep the QR small. */
export function encodeHostList(hosts: readonly PortableHost[]): string {
    const rows = settle(hosts).map(({ origin, name }) => {
        const short = origin.startsWith("https://") ? origin.slice("https://".length) : origin;
        return name ? [short, name] : [short];
    });
    return `${HOST_LIST_PREFIX}${toBase64Url(JSON.stringify(rows))}`;
}

/** The list as a link a QR can hold. */
export function hostListLink(hosts: readonly PortableHost[]): string {
    return `${HOST_LIST_LINK}?list=${encodeHostList(hosts)}`;
}

/** The list as a file somebody can open and read. */
export function hostListFile(hosts: readonly PortableHost[]): string {
    return `${JSON.stringify({ kind: FILE_KIND, version: 1, hosts: settle(hosts) }, null, 4)}\n`;
}

function fromCode(code: string): PortableHost[] | null {
    const json = fromBase64Url(code.slice(HOST_LIST_PREFIX.length));
    if (json === null) return null;
    let rows: unknown;
    try {
        rows = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(rows)) return null;
    return settle(
        rows.filter((row): row is unknown[] => Array.isArray(row)).map((row) => ({ origin: row[0], name: row[1] }))
    );
}

function fromFile(text: string): PortableHost[] | null {
    let file: unknown;
    try {
        file = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof file !== "object" || file === null) return null;
    const { kind, hosts } = file as { kind?: unknown; hosts?: unknown };
    if (kind !== FILE_KIND || !Array.isArray(hosts)) return null;
    return settle(
        hosts
            .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
            .map((row) => ({ origin: row.origin, name: row.name }))
    );
}

/**
 * The hosts in a code, a link or a file, or null when the text is none of them.
 * An empty list is a list: a code of nobody's hosts reads as `[]`.
 */
export function readHostList(raw: string): PortableHost[] | null {
    if (raw.length > INPUT_MAX) return null;
    const text = raw.trim();
    if (text.startsWith(HOST_LIST_PREFIX)) return fromCode(text);
    if (text.toLowerCase().startsWith(`${HOST_LIST_LINK}?`)) {
        const list = new URLSearchParams(text.slice(text.indexOf("?") + 1)).get("list");
        return list?.startsWith(HOST_LIST_PREFIX) ? fromCode(list) : null;
    }
    if (text.startsWith("{")) return fromFile(text);
    return null;
}

/**
 * The list a device keeps after taking another's in: its own hosts first and
 * untouched, then each new one in the order it came. A host already listed
 * without a name takes the one it arrived with; a name somebody already gave is
 * never overwritten. Capped at `max`: what does not fit is counted, never
 * dropped silently.
 */
export function mergeHostLists(
    saved: readonly PortableHost[],
    incoming: readonly PortableHost[],
    max: number
): { hosts: PortableHost[]; added: number; named: number; skipped: number } {
    const hosts: { origin: string; name: string | null }[] = saved.map((one) => ({ ...one }));
    let added = 0;
    let named = 0;
    let skipped = 0;
    for (const host of incoming) {
        const listed = hosts.find((one) => one.origin === host.origin);
        if (listed) {
            if (!listed.name && host.name) {
                listed.name = host.name;
                named++;
            }
            continue;
        }
        if (hosts.length >= max) {
            skipped++;
            continue;
        }
        hosts.push({ origin: host.origin, name: host.name });
        added++;
    }
    return { hosts, added, named, skipped };
}
