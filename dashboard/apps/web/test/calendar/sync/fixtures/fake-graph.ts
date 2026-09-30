/**
 * An in-memory Microsoft Graph calendar, as a `Fetcher`.
 *
 * Delta rounds are scripted by the test (each a list of pages, answered with
 * `@odata.nextLink` then `@odata.deltaLink`); series masters, their exceptions
 * and occurrences live in a store the provider reads back per series. Writes
 * check `If-Match` against `@odata.etag` and answer 412 on a mismatch.
 */

type Json = Record<string, unknown>;

export const GRAPH = "https://graph.microsoft.com/v1.0";

export interface GraphRecorded {
    method: string;
    url: URL;
    headers: Record<string, string>;
    body: Json | null;
}

export function createFakeGraph() {
    const events = new Map<string, Json>();
    const instances = new Map<string, Json[]>();
    const rounds = new Map<string, { pages: Json[][]; next: string }>();
    const requests: GraphRecorded[] = [];
    let etagCounter = 0;
    let idCounter = 0;

    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const error = (status: number, code: string, message: string) => json(status, { error: { code, message } });
    const nextEtag = () => `W/"etag-${++etagCounter}"`;

    const fetcher = async (raw: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> => {
        const url = new URL(raw);
        const method = (init.method ?? "GET").toUpperCase();
        const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Json) : null;
        requests.push({ method, url, headers, body });
        if (url.origin !== "https://graph.microsoft.com") throw new TypeError("fetch failed");
        if (headers.authorization !== "Bearer graph-token") return error(401, "InvalidAuthenticationToken", "Access token is empty.");
        const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));

        if (path === "/me/calendars" && method === "GET") {
            return json(200, {
                value: [
                    { id: "cal-1", name: "Calendar", hexColor: "#E3008C", canEdit: true },
                    { id: "cal-2", name: "Shared with me", hexColor: "", canEdit: false }
                ]
            });
        }
        const delta = /^\/me\/calendars\/([^/]+)\/calendarView\/delta$/.exec(path);
        if (delta && method === "GET") {
            const skip = url.searchParams.get("$skiptoken");
            const token = url.searchParams.get("$deltatoken");
            let roundName = "initial";
            let page = 0;
            if (skip) [roundName, page] = [skip.split(".")[0]!, Number(skip.split(".")[1])];
            else if (token) roundName = token;
            else if (!url.searchParams.get("startDateTime") || !url.searchParams.get("endDateTime")) return error(400, "ErrorInvalidParameter", "startDateTime and endDateTime are required");
            if (token === "expired") return error(410, "SyncStateNotFound", "The sync state generation is not found.");
            const round = rounds.get(roundName);
            if (!round) return error(400, "ErrorInvalidParameter", "Unknown token");
            const base = `${GRAPH}/me/calendars/${delta[1]}/calendarView/delta`;
            const last = page >= round.pages.length - 1;
            return json(200, {
                value: round.pages[page] ?? [],
                ...(last ? { "@odata.deltaLink": `${base}?$deltatoken=${round.next}` } : { "@odata.nextLink": `${base}?$skiptoken=${roundName}.${page + 1}` })
            });
        }
        const instanceList = /^\/me\/events\/([^/]+)\/instances$/.exec(path);
        if (instanceList && method === "GET") return json(200, { value: instances.get(instanceList[1]!) ?? [] });
        const create = /^\/me\/calendars\/([^/]+)\/events$/.exec(path);
        if (create && method === "POST") {
            const id = `new-${++idCounter}`;
            const created = { ...(body as Json), id, "@odata.etag": nextEtag(), iCalUId: `server-uid-${id}`, type: (body as Json).recurrence ? "seriesMaster" : "singleInstance" };
            events.set(id, created);
            return json(201, created);
        }
        const one = /^\/me\/events\/([^/]+)$/.exec(path);
        if (one) {
            const id = one[1]!;
            const current = events.get(id) ?? [...instances.values()].flat().find((i) => i.id === id);
            if (!current) return error(404, "ErrorItemNotFound", "The specified object was not found in the store.");
            if (headers["if-match"] && headers["if-match"] !== current["@odata.etag"]) return error(412, "ErrorIrresolvableConflict", "The change key passed in the request does not match the current change key for the item.");
            if (method === "GET") return json(200, current);
            if (method === "PATCH") {
                const merged = { ...current, ...(body as Json), id, "@odata.etag": nextEtag() };
                if (events.has(id)) events.set(id, merged);
                else {
                    for (const list of instances.values()) {
                        const at = list.findIndex((i) => i.id === id);
                        if (at >= 0) list[at] = merged;
                    }
                }
                return json(200, merged);
            }
            if (method === "DELETE") {
                events.delete(id);
                for (const list of instances.values()) {
                    const at = list.findIndex((i) => i.id === id);
                    if (at >= 0) list.splice(at, 1);
                }
                return new Response(null, { status: 204 });
            }
        }
        return error(404, "ResourceNotFound", "Not found");
    };

    return {
        fetcher,
        requests,
        accessToken: async () => "graph-token",
        events,
        instances,
        /** Scripts one delta round: its pages, and the name of the round after it. */
        round(name: string, pages: Json[][], next: string) {
            rounds.set(name, { pages, next });
        },
        store(event: Json) {
            const stored = { ...event, "@odata.etag": event["@odata.etag"] ?? nextEtag() };
            events.set(event.id as string, stored);
            return stored;
        }
    };
}
