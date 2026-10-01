/**
 * An in-memory Google Calendar API v3, as a `Fetcher`.
 *
 * Models what the client relies on: paging, sync tokens that expire (410),
 * deleted events coming back as `status: "cancelled"` with little else, the
 * `iCalUID` filter returning a master with its exceptions, etags checked by
 * `If-Match` (412), an insert of a UID already there refused (409), and
 * instance ids of the form `<masterId>_<start>`.
 */

type Json = Record<string, unknown>;

export interface FakeGoogleEvent extends Json {
    id: string;
    etag: string;
    status?: string;
    iCalUID?: string;
    recurringEventId?: string;
    originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
}

export interface GoogleRecorded {
    method: string;
    url: URL;
    headers: Record<string, string>;
    body: Json | null;
}

export function createFakeGoogle(options: { pageSize?: number; calendarId?: string } = {}) {
    const calendarId = options.calendarId ?? "primary@example.test";
    const pageSize = options.pageSize ?? 2;
    const events = new Map<string, { event: FakeGoogleEvent; seq: number }>();
    const requests: GoogleRecorded[] = [];
    const expired = new Set<string>();
    let seq = 0;
    let etagCounter = 0;
    let idCounter = 0;
    let failNext: Response | null = null;

    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
    const error = (status: number, message: string, reason: string) => json(status, { error: { code: status, message, errors: [{ reason, message }] } });

    const store = (event: FakeGoogleEvent) => {
        seq++;
        events.set(event.id, { event, seq });
        return event;
    };
    const nextEtag = () => `"${++etagCounter}000"`;

    /** "20261008T090000Z" or "20261008" as a Google original start. */
    const originalFromStamp = (stamp: string): FakeGoogleEvent["originalStartTime"] => {
        if (/^\d{8}$/.test(stamp)) return { date: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` };
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
        return m ? { dateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` } : undefined;
    };

    const fetcher = async (raw: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> => {
        const url = new URL(raw);
        const method = (init.method ?? "GET").toUpperCase();
        const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Json) : null;
        requests.push({ method, url, headers, body });
        if (headers.authorization !== "Bearer token-1") return error(401, "Invalid Credentials", "authError");
        if (failNext) {
            const response = failNext;
            failNext = null;
            return response;
        }
        const path = decodeURIComponent(url.pathname.replace(/^\/calendar\/v3/, ""));

        if (path === "/users/me/calendarList") {
            return json(200, {
                items: [
                    { id: calendarId, summary: "Me", timeZone: "Europe/Madrid", backgroundColor: "#9FE1E7", accessRole: "owner" },
                    { id: "holidays@group.v.calendar.google.com", summary: "Holidays", summaryOverride: "Festivos", timeZone: "Europe/Madrid", backgroundColor: "#16A765", accessRole: "reader" },
                    { id: "busy@example.test", summary: "Busy", accessRole: "freeBusyReader" }
                ]
            });
        }
        if (path === "/colors") return json(200, { event: { "5": { background: "#fbd75b", foreground: "#1d1d1d" }, "11": { background: "#dc2127", foreground: "#1d1d1d" } } });

        const listPath = `/calendars/${calendarId}/events`;
        if (path === listPath && method === "GET") {
            const syncToken = url.searchParams.get("syncToken");
            const uid = url.searchParams.get("iCalUID");
            if (syncToken && expired.has(syncToken)) return error(410, "Sync token is no longer valid, a full sync is required.", "fullSyncRequired");
            let all = [...events.values()].sort((a, b) => a.seq - b.seq);
            if (syncToken) {
                const since = Number(/^tok-(\d+)$/.exec(syncToken)?.[1] ?? "-1");
                if (since < 0) return error(400, "Invalid sync token", "invalid");
                all = all.filter((e) => e.seq > since);
            } else if (url.searchParams.get("showDeleted") !== "true") all = all.filter((e) => e.event.status !== "cancelled");
            if (uid) all = all.filter((e) => e.event.iCalUID === uid);
            const offset = Number(url.searchParams.get("pageToken") ?? "0");
            const page = all.slice(offset, offset + pageSize).map((e) => {
                // A deleted event in an incremental listing carries almost nothing.
                if (syncToken && e.event.status === "cancelled" && !e.event.recurringEventId) return { id: e.event.id, status: "cancelled", etag: e.event.etag };
                if (syncToken && e.event.status === "cancelled") return { id: e.event.id, status: "cancelled", etag: e.event.etag, recurringEventId: e.event.recurringEventId, originalStartTime: e.event.originalStartTime };
                return e.event;
            });
            const more = offset + pageSize < all.length;
            return json(200, { kind: "calendar#events", items: page, ...(more ? { nextPageToken: String(offset + pageSize) } : { nextSyncToken: `tok-${seq}` }) });
        }
        if (path === listPath && method === "POST") {
            const uid = body?.iCalUID as string | undefined;
            if (uid && [...events.values()].some((e) => e.event.iCalUID === uid && !e.event.recurringEventId)) {
                return error(409, "The requested identifier already exists.", "duplicate");
            }
            const id = `ev${++idCounter}`;
            const fields = Object.fromEntries(Object.entries(body ?? {}).filter(([, value]) => value !== null));
            const created = store({ ...fields, id, etag: nextEtag(), iCalUID: (body?.iCalUID as string) ?? `${id}@google.com`, status: "confirmed" } as FakeGoogleEvent);
            return json(200, created);
        }
        if (path.startsWith(`${listPath}/`)) {
            const id = path.slice(listPath.length + 1);
            let current = events.get(id)?.event;
            if (!current && method === "PATCH") {
                // An instance id of a recurring master: materialise the exception.
                const cut = id.lastIndexOf("_");
                const master = cut > 0 ? events.get(id.slice(0, cut))?.event : undefined;
                const original = cut > 0 ? originalFromStamp(id.slice(cut + 1)) : undefined;
                if (!master || !original) return error(404, "Not Found", "notFound");
                current = { id, etag: nextEtag(), iCalUID: master.iCalUID, recurringEventId: master.id, originalStartTime: original, status: "confirmed" };
            }
            if (!current) return error(404, "Not Found", "notFound");
            if (headers["if-match"] && headers["if-match"] !== current.etag) return error(412, "Precondition Failed", "conditionNotMet");
            if (method === "GET") return json(200, current);
            if (method === "PATCH") {
                const merged: FakeGoogleEvent = { ...current, ...(body as Json), id, etag: nextEtag(), iCalUID: current.iCalUID } as FakeGoogleEvent;
                for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
                return json(200, store(merged));
            }
            if (method === "DELETE") {
                store({ ...current, status: "cancelled", etag: nextEtag() });
                return new Response(null, { status: 204 });
            }
        }
        return error(404, "Not Found", "notFound");
    };

    return {
        fetcher,
        calendarId,
        requests,
        accessToken: async () => "token-1",
        /** Adds or replaces an event as if changed in Google's own UI. */
        put(event: Omit<FakeGoogleEvent, "etag"> & { etag?: string }): FakeGoogleEvent {
            return store({ ...event, etag: nextEtag() } as FakeGoogleEvent);
        },
        get(id: string): FakeGoogleEvent | undefined {
            return events.get(id)?.event;
        },
        /** Deletes as Google does: the event stays, cancelled, for sync clients. */
        cancel(id: string) {
            const current = events.get(id)?.event;
            if (current) store({ ...current, status: "cancelled", etag: nextEtag() });
        },
        expire(token: string) {
            expired.add(token);
        },
        failWith(response: Response) {
            failNext = response;
        }
    };
}
