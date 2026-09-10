/**
 * Kept runtime logs: every replica captured, nothing stored twice, and the store
 * held to its bounds.
 *
 * The capture reads a tail every minute, so consecutive reads overlap almost
 * entirely; what makes the store usable is that the overlap is never stored
 * again. A service with replicas is several containers, each with its own place
 * in its own output. And a store with no bound is a disk that fills.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    applicationId: string;
    container: string;
    stamp: string;
    at: Date;
    text: string;
}

const rows: Row[] = [];
let nextId = 0;

const SERVICE = "0192f6a0-0000-7000-8000-000000000001";

const prisma = {
    application: {
        findMany: vi.fn(async () => [
            {
                id: SERVICE,
                slug: "web",
                currentDeploymentId: null,
                targetId: "target-1",
                target: { id: "target-1", kind: "local", hostId: null, runtime: "docker", proxyNetwork: "polaris" },
                environment: { project: { slug: "shop", ownerId: "owner-1" } }
            }
        ])
    },
    runtimeLogLine: {
        findFirst: vi.fn(
            async ({
                where,
                skip = 0
            }: {
                where: { applicationId: string; container?: string };
                skip?: number;
            }) => {
                const matching = rows
                    .filter(
                        (row) =>
                            row.applicationId === where.applicationId &&
                            (where.container === undefined || row.container === where.container)
                    )
                    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
                const row = matching[skip];
                return row ? { stamp: row.stamp } : null;
            }
        ),
        createMany: vi.fn(async ({ data }: { data: Omit<Row, "id">[] }) => {
            for (const row of data) rows.push({ ...row, id: `id-${nextId++}` });
            return { count: data.length };
        }),
        deleteMany: vi.fn(
            async ({ where }: { where: { at?: { lt: Date }; applicationId?: string; stamp?: { lte: string } } }) => {
                const before = rows.length;
                for (let index = rows.length - 1; index >= 0; index -= 1) {
                    const row = rows[index] as Row;
                    const old = where.at ? row.at < where.at.lt : true;
                    const service = where.applicationId ? row.applicationId === where.applicationId : true;
                    const upTo = where.stamp ? row.stamp <= where.stamp.lte : true;
                    if (old && service && upTo) rows.splice(index, 1);
                }
                return { count: before - rows.length };
            }
        ),
        groupBy: vi.fn(async () => {
            const counts = new Map<string, number>();
            for (const row of rows) counts.set(row.applicationId, (counts.get(row.applicationId) ?? 0) + 1);
            return [...counts].map(([applicationId, count]) => ({ applicationId, _count: { _all: count } }));
        })
    }
};

vi.mock("@polaris/db", () => ({ prisma }));

/** What each container has printed so far; a capture reads its tail. */
const output = new Map<string, string[]>();
const ports = {
    listContainers: vi.fn(async () => ["shop-web-1", "shop-web-2"]),
    logs: vi.fn(async (container: string, sink: (chunk: Buffer) => void, options?: { tail?: number }) => {
        const lines = output.get(container) ?? [];
        const tail = options?.tail === undefined ? lines : lines.slice(-options.tail);
        // Split mid-line on purpose: a pipe flushes wherever it likes.
        const text = tail.map((line) => `${line}\n`).join("");
        const cut = Math.floor(text.length / 2);
        sink(Buffer.from(text.slice(0, cut)));
        sink(Buffer.from(text.slice(cut)));
    }),
    dispose: vi.fn(async () => undefined)
};

vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn(async () => ports) }));
vi.mock("@/lib/deploy/releases", () => ({
    currentReleaseRef: vi.fn(async () => ({ name: "shop-web", project: "polaris-abc", portSubject: SERVICE }))
}));
vi.mock("@/lib/deploy-project-access", () => ({ requireApplicationAccess: vi.fn() }));

const { captureRuntimeLogs, pruneRuntimeLogs, decodeCursor, encodeCursor, RUNTIME_LOG_MAX_LINES } = await import(
    "@/lib/deploy/runtime-logs"
);

beforeEach(() => {
    rows.length = 0;
    output.clear();
});

describe("capturing", () => {
    it("keeps every replica's output and never the same line twice", async () => {
        output.set("shop-web-1", ["2026-09-10T10:00:01.1Z one-a", "2026-09-10T10:00:03Z one-b"]);
        output.set("shop-web-2", ["2026-09-10T10:00:02Z two-a"]);
        expect(await captureRuntimeLogs()).toEqual({ services: 1, lines: 3 });

        // A minute later the tail still holds everything above, plus one new line.
        output.get("shop-web-1")?.push("2026-09-10T10:01:00Z one-c");
        expect(await captureRuntimeLogs()).toEqual({ services: 1, lines: 1 });

        expect(rows.map((row) => `${row.container} ${row.text}`).sort()).toEqual([
            "shop-web-1 one-a",
            "shop-web-1 one-b",
            "shop-web-1 one-c",
            "shop-web-2 two-a"
        ]);
        const first = rows.find((row) => row.text === "one-a");
        expect(first?.stamp).toBe("2026-09-10T10:00:01.100000000Z");
        expect(first?.at.toISOString()).toBe("2026-09-10T10:00:01.100Z");
        expect(ports.dispose).toHaveBeenCalled();
    });

    it("falls back to the service's own container when no replica is listed", async () => {
        ports.listContainers.mockResolvedValueOnce([]);
        output.set("shop-web", ["2026-09-10T10:00:01Z only"]);
        await captureRuntimeLogs();
        expect(rows.map((row) => row.container)).toEqual(["shop-web"]);
    });
});

describe("pruning", () => {
    it("removes what is past the retention and what is over the count", async () => {
        const now = new Date("2026-09-10T12:00:00Z");
        rows.push({
            id: "old",
            applicationId: SERVICE,
            container: "shop-web",
            stamp: "2026-09-01T00:00:00.000000000Z",
            at: new Date("2026-09-01T00:00:00Z"),
            text: "a week and more ago"
        });
        // One over the cap, all recent.
        for (let index = 0; index <= RUNTIME_LOG_MAX_LINES; index += 1) {
            const at = new Date(now.getTime() - (RUNTIME_LOG_MAX_LINES - index) * 1000);
            rows.push({
                id: `r${index}`,
                applicationId: SERVICE,
                container: "shop-web",
                stamp: at.toISOString().replace(".000Z", ".000000000Z"),
                at,
                text: `line ${index}`
            });
        }
        expect(await pruneRuntimeLogs(now)).toBe(2);
        expect(rows).toHaveLength(RUNTIME_LOG_MAX_LINES);
        // The oldest of the recent lines went; the newest stayed.
        expect(rows.some((row) => row.text === "line 0")).toBe(false);
        expect(rows.some((row) => row.text === `line ${RUNTIME_LOG_MAX_LINES}`)).toBe(true);
    });
});

describe("paging", () => {
    it("reads back the cursor it hands out, and refuses anything else", () => {
        const id = "0192f6a0-0000-7000-8000-00000000000a";
        const stamp = "2026-09-10T10:00:01.100000000Z";
        expect(decodeCursor(encodeCursor(stamp, id))).toEqual({ stamp, id });
        expect(decodeCursor("nonsense")).toBeNull();
        expect(decodeCursor(`${stamp}|not-an-id`)).toBeNull();
        expect(decodeCursor(`'; drop table|${id}`)).toBeNull();
        expect(decodeCursor(undefined)).toBeNull();
    });
});
