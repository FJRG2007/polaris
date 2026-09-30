/**
 * CalDAV: iCloud, Fastmail, Nextcloud, Yahoo, Radicale and every other server
 * that speaks RFC 4791.
 *
 * Discovery follows RFC 6764 - `.well-known/caldav`, then the principal, then
 * its calendar home - so a person types the address they know (often just the
 * host) and the rest is found. Pulling prefers RFC 6578 `sync-collection`,
 * which answers with only what changed; a server without it, or one that has
 * forgotten the token, is diffed by etag instead, which costs one listing but
 * is exact. Writes carry `If-Match` / `If-None-Match: *`, so a change made
 * elsewhere in the meantime is a conflict, never an overwrite.
 */

import { MAX_RESPONSE_BYTES, errorFor, readCapped, reasonOf, type Fetcher } from "./http";
import { SyncAuthError, SyncError, SyncNotFoundError, SyncRefusedError, SyncUnreachableError } from "./errors";
import type { CalendarProvider, ChangeSet, PullState, RemoteCalendar, RemoteObject } from "./provider";
import * as dav from "./dav";
import { childrenOf, escapeXml } from "./xml";

/** How many objects one calendar-multiget asks for. */
export const MULTIGET_BATCH = 50;

/** A sync report that keeps answering "truncated" is abandoned after this many rounds. */
const MAX_SYNC_ROUNDS = 100;

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="${dav.CALDAV}"><d:prop><d:current-user-principal/><d:resourcetype/><c:calendar-home-set/></d:prop></d:propfind>`;

const HOME_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="${dav.CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const CALENDARS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="${dav.CALDAV}" xmlns:cs="${dav.CS}" xmlns:a="${dav.APPLE}"><d:prop>
<d:resourcetype/><d:displayname/><a:calendar-color/><c:calendar-description/><c:calendar-timezone/>
<c:supported-calendar-component-set/><d:current-user-privilege-set/><cs:getctag/><d:sync-token/>
</d:prop></d:propfind>`;

const STATE_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="${dav.CS}"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>`;

const ETAGS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>`;

const ETAG_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`;

function syncBody(token: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:"><d:sync-token>${escapeXml(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
}

function multigetBody(hrefs: readonly string[]): string {
    const lines = hrefs.map((href) => `<d:href>${escapeXml(href)}</d:href>`).join("");
    return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="${dav.CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop>${lines}</c:calendar-multiget>`;
}

/**
 * The address a person typed, as a URL: a bare host gets `https://`, never
 * `http://` - a password is about to be sent to it.
 */
export function normalizeServerUrl(raw: string): URL {
    const trimmed = raw.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        throw new SyncRefusedError("Not a valid address", null);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SyncRefusedError("Only http and https addresses are supported", null);
    if (url.username || url.password) throw new SyncRefusedError("Put the username and password in their own fields, not in the address", null);
    url.hash = "";
    return url;
}

/** A collection URL always ends in a slash, so members resolve under it. */
function asCollection(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
}

/** `#RRGGBB` from Apple's `#RRGGBBAA` (or `#RRGGBB`); null for anything else. */
export function normalizeDavColor(raw: string | null): string | null {
    if (!raw) return null;
    const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(raw.trim());
    return match ? `#${match[1]!.toLowerCase()}` : null;
}

/** The TZID a `calendar-timezone` VCALENDAR declares, if any. */
function timezoneOf(vcalendar: string | null): string | null {
    if (!vcalendar) return null;
    const match = /^TZID[;:](?:[^:\r\n]*:)?([^\r\n]+)$/m.exec(vcalendar.replace(/\r\n[ \t]/g, ""));
    return match ? match[1]!.trim() : null;
}

/** Privileges that let the current user change what is in a calendar. */
const WRITE_PRIVILEGES = new Set(["write", "write-content", "all", "bind"]);

function isReadOnly(response: dav.DavResponse): boolean {
    const set = dav.prop(response, dav.DAV, "current-user-privilege-set");
    // A server that does not say is assumed writable; a write that it then
    // refuses surfaces as a refusal on that object, not as a broken calendar.
    if (!set) return false;
    for (const privilege of childrenOf(set, dav.DAV, "privilege")) {
        if (privilege.children.some((p) => p.ns === dav.DAV && WRITE_PRIVILEGES.has(p.local))) return false;
    }
    return true;
}

function componentsOf(response: dav.DavResponse): ("VEVENT" | "VTODO")[] {
    const set = dav.prop(response, dav.CALDAV, "supported-calendar-component-set");
    if (!set) return ["VEVENT", "VTODO"];
    const names = new Set(childrenOf(set, dav.CALDAV, "comp").map((c) => (c.attrs.get("name") ?? "").toUpperCase()));
    const out: ("VEVENT" | "VTODO")[] = [];
    if (names.has("VEVENT")) out.push("VEVENT");
    if (names.has("VTODO")) out.push("VTODO");
    return out;
}

