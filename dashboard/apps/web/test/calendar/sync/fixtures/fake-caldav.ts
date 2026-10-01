/**
 * An in-memory CalDAV server, as a `Fetcher`, for the sync client tests.
 *
 * Just enough of RFC 4791 / 6578 / 6764 to drive every path the client takes:
 * `.well-known` redirects, principal and home discovery, calendar listing,
 * `sync-collection` with changes and deletions (or none at all, to force the
 * ctag + etag fallback), `calendar-multiget`, and conditional PUT/DELETE that
 * answer 412 the way a real server does. The XML it writes uses whichever
 * namespace prefixes the test asks for, so the client is proven not to depend
 * on them.
 */

import { parseXml, type XmlElement } from "@polaris-app/calendar/src/lib/sync/xml";

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";

export interface FakeObject {
    etag: string;
    ics: string;
}

export interface FakeCalendar {
    /** Path of the collection, ending in "/". */
    path: string;
    name: string;
    color: string | null;
    components: string[];
    readOnly: boolean;
    objects: Map<string, FakeObject>;
    ctag: number;
    /** Change log: the token number after each change and what it touched. */
    log: { token: number; name: string; deleted: boolean }[];
}

export interface FakeCalDavOptions {
    /** Every origin this server answers on (the first is where discovery starts). */
    origins: string[];
    username: string;
    password: string;
    /** Prefix for the DAV: namespace; "" puts DAV: in the default namespace. */
    davPrefix?: string;
    /** Where `.well-known/caldav` redirects; null answers 404 there. */
    wellKnown?: string | null;
    /** Principal URL (may be absolute on another origin, as iCloud's is). */
    principal: string;
    home: string;
    /** False: no sync-token property and REPORT sync-collection is refused. */
    supportsSync?: boolean;
    /** False: calendar-multiget is refused, forcing a GET per object. */
    supportsMultiget?: boolean;
    /** False: a PUT does not return an ETag header. */
    etagOnPut?: boolean;
}

export interface Recorded {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
}

let etagCounter = 0;

