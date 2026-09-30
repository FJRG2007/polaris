/**
 * WebDAV plumbing: the multistatus answer, the namespaces CalDAV servers use,
 * and one authenticated request helper.
 *
 * Kept apart from `caldav.ts` so the protocol steps there read as steps, and so
 * the parsing - where servers disagree the most - can be tested on its own.
 */

import { SyncRefusedError } from "./errors";
import { XmlError, child, childrenOf, parseXml, textContent, type XmlElement } from "./xml";
import { MAX_RESPONSE_BYTES, basicAuth, errorFor, readCapped, reasonOf, send, type Fetcher } from "./http";

export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";
/** Apple's calendarserver namespace: `getctag`. */
export const CS = "http://calendarserver.org/ns/";
/** Apple's iCal namespace: `calendar-color`, `calendar-order`. */
export const APPLE = "http://apple.com/ns/ical/";

export interface DavPropstat {
    readonly status: number;
    readonly props: readonly XmlElement[];
}

export interface DavResponse {
    /** The member's absolute URL, resolved against the request's. */
    readonly href: string;
    /** A response-level status (a sync report's removed members carry 404). */
    readonly status: number | null;
    readonly propstats: readonly DavPropstat[];
}

export interface Multistatus {
    readonly responses: readonly DavResponse[];
    /** The top-level `sync-token` of a sync-collection report. */
    readonly syncToken: string | null;
}

/** The code in an `HTTP/1.1 404 Not Found` status line. */
function statusCode(line: string): number | null {
    const match = /^\s*HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line);
    return match ? Number(match[1]) : null;
}

/** Resolves an href against the request URL; hrefs are paths more often than not. */
export function resolveHref(href: string, base: string | URL): string {
    return new URL(href.trim(), base).href;
}

/**
 * A comparison key for a member URL.
 *
 * Servers do not agree on how much of a path to percent-encode (`@` or `%40`),
 * and the same server is not always consistent between a PROPFIND and a REPORT.
 */
export function hrefKey(href: string): string {
    const url = new URL(href);
    let path = url.pathname;
    try {
        path = decodeURIComponent(path);
    } catch {
        // Leave a malformed escape as it is; it still compares with itself.
    }
    return `${url.host}${path}`;
}

/** Reads a 207 Multi-Status body. */
export function parseMultistatus(xml: string, base: string | URL): Multistatus {
    let root: XmlElement;
    try {
        root = parseXml(xml);
    } catch (error) {
        if (error instanceof XmlError) throw new SyncRefusedError("The server answered with malformed XML", 207);
        throw error;
    }
    if (root.ns !== DAV || root.local !== "multistatus") throw new SyncRefusedError("The server did not answer with a multistatus", 207);
    const responses: DavResponse[] = [];
    for (const response of childrenOf(root, DAV, "response")) {
        const hrefText = textContent(child(response, DAV, "href")).trim();
        if (!hrefText) continue;
        let href: string;
        try {
            href = resolveHref(hrefText, base);
        } catch {
            continue;
        }
        const statusEl = child(response, DAV, "status");
        const propstats = childrenOf(response, DAV, "propstat").map((propstat) => ({
            status: statusCode(textContent(child(propstat, DAV, "status"))) ?? 0,
            props: child(propstat, DAV, "prop")?.children ?? []
        }));
        responses.push({ href, status: statusEl ? statusCode(textContent(statusEl)) : null, propstats });
    }
    const token = child(root, DAV, "sync-token");
    return { responses, syncToken: token ? textContent(token).trim() : null };
}

/** A property a member returned with a 2xx status, or null. */
export function prop(response: DavResponse | undefined, ns: string, local: string): XmlElement | null {
    if (!response) return null;
    for (const propstat of response.propstats) {
        if (propstat.status < 200 || propstat.status > 299) continue;
        const found = propstat.props.find((p) => p.ns === ns && p.local === local);
        if (found) return found;
    }
    return null;
}

/** The trimmed text of a 2xx property, or null. */
export function propText(response: DavResponse | undefined, ns: string, local: string): string | null {
    const found = prop(response, ns, local);
    return found ? textContent(found).trim() : null;
}

/** Whether a member's resourcetype includes `(ns, local)`. */
export function hasType(response: DavResponse | undefined, ns: string, local: string): boolean {
    return child(prop(response, DAV, "resourcetype"), ns, local) !== null;
}

/** The first `href` inside a property, resolved, or null. */
export function propHref(response: DavResponse | undefined, ns: string, local: string, base: string | URL): string | null {
    const href = textContent(child(prop(response, ns, local), DAV, "href")).trim();
    if (!href) return null;
    try {
        return resolveHref(href, base);
    } catch {
        return null;
    }
}

export interface DavCredentials {
    readonly username: string;
    readonly password: string;
    readonly fetcher: Fetcher;
}

export interface DavResult {
    readonly response: Response;
    /** The URL that answered, after redirects. */
    readonly url: URL;
}

/** One authenticated WebDAV request; the caller decides what a status means. */
export async function davRequest(
    credentials: DavCredentials,
    method: string,
    url: string,
    options: { depth?: "0" | "1"; body?: string; headers?: Record<string, string> } = {}
): Promise<DavResult> {
    const headers: Record<string, string> = { Authorization: basicAuth(credentials.username, credentials.password), ...options.headers };
    if (options.depth !== undefined) headers.Depth = options.depth;
    if (options.body !== undefined) headers["Content-Type"] = "application/xml; charset=utf-8";
    return send(credentials.fetcher, url, { method, headers, body: options.body });
}

/**
 * A PROPFIND or REPORT that must answer 207; anything else is thrown as the
 * matching sync error.
 */
export async function davMultistatus(
    credentials: DavCredentials,
    method: "PROPFIND" | "REPORT",
    url: string,
    depth: "0" | "1",
    body: string
): Promise<{ multistatus: Multistatus; url: URL }> {
    const { response, url: answered } = await davRequest(credentials, method, url, { depth, body });
    if (response.status !== 207) throw errorFor(response, await reasonOf(response));
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    return { multistatus: parseMultistatus(text, answered), url: answered };
}