/** Reads the calendars under a home (Depth 1), skipping the home itself and anything that is not a calendar. */
async function listUnder(credentials: dav.DavCredentials, homeUrl: string): Promise<RemoteCalendar[]> {
    const { multistatus } = await dav.davMultistatus(credentials, "PROPFIND", asCollection(homeUrl), "1", CALENDARS_BODY);
    const home = dav.hrefKey(asCollection(homeUrl));
    const calendars: RemoteCalendar[] = [];
    for (const response of multistatus.responses) {
        if (dav.hrefKey(asCollection(response.href)) === home) continue;
        if (!dav.hasType(response, dav.CALDAV, "calendar")) continue;
        const components = componentsOf(response);
        if (components.length === 0) continue;
        const remoteId = asCollection(response.href);
        const name = dav.propText(response, dav.DAV, "displayname") || decodeURIComponent(new URL(remoteId).pathname.split("/").filter(Boolean).pop() ?? "");
        calendars.push({
            remoteId,
            name,
            color: normalizeDavColor(dav.propText(response, dav.APPLE, "calendar-color")),
            description: dav.propText(response, dav.CALDAV, "calendar-description") ?? "",
            timezone: timezoneOf(dav.propText(response, dav.CALDAV, "calendar-timezone")),
            readOnly: isReadOnly(response),
            components
        });
    }
    return calendars;
}

/** The calendar home a principal points at, or null when it names none. */
async function homeOf(credentials: dav.DavCredentials, principalUrl: string): Promise<string | null> {
    const { multistatus, url } = await dav.davMultistatus(credentials, "PROPFIND", principalUrl, "0", HOME_BODY);
    return dav.propHref(multistatus.responses[0], dav.CALDAV, "calendar-home-set", url);
}

interface Located {
    serverUrl: string;
    principalUrl: string;
    homeUrl: string;
}

/**
 * Finds the principal and calendar home from whatever address was given.
 *
 * A bare host tries `/.well-known/caldav` first (RFC 6764 section 5), then the
 * root. An address that is itself a calendar home - some people paste that -
 * is accepted as one when no principal can be found from it.
 */
async function locate(credentials: dav.DavCredentials, raw: string): Promise<Located> {
    const given = normalizeServerUrl(raw);
    const candidates = given.pathname === "/" || given.pathname === "" ? [new URL("/.well-known/caldav", given).href, given.href] : [given.href];
    let lastError: unknown = null;
    let answered: string | null = null;
    for (const candidate of candidates) {
        try {
            const { multistatus, url } = await dav.davMultistatus(credentials, "PROPFIND", candidate, "0", PRINCIPAL_BODY);
            const first = multistatus.responses[0];
            answered ??= url.href;
            const principal = dav.propHref(first, dav.DAV, "current-user-principal", url) ?? (dav.hasType(first, dav.DAV, "principal") ? url.href : null);
            const directHome = dav.propHref(first, dav.CALDAV, "calendar-home-set", url);
            if (principal) {
                const home = (principal === url.href ? directHome : null) ?? (await homeOf(credentials, principal)) ?? directHome;
                if (home) return { serverUrl: url.href, principalUrl: principal, homeUrl: asCollection(home) };
            } else if (directHome) {
                return { serverUrl: url.href, principalUrl: url.href, homeUrl: asCollection(directHome) };
            }
        } catch (error) {
            if (error instanceof SyncAuthError) throw error;
            lastError = error;
        }
    }
    if (answered) {
        // The server speaks WebDAV but named no principal: treat the address as
        // the home, which is what a pasted home URL is.
        return { serverUrl: answered, principalUrl: answered, homeUrl: asCollection(answered) };
    }
    if (lastError instanceof Error) throw lastError;
    throw new SyncNotFoundError("No CalDAV service found at that address", null);
}

/**
 * Discovers a CalDAV account: where it lives and which calendars it has.
 *
 * Throws `SyncAuthError` when the password is refused, so the form can say that
 * rather than "not found".
 */
export async function discoverCalDav(input: { url: string; username: string; password: string; fetcher: Fetcher }): Promise<{
    serverUrl: string;
    principalUrl: string;
    homeUrl: string;
    calendars: RemoteCalendar[];
}> {
    const credentials: dav.DavCredentials = { username: input.username, password: input.password, fetcher: input.fetcher };
    const located = await locate(credentials, input.url);
    const calendars = await listUnder(credentials, located.homeUrl);
    return { ...located, calendars };
}