export function createFakeCalDav(options: FakeCalDavOptions) {
    const calendars: FakeCalendar[] = [];
    const requests: Recorded[] = [];
    const withoutEtag = new Set<string>();
    let token = 1;
    const p = options.davPrefix ?? "d";
    const d = (name: string) => (p ? `${p}:${name}` : name);
    const rootAttrs = `${p ? `xmlns:${p}="DAV:"` : 'xmlns="DAV:"'} xmlns:C="${CALDAV}" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"`;
    const expectedAuth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    const supportsSync = options.supportsSync ?? true;

    const multistatus = (responses: string[], extra = "") =>
        `<?xml version="1.0" encoding="utf-8"?>\n<${d("multistatus")} ${rootAttrs}>${responses.join("")}${extra}</${d("multistatus")}>`;

    const response = (href: string, props: string, missing = "") =>
        `<${d("response")}><${d("href")}>${href}</${d("href")}><${d("propstat")}><${d("prop")}>${props}</${d("prop")}><${d("status")}>HTTP/1.1 200 OK</${d("status")}></${d("propstat")}>${
            missing
                ? `<${d("propstat")}><${d("prop")}>${missing}</${d("prop")}><${d("status")}>HTTP/1.1 404 Not Found</${d("status")}></${d("propstat")}>`
                : ""
        }</${d("response")}>`;

    const reply = (status: number, body = "", headers: Record<string, string> = {}) =>
        new Response(status === 204 || status === 304 ? null : body, {
            status,
            headers: { "Content-Type": "application/xml; charset=utf-8", ...headers }
        });

    const pathOf = (url: string) => new URL(url).pathname;
    const calendarAt = (path: string) =>
        calendars.find((c) => c.path === path || c.path === `${path}/`);
    const objectAt = (path: string) => {
        const slash = path.lastIndexOf("/");
        const calendar = calendarAt(path.slice(0, slash + 1));
        return calendar ? { calendar, name: decodeURIComponent(path.slice(slash + 1)) } : null;
    };
    const syncToken = () => `http://example.invalid/sync/${token}`;

    const change = (calendar: FakeCalendar, name: string, deleted: boolean) => {
        token++;
        calendar.ctag++;
        calendar.log.push({ token, name, deleted });
    };

    const pathMatches = (url: string, target: string) => {
        const absolute = new URL(target, options.origins[0]).href;
        return url === absolute || pathOf(url) === target;
    };

    const findText = (root: XmlElement, ns: string, local: string): string | null => {
        const stack = [root];
        while (stack.length) {
            const el = stack.pop()!;
            if (el.ns === ns && el.local === local) return el.text;
            stack.push(...el.children);
        }
        return null;
    };

    const hrefsIn = (root: XmlElement): string[] =>
        root.children.filter((c) => c.ns === DAV && c.local === "href").map((c) => c.text.trim());

    const calendarProps = (calendar: FakeCalendar) => {
        const comps = calendar.components.map((c) => `<C:comp name="${c}"/>`).join("");
        const privileges = calendar.readOnly
            ? `<${d("privilege")}><${d("read")}/></${d("privilege")}>`
            : `<${d("privilege")}><${d("read")}/></${d("privilege")}><${d("privilege")}><${d("write")}/></${d("privilege")}>`;
        return [
            `<${d("resourcetype")}><${d("collection")}/><C:calendar/></${d("resourcetype")}>`,
            `<${d("displayname")}>${calendar.name}</${d("displayname")}>`,
            calendar.color ? `<A:calendar-color>${calendar.color}</A:calendar-color>` : "",
            `<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>`,
            `<${d("current-user-privilege-set")}>${privileges}</${d("current-user-privilege-set")}>`,
            `<CS:getctag>"ctag-${calendar.ctag}"</CS:getctag>`,
            supportsSync ? `<${d("sync-token")}>${syncToken()}</${d("sync-token")}>` : ""
        ].join("");
    };

    const fetcher = async (
        url: string,
        init: RequestInit & { timeoutMs?: number }
    ): Promise<Response> => {
        const method = (init.method ?? "GET").toUpperCase();
        const headers = Object.fromEntries(
            Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
                k.toLowerCase(),
                v
            ])
        );
        const body = typeof init.body === "string" ? init.body : "";
        requests.push({ method, url, headers, body });
        if (!options.origins.includes(new URL(url).origin)) throw new TypeError("fetch failed");
        const path = pathOf(url);

        if (path === "/.well-known/caldav") {
            if (options.wellKnown) return reply(301, "", { Location: options.wellKnown });
            return reply(404);
        }
        if (headers.authorization !== expectedAuth)
            return reply(401, "", { "WWW-Authenticate": 'Basic realm="fake"' });

        if (method === "PROPFIND") {
            const depth = headers.depth ?? "0";
            if (pathMatches(url, options.principal)) {
                return reply(
                    207,
                    multistatus([
                        response(
                            path,
                            `<C:calendar-home-set><${d("href")}>${options.home}</${d("href")}></C:calendar-home-set>`
                        )
                    ])
                );
            }
            if (pathMatches(url, options.home)) {
                const rows = [
                    response(
                        pathOf(new URL(options.home, options.origins[0]).href),
                        `<${d("resourcetype")}><${d("collection")}/></${d("resourcetype")}>`
                    )
                ];
                if (depth === "1") {
                    for (const calendar of calendars)
                        rows.push(response(calendar.path, calendarProps(calendar)));
                    rows.push(
                        response(
                            `${pathOf(new URL(options.home, options.origins[0]).href)}inbox/`,
                            `<${d("resourcetype")}><${d("collection")}/><C:schedule-inbox/></${d("resourcetype")}>`
                        )
                    );
                }
                return reply(207, multistatus(rows));
            }
            const calendar = calendarAt(path);
            if (calendar) {
                if (depth === "0")
                    return reply(
                        207,
                        multistatus([response(calendar.path, calendarProps(calendar))])
                    );
                const rows = [
                    response(
                        calendar.path,
                        `<${d("resourcetype")}><${d("collection")}/><C:calendar/></${d("resourcetype")}>`
                    )
                ];
                for (const [name, object] of calendar.objects) {
                    const href = `${calendar.path}${encodeURIComponent(name)}`;
                    if (withoutEtag.has(name))
                        rows.push(response(href, `<${d("resourcetype")}/>`, `<${d("getetag")}/>`));
                    else
                        rows.push(
                            response(
                                href,
                                `<${d("resourcetype")}/><${d("getetag")}>${object.etag}</${d("getetag")}>`
                            )
                        );
                }
                return reply(207, multistatus(rows));
            }
            const target = objectAt(path);
            const object = target?.calendar.objects.get(target.name);
            if (object)
                return reply(
                    207,
                    multistatus([
                        response(path, `<${d("getetag")}>${object.etag}</${d("getetag")}>`)
                    ])
                );
            // Anything else is a context root: it names the principal.
            return reply(
                207,
                multistatus([
                    response(
                        path,
                        `<${d("current-user-principal")}><${d("href")}>${options.principal}</${d("href")}></${d("current-user-principal")}><${d("resourcetype")}><${d("collection")}/></${d("resourcetype")}>`,
                        "<C:calendar-home-set/>"
                    )
                ])
            );
        }

        if (method === "REPORT") {
            const calendar = calendarAt(path);
            if (!calendar) return reply(404);
            const root = parseXml(body);
            if (root.local === "sync-collection") {
                if (!supportsSync) return reply(501, "REPORT not implemented");
                const given = findText(root, DAV, "sync-token") ?? "";
                const match = /\/sync\/(\d+)$/.exec(given);
                if (given !== "" && (!match || Number(match[1]) > token || Number(match[1]) < 0)) {
                    return reply(
                        403,
                        `<?xml version="1.0"?><${d("error")} ${rootAttrs}><${d("valid-sync-token")}/></${d("error")}>`
                    );
                }
                const since = match ? Number(match[1]) : 0;
                const latest = new Map<string, boolean>();
                for (const entry of calendar.log)
                    if (entry.token > since) latest.set(entry.name, entry.deleted);
                const rows: string[] = [];
                for (const [name, deleted] of latest) {
                    const href = `${calendar.path}${encodeURIComponent(name)}`;
                    const object = calendar.objects.get(name);
                    if (deleted || !object)
                        rows.push(
                            `<${d("response")}><${d("href")}>${href}</${d("href")}><${d("status")}>HTTP/1.1 404 Not Found</${d("status")}></${d("response")}>`
                        );
                    else
                        rows.push(
                            response(href, `<${d("getetag")}>${object.etag}</${d("getetag")}>`)
                        );
                }
                return reply(
                    207,
                    multistatus(rows, `<${d("sync-token")}>${syncToken()}</${d("sync-token")}>`)
                );
            }
            if (root.local === "calendar-multiget") {
                if (options.supportsMultiget === false) return reply(400, "Unsupported report");
                const rows = hrefsIn(root).map((href) => {
                    const target = objectAt(new URL(href, url).pathname);
                    const object = target?.calendar.objects.get(target.name);
                    if (!object)
                        return `<${d("response")}><${d("href")}>${href}</${d("href")}><${d("status")}>HTTP/1.1 404 Not Found</${d("status")}></${d("response")}>`;
                    return response(
                        href,
                        `<${d("getetag")}>${object.etag}</${d("getetag")}><C:calendar-data><![CDATA[${object.ics}]]></C:calendar-data>`
                    );
                });
                return reply(207, multistatus(rows));
            }
            return reply(400);
        }

        const target = objectAt(path);
        if (!target) return reply(404);
        const existing = target.calendar.objects.get(target.name);
        if (method === "GET") {
            if (!existing) return reply(404);
            return new Response(existing.ics, {
                status: 200,
                headers: { "Content-Type": "text/calendar", ETag: existing.etag }
            });
        }
        if (method === "PUT") {
            if (headers["if-none-match"] === "*" && existing) return reply(412);
            if (headers["if-match"] && headers["if-match"] !== existing?.etag) return reply(412);
            const etag = `"e${++etagCounter}"`;
            target.calendar.objects.set(target.name, { etag, ics: body });
            change(target.calendar, target.name, false);
            return reply(
                existing ? 204 : 201,
                "",
                options.etagOnPut === false ? {} : { ETag: etag }
            );
        }
        if (method === "DELETE") {
            if (!existing) return reply(404);
            if (headers["if-match"] && headers["if-match"] !== existing.etag) return reply(412);
            target.calendar.objects.delete(target.name);
            change(target.calendar, target.name, true);
            return reply(204);
        }
        return reply(405);
    };

    return {
        fetcher,
        calendars,
        requests,
        /** Members a Depth 1 listing names with their getetag as 404. */
        withoutEtag,
        addCalendar(
            calendar: Partial<FakeCalendar> & { path: string; name: string }
        ): FakeCalendar {
            const full: FakeCalendar = {
                color: null,
                components: ["VEVENT", "VTODO"],
                readOnly: false,
                objects: new Map(),
                ctag: 1,
                log: [],
                ...calendar
            };
            calendars.push(full);
            return full;
        },
        /** Changes an object as another client would. */
        write(calendar: FakeCalendar, name: string, ics: string): string {
            const etag = `"e${++etagCounter}"`;
            calendar.objects.set(name, { etag, ics });
            change(calendar, name, false);
            return etag;
        },
        erase(calendar: FakeCalendar, name: string) {
            calendar.objects.delete(name);
            change(calendar, name, true);
        }
    };
}

/** A minimal event object. */
export function vevent(uid: string, summary: string): string {
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Fake//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20261001T090000Z",
        "DTEND:20261001T100000Z",
        `SUMMARY:${summary}`,
        "END:VEVENT",
        "END:VCALENDAR",
        ""
    ].join("\r\n");
}
