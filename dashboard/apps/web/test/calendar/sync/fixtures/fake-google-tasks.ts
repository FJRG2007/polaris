/**
 * An in-memory Google Tasks API v1 in front of the fake Calendar API, as one
 * `Fetcher`: requests to tasks.googleapis.com land here, everything else goes
 * on to the calendar fake.
 *
 * Models what the client relies on: lists and tasks in pages, `updatedMin`
 * returning what changed (deletions included with `showDeleted`), completed
 * tasks hidden unless `showHidden`, `due` kept as a date, an insert, a patch
 * where `null` clears a field, a delete that leaves the task marked deleted -
 * and an account that never granted the tasks, or a project with the API off.
 */

type Json = Record<string, unknown>;
type Fetcher = (url: string, init: RequestInit & { timeoutMs?: number }) => Promise<Response>;

export interface FakeTask extends Json {
    id: string;
    etag: string;
    updated: string;
    title?: string;
    status?: string;
}

const PROJECT = "100000000001";

export function withGoogleTasks(calendar: Fetcher, options: { pageSize?: number } = {}) {
    const pageSize = options.pageSize ?? 2;
    const lists = new Map<string, { id: string; title: string }>();
    const tasks = new Map<string, Map<string, FakeTask>>();
    const requests: { method: string; url: URL; body: Json | null }[] = [];
    let mode: "ok" | "scope" | "disabled" | "garbled" = "ok";
    let clock = Date.parse("2026-10-01T08:00:00.000Z");
    let ids = 0;

    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" }
        });
    const tick = () => new Date((clock += 1000)).toISOString();
    const stamp = (task: Omit<FakeTask, "etag" | "updated">): FakeTask => {
        const updated = tick();
        return { ...task, updated, etag: `"${Date.parse(updated)}"` } as FakeTask;
    };
    const page = <T>(items: T[], url: URL) => {
        const offset = Number(url.searchParams.get("pageToken") ?? "0");
        const slice = items.slice(offset, offset + pageSize);
        const more = offset + pageSize < items.length;
        return { items: slice, ...(more ? { nextPageToken: String(offset + pageSize) } : {}) };
    };

    const fetcher: Fetcher = async (raw, init) => {
        const url = new URL(raw);
        if (url.host !== "tasks.googleapis.com") return calendar(raw, init);
        const method = (init.method ?? "GET").toUpperCase();
        const body =
            typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Json) : null;
        requests.push({ method, url, body });
        if (mode === "scope")
            return json(403, {
                error: {
                    code: 403,
                    message: "Request had insufficient authentication scopes.",
                    status: "PERMISSION_DENIED",
                    details: [
                        {
                            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                            reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
                            domain: "googleapis.com"
                        }
                    ]
                }
            });
        if (mode === "disabled")
            return json(403, {
                error: {
                    code: 403,
                    message:
                        "Google Tasks API has not been used in project before or it is disabled.",
                    status: "PERMISSION_DENIED",
                    details: [
                        {
                            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                            reason: "SERVICE_DISABLED",
                            domain: "googleapis.com",
                            metadata: {
                                consumer: `projects/${PROJECT}`,
                                service: "tasks.googleapis.com",
                                containerInfo: PROJECT
                            }
                        }
                    ]
                }
            });
        if (mode === "garbled") return json(200, { items: [{ title: "no id" }] });

        const path = decodeURIComponent(url.pathname.replace(/^\/tasks\/v1/, ""));
        if (path === "/users/@me/lists" && method === "GET")
            return json(200, { kind: "tasks#taskLists", ...page([...lists.values()], url) });

        const match = /^\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(path);
        const held = match ? tasks.get(match[1]!) : undefined;
        if (!match || !held) return json(404, { error: { code: 404, message: "Not Found" } });
        const taskId = match[2];

        if (!taskId && method === "GET") {
            const since = url.searchParams.get("updatedMin");
            const all = [...held.values()].filter(
                (task) =>
                    (url.searchParams.get("showDeleted") === "true" || !task.deleted) &&
                    (url.searchParams.get("showHidden") === "true" || !task.hidden) &&
                    (!since || Date.parse(task.updated) >= Date.parse(since))
            );
            return json(200, { kind: "tasks#tasks", ...page(all, url) });
        }
        if (!taskId && method === "POST") {
            const created = stamp({ ...(body ?? {}), id: `new-${++ids}` });
            held.set(created.id, created);
            return json(200, created);
        }
        const current = taskId ? held.get(taskId) : undefined;
        if (!current || current.deleted)
            return json(404, { error: { code: 404, message: "Not Found" } });
        if (method === "PATCH") {
            const merged: Json = { ...current, ...(body ?? {}) };
            for (const [key, value] of Object.entries(merged))
                if (value === null) delete merged[key];
            if (merged.status === "completed" && !merged.completed) merged.completed = tick();
            const next = stamp(merged as FakeTask);
            held.set(next.id, next);
            return json(200, next);
        }
        if (method === "DELETE") {
            held.set(current.id, stamp({ ...current, deleted: true }));
            return new Response(null, { status: 204 });
        }
        return json(404, { error: { code: 404, message: "Not Found" } });
    };

    return {
        fetcher,
        requests,
        addList(id: string, title: string) {
            lists.set(id, { id, title });
            tasks.set(id, new Map());
        },
        /** A task as somebody left it in Google's own apps. */
        put(listId: string, task: Omit<FakeTask, "etag" | "updated">): FakeTask {
            const stored = stamp(task);
            tasks.get(listId)!.set(stored.id, stored);
            return stored;
        },
        get(listId: string, id: string): FakeTask | undefined {
            return tasks.get(listId)?.get(id);
        },
        remove(listId: string, id: string) {
            const current = tasks.get(listId)?.get(id);
            if (current) tasks.get(listId)!.set(id, stamp({ ...current, deleted: true }));
        },
        answer(next: typeof mode) {
            mode = next;
        }
    };
}