/** Statuses on a sync REPORT that mean "use the fallback", not "fail". */
const SYNC_FALLBACK_STATUSES = new Set([400, 403, 405, 409, 412, 415, 422, 501]);

/** The path to put in an `<href>`: servers expect their own paths, not absolute URLs. */
function hrefFor(url: string, collection: string): string {
    const target = new URL(url);
    return target.origin === new URL(collection).origin ? target.pathname : target.href;
}

/** A CalDAV account as a `CalendarProvider`. */
export function createCalDavProvider(input: { serverUrl: string; username: string; password: string; fetcher: Fetcher }): CalendarProvider {
    const credentials: dav.DavCredentials = { username: input.username, password: input.password, fetcher: input.fetcher };
    let home: string | null = null;

    /** Fetches bodies with calendar-multiget, falling back to one GET each. */
    const fetchBodies = async (collection: string, wanted: ReadonlyMap<string, string>): Promise<{ objects: RemoteObject[]; gone: string[] }> => {
        const objects: RemoteObject[] = [];
        const gone: string[] = [];
        const byKey = new Map<string, string>();
        for (const href of wanted.keys()) byKey.set(dav.hrefKey(href), href);
        const hrefs = [...wanted.keys()];
        let multiget = true;
        for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
            const batch = hrefs.slice(i, i + MULTIGET_BATCH);
            const missing = new Set(batch);
            if (multiget) {
                try {
                    const { multistatus } = await dav.davMultistatus(credentials, "REPORT", collection, "1", multigetBody(batch.map((h) => hrefFor(h, collection))));
                    for (const response of multistatus.responses) {
                        const href = byKey.get(dav.hrefKey(response.href));
                        if (!href) continue;
                        if (response.status === 404) {
                            gone.push(href);
                            missing.delete(href);
                            continue;
                        }
                        const ics = dav.prop(response, dav.CALDAV, "calendar-data");
                        if (!ics) continue;
                        objects.push({ href, etag: dav.propText(response, dav.DAV, "getetag") ?? wanted.get(href) ?? "", ics: ics.text });
                        missing.delete(href);
                    }
                } catch (error) {
                    if (!(error instanceof SyncRefusedError) && !(error instanceof SyncNotFoundError)) throw error;
                    multiget = false;
                }
            }
            for (const href of missing) {
                const { response } = await dav.davRequest(credentials, "GET", href, { headers: { Accept: "text/calendar" } });
                if (response.status === 404 || response.status === 410) {
                    await response.body?.cancel().catch(() => undefined);
                    gone.push(href);
                    continue;
                }
                if (!response.ok) throw errorFor(response, await reasonOf(response));
                const ics = await readCapped(response, MAX_RESPONSE_BYTES);
                objects.push({ href, etag: response.headers.get("etag") ?? wanted.get(href) ?? "", ics });
            }
        }
        return { objects, gone };
    };

    /** Lists every member's etag (Depth 1), the fallback when sync-collection is not there. */
    const listEtags = async (collection: string): Promise<Map<string, string>> => {
        const { multistatus } = await dav.davMultistatus(credentials, "PROPFIND", collection, "1", ETAGS_BODY);
        const self = dav.hrefKey(collection);
        const etags = new Map<string, string>();
        for (const response of multistatus.responses) {
            if (dav.hrefKey(response.href) === self || dav.hasType(response, dav.DAV, "collection")) continue;
            const etag = dav.propText(response, dav.DAV, "getetag");
            if (etag !== null) etags.set(response.href, etag);
        }
        return etags;
    };

    /** Diffs the server's etags against what is held: exact, one listing plus the changed bodies. */
    const diffPull = async (collection: string, state: PullState, syncToken: string, ctag: string): Promise<ChangeSet> => {
        const remote = await listEtags(collection);
        const knownByKey = new Map<string, [string, string]>();
        for (const [href, etag] of state.known) knownByKey.set(dav.hrefKey(href), [href, etag]);
        const wanted = new Map<string, string>();
        const seen = new Set<string>();
        for (const [href, etag] of remote) {
            const key = dav.hrefKey(href);
            seen.add(key);
            const held = knownByKey.get(key);
            if (!held || held[1] !== etag) wanted.set(held ? held[0] : href, etag);
        }
        const removed = [...knownByKey.entries()].filter(([key]) => !seen.has(key)).map(([, [href]]) => href);
        const { objects, gone } = await fetchBodies(collection, wanted);
        return { changed: objects, removed: [...removed, ...gone], syncToken, ctag, full: false };
    };

    /** RFC 6578 sync-collection from a token; null when the server will not do it. */
    const syncPull = async (collection: string, token: string, state: PullState, ctag: string): Promise<ChangeSet | null> => {
        const changedEtags = new Map<string, string>();
        const removed = new Set<string>();
        const self = dav.hrefKey(collection);
        let current = token;
        for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
            let result;
            try {
                result = await dav.davMultistatus(credentials, "REPORT", collection, "0", syncBody(current));
            } catch (error) {
                // A refused token (403/409 valid-sync-token, 412) or a server that
                // does not know the report: the etag diff is exact either way.
                if (error instanceof SyncError && SYNC_FALLBACK_STATUSES.has(error.status ?? 0)) return null;
                throw error;
            }
            let truncated = false;
            for (const response of result.multistatus.responses) {
                if (dav.hrefKey(response.href) === self) {
                    if (response.status === 507) truncated = true;
                    continue;
                }
                if (response.status === 404) {
                    removed.add(response.href);
                    changedEtags.delete(response.href);
                    continue;
                }
                const etag = dav.propText(response, dav.DAV, "getetag");
                if (etag === null || dav.hasType(response, dav.DAV, "collection")) continue;
                removed.delete(response.href);
                changedEtags.set(response.href, etag);
            }
            const next = result.multistatus.syncToken;
            if (!next) return null;
            current = next;
            if (!truncated) break;
            if (round === MAX_SYNC_ROUNDS - 1) throw new SyncUnreachableError("The server kept truncating its change list", 507);
        }
        // Report only what differs from what is held, keyed as the caller holds it.
        const knownByKey = new Map<string, [string, string]>();
        for (const [href, etag] of state.known) knownByKey.set(dav.hrefKey(href), [href, etag]);
        const wanted = new Map<string, string>();
        for (const [href, etag] of changedEtags) {
            const held = knownByKey.get(dav.hrefKey(href));
            if (!held || held[1] !== etag) wanted.set(held ? held[0] : href, etag);
        }
        const removedHrefs = [...removed].map((href) => knownByKey.get(dav.hrefKey(href))?.[0] ?? href);
        const { objects, gone } = await fetchBodies(collection, wanted);
        return { changed: objects, removed: [...removedHrefs, ...gone], syncToken: current, ctag, full: false };
    };

    return {
        async listCalendars() {
            if (!home) home = (await locate(credentials, input.serverUrl)).homeUrl;
            return listUnder(credentials, home);
        },

        async pull(state) {
            const collection = asCollection(state.remoteId);
            const { multistatus } = await dav.davMultistatus(credentials, "PROPFIND", collection, "0", STATE_BODY);
            const self = multistatus.responses[0];
            const ctag = dav.propText(self, dav.CS, "getctag") ?? "";
            const serverToken = dav.propText(self, dav.DAV, "sync-token") ?? "";

            if (state.syncToken && serverToken) {
                if (serverToken === state.syncToken) return { changed: [], removed: [], syncToken: serverToken, ctag, full: false };
                const synced = await syncPull(collection, state.syncToken, state, ctag);
                if (synced) return synced;
            } else if (!serverToken && ctag && ctag === state.ctag) {
                // No sync-collection here; an unchanged ctag means nothing changed.
                return { changed: [], removed: [], syncToken: "", ctag, full: false };
            }
            // First pull, an expired token, or no sync support: diff by etag. The
            // token read before the listing is stored, so anything changed while
            // listing is reported again next time rather than missed.
            return diffPull(collection, state, serverToken, ctag);
        },

        async put(target, object) {
            const collection = asCollection(target.remoteId);
            const url = object.href ?? new URL(`${encodeURIComponent(object.uid)}.ics`, collection).href;
            const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
            if (object.href === null) headers["If-None-Match"] = "*";
            else if (object.etag) headers["If-Match"] = object.etag;
            const { response } = await dav.davRequest(credentials, "PUT", url, { body: object.ics, headers });
            if (!response.ok) throw errorFor(response, await reasonOf(response));
            await response.body?.cancel().catch(() => undefined);
            const etag = response.headers.get("etag");
            if (etag) return { href: url, etag };
            // The server changed the object as it stored it (or does not say):
            // ask for the etag it now has.
            const { multistatus } = await dav.davMultistatus(credentials, "PROPFIND", url, "0", ETAG_BODY);
            return { href: url, etag: dav.propText(multistatus.responses[0], dav.DAV, "getetag") ?? "" };
        },

        async remove(_target, object) {
            const headers: Record<string, string> = {};
            if (object.etag) headers["If-Match"] = object.etag;
            const { response } = await dav.davRequest(credentials, "DELETE", object.href, { headers });
            await response.body?.cancel().catch(() => undefined);
            if (response.ok || response.status === 404 || response.status === 410) return;
            throw errorFor(response);
        }
    };
}
